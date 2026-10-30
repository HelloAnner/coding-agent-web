import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isApiRequestAllowed, hasJsonContentType } from "../../lib/request-security";
import { dshWebHost, type DshStream } from "./web-host";
import { record, records } from "./web-projection";

export const DSH_NATIVE_PREFIX = "/api/harnesses/dsh/native/";
const EMBED_PACKAGE = "@coding-agent-web/dsh-embed";
const STATE = Symbol.for("coding-agent-web.dshNativeViews");
type ViewState = { installing: Promise<void> | null; streams: Map<string, DshStream | null>; gate: Promise<unknown> };
function state(): ViewState {
  const shared = globalThis as Record<symbol, ViewState | undefined>;
  return shared[STATE] ??= { installing: null, streams: new Map(), gate: Promise.resolve() };
}

/** Serialize Web-originated admissions; check native activity, not just the currently visible chat. */
export function dshAdmission<T>(management: boolean, operation: () => Promise<T>): Promise<T> {
  const current = state();
  const result = current.gate.then(async () => {
    if (management) await requireDshIdle();
    return operation();
  });
  current.gate = result.catch(() => {});
  return result;
}
export async function requireDshIdle(): Promise<void> {
  const list = await dshWebHost().call<{ items: { sessionId: string; running: boolean; agentAvailable: boolean }[] }>("session/list", { _request: {} });
  if (list.items.some((item) => item.running)) throw new Error("dsh still has running conversations; wait until all tasks finish");
  // ponytail: inspect live agents sequentially; batch this only if profiles routinely hold hundreds of agents.
  for (const item of list.items.filter((item) => item.agentAvailable)) {
    const stream = await dshWebHost().stream("job/list", { request: { sessionId: item.sessionId } });
    const reader = stream.readable.getReader();
    try {
      const first = await reader.read();
      if (!Array.isArray(record(first.value).jobs)) throw new Error("Cannot confirm native dsh background jobs are idle");
      if (records(record(first.value).jobs).some((job) => job.status === "running" || job.status === "stopping")) throw new Error("dsh still has running background jobs; wait before changing its plugins");
    } finally { await reader.cancel(); }
  }
}

export async function ensureDshEmbed(): Promise<void> {
  const current = state();
  if (current.installing) return current.installing;
  const directory = path.resolve(process.cwd(), "harness/dsh/embed");
  if (!existsSync(path.join(directory, "package.json"))) throw new Error("The native dsh embed assets are missing from this application installation");
  await dshWebHost().ready();
  const manifest = JSON.parse(readFileSync(path.join(dshWebHost().profileDir, "package.json"), "utf8"));
  const spec = record(manifest.dependencies)[EMBED_PACKAGE];
  if (typeof spec === "string" && spec.startsWith("link:") && path.resolve(dshWebHost().profileDir, spec.slice(5)) === directory) return;
  current.installing = dshAdmission(true, async () => {
    const result = await dshWebHost().call<{ application: string; error?: { diagnostic?: string } }>("pluginManager/installBundle", { spec: `link:${directory}`, options: { enabled: true } });
    if (result.application !== "applied") throw new Error("Could not activate the application's native dsh view; inspect its profile and pnpm installation");
  }).finally(() => { current.installing = null; });
  return current.installing;
}

/** Only paths owned by the native surface are forwarded, never caller-selected origins. */
export function dshNativeRoute(segments: string[], search: string): string | null {
  if (segments.some((part) => !part || part === "." || part === ".." || /[%/?#\\\x00-\x20]/.test(part))) return null;
  const route = segments.join("/");
  if (route === "plugins") return `/plugins/${search}`;
  if (!route || route === "_stream" || route === "_uplink" || route === "index.html" || route === "favicon.ico" || route === "manifest.webmanifest"
    || route.startsWith("assets/") || route.startsWith("plugins/") || /^api\/[\w$-]+\/[\w$-]+$/.test(route)
    || route === "api/file" || route === "api/upload" || route === "open-in-app/apps") return `/${route}${search}`;
  return null;
}
function guarded(endpoint: string): boolean {
  return /^pluginManager\/(installBundle|removeBundle|setBundleEnabled|setPluginEnabled|setVersionExemption)$/.test(endpoint)
    || /^settings\/(update|replace|mutate)$/.test(endpoint);
}

/** rc.2's official Client supports an injected HTTP stream carrier. This avoids a second public WS server. */
export function dshTransportScript(view: { mode: string; sessionId?: string }): string {
  return `<base href="${DSH_NATIVE_PREFIX}"><script>window.__CODING_AGENT_DSH_VIEW__=${JSON.stringify(view).replace(/</g, "\\u003c")};
window.__DSH_TRANSPORT__={openStream:async function*(endpoint,payload,signal,uplink){
const id=Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
const url='${DSH_NATIVE_PREFIX}_stream';
const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,endpoint,args:payload.args}),signal});
if(!response.ok)throw new Error('Native dsh stream: HTTP '+response.status);
const pump=uplink?(async()=>{try{for await(const value of uplink){const r=await fetch('${DSH_NATIVE_PREFIX}_uplink',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,value}),signal});if(!r.ok)throw new Error('dsh uplink rejected');}await fetch('${DSH_NATIVE_PREFIX}_uplink',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,end:true}),signal});}catch(e){if(!signal.aborted)console.error(e);}})():null;
const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
try{while(true){const read=await reader.read();if(read.done)break;text+=decoder.decode(read.value,{stream:true});let end;while((end=text.indexOf('\\n'))!==-1){const item=JSON.parse(text.slice(0,end));text=text.slice(end+1);if(item.error)throw Object.assign(new Error(item.error.message),item.error);yield item.value;}}}finally{await reader.cancel().catch(()=>{});if(pump)void pump;}
}};</script>`;
}

export async function proxyDshNative(req: Request, segments: string[]): Promise<Response> {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted dsh request" }, { status: 403 });
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") return new Response(null, { status: 405 });
  const url = new URL(req.url);
  const route = dshNativeRoute(segments, url.search);
  if (!route) return Response.json({ error: "Unknown native route" }, { status: 404 });
  try {
    if (segments[0] === "_stream" || segments[0] === "_uplink") return await proxyStream(req, segments[0]);
    if (segments.length === 0 && req.method === "GET") await ensureDshEmbed();
    const endpoint = segments[0] === "api" ? segments.slice(1).join("/") : "";
    let body: string | undefined;
    if (req.method === "POST") {
      if (!hasJsonContentType(req) || !endpoint.includes("/")) return Response.json({ error: "Expected a Remote JSON request" }, { status: 415 });
      body = await req.text();
      if (body.length > 32 * 1024 * 1024) return new Response(null, { status: 413 });
      const envelope = JSON.parse(body);
      if (envelope.type !== "client-request" || envelope.method !== endpoint || typeof envelope.rpcId !== "string" || !record(envelope.payload).args) return Response.json({ error: "Invalid Remote envelope" }, { status: 400 });
    }
    const upstream = await dshAdmission(req.method === "POST" && guarded(endpoint), () => dshWebHost().fetch(route, {
      method: req.method, body,
      headers: req.method === "POST" ? { "content-type": "application/json" } : {}, signal: req.signal,
    }));
    const headers = new Headers();
    for (const name of ["content-type", "content-encoding", "content-security-policy", "x-content-type-options"]) {
      // fetch has already decoded compression.
      if (name === "content-encoding") continue;
      const value = upstream.headers.get(name); if (value) headers.set(name, value);
    }
    headers.set("Cache-Control", "private, no-store");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      return Response.json({ error: "Unexpected dsh redirect" }, { status: 502 });
    }
    if (upstream.ok && segments.length === 0 && req.method === "GET") {
      const mode = ["plugins", "models", "session"].includes(url.searchParams.get("view") ?? "") ? url.searchParams.get("view")! : "plugins";
      const id = url.searchParams.get("session");
      let nativeId: string | undefined;
      if (mode === "session") {
        const resolved = id ? await (await import("./web-session")).dshNativeSessionId(id) : null;
        if (!resolved) return Response.json({ error: "Indexed dsh session required" }, { status: 404 });
        nativeId = resolved;
      }
      const html = await upstream.text();
      return new Response(html.replace("</head>", dshTransportScript({ mode, sessionId: nativeId }) + "</head>"), { headers });
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return Response.json({ error: error instanceof Error ? error.message : "Native dsh request failed" }, { status: 502 });
  }
}

async function proxyStream(req: Request, kind: string): Promise<Response> {
  if (req.method !== "POST" || !hasJsonContentType(req)) return new Response(null, { status: 405 });
  const body = await req.json();
  if (typeof body.id !== "string" || !/^[\w-]{16,100}$/.test(body.id)) return new Response(null, { status: 400 });
  const active = state().streams;
  if (kind === "_uplink") {
    const stream = active.get(body.id);
    if (!stream) return new Response(null, { status: 410 });
    if (body.end === true) stream.end(); else stream.send(body.value);
    return new Response(null, { status: 204 });
  }
  if (active.has(body.id) || active.size >= 128) return new Response(null, { status: 409 });
  active.set(body.id, null); // Reserve before awaiting: duplicate ids and parallel opens count toward the limit.
  let stream: DshStream;
  try {
    stream = await dshWebHost().stream(body.endpoint, record(body.args), req.signal);
    active.set(body.id, stream);
  } catch (error) { active.delete(body.id); throw error; }
  const reader = stream.readable.getReader();
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) { active.delete(body.id); controller.close(); }
        else controller.enqueue(encoder.encode(JSON.stringify({ value }) + "\n"));
      } catch (error) {
        active.delete(body.id);
        controller.enqueue(encoder.encode(JSON.stringify({ error: { message: error instanceof Error ? error.message : "dsh stream disconnected" } }) + "\n"));
        controller.close();
      }
    },
    async cancel() { active.delete(body.id); await reader.cancel(); },
  }), { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}

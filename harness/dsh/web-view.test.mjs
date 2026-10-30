import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const view = await jiti.import("./web-view.ts");

test("native proxy permits its fixed surface, not arbitrary URLs or encoded traversal", async () => {
  assert.equal(view.dshNativeRoute([], "?view=plugins"), "/?view=plugins");
  assert.equal(view.dshNativeRoute(["_stream"], ""), "/_stream");
  assert.equal(view.dshNativeRoute(["api", "pluginManager", "listBundles"], ""), "/api/pluginManager/listBundles");
  for (const parts of [["https:", "evil.example"], ["assets", ".."], ["assets", "%2e%2e"], ["assets", "../secret"], ["api", "file", "etc", "passwd"], ["assets", "a?x=y"], ["connect"]]) {
    assert.equal(view.dshNativeRoute(parts, ""), null);
  }
  const denied = await view.proxyDshNative(new Request("http://127.0.0.1/api/harnesses/dsh/native/", { headers: { host: "127.0.0.1", origin: "https://evil.example" } }), []);
  assert.equal(denied.status, 403);
  const script = view.dshTransportScript({ mode: "plugins" });
  assert.ok(script.includes("openStream"));
  assert.ok(!script.includes("?token="));
  assert.ok(!script.includes("cookie"));
});

test("management admission fails closed for other conversations and background jobs", async () => {
  let running = true, job = "finished", applied = false, malformed = false;
  const key = Symbol.for("coding-agent-web.dshWebHost");
  globalThis[key] = {
    call: async () => ({ items: [{ sessionId: "another-tab", running, agentAvailable: true }] }),
    stream: async () => ({ readable: new ReadableStream({ start(controller) { controller.enqueue(malformed ? {} : { jobs: [{ status: job }] }); } }) }),
  };
  try {
    await assert.rejects(() => view.dshAdmission(true, async () => { applied = true; }), /running conversations/);
    running = false; job = "stopping";
    await assert.rejects(() => view.dshAdmission(true, async () => { applied = true; }), /background jobs/);
    assert.equal(applied, false);
    malformed = true;
    await assert.rejects(() => view.dshAdmission(true, async () => {}), /Cannot confirm/);
    malformed = false; job = "finished";
    await view.dshAdmission(true, async () => { applied = true; });
    assert.equal(applied, true);
  } finally { delete globalThis[key]; }
});

test("parallel stream opens reserve their ids before awaiting the native transport", async () => {
  const key = Symbol.for("coding-agent-web.dshWebHost");
  let release, entered;
  const ready = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let opens = 0;
  globalThis[key] = { stream: async () => { opens++; entered(); await ready; return { readable: new ReadableStream({}) }; } };
  const request = () => new Request("http://127.0.0.1/api/harnesses/dsh/native/_stream", { method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ id: "stream-reservation-check", endpoint: "$events", args: {} }) });
  try {
    const first = view.proxyDshNative(request(), ["_stream"]);
    await started;
    assert.equal((await view.proxyDshNative(request(), ["_stream"])).status, 409);
    assert.equal(opens, 1);
    release();
    const response = await first;
    assert.equal(response.status, 200);
    await response.body.cancel();
  } finally { release(); delete globalThis[key]; }
});

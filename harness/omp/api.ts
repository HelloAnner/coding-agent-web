import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { createAgentEventStream } from "../../lib/agent-event-stream";
import { readCatalogSession } from "../../lib/catalog-db";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "../../lib/file-access";
import { MAX_TOOL_RESULT_IMAGE_BYTES, TOOL_RESULT_IMAGE_MIMES } from "../../lib/tool-result-images";
import { OMP_ID } from "./index";
import { findOmpRun, getOmpRun, type OmpPrompt } from "./runtime";
import { object, OmpError } from "./rpc";

type RouteContext = { params: Promise<{ id: string }> };
function replyError(error: unknown): Response {
  const status = error instanceof OmpError ? error.status : object(error).code === "ENOENT" ? 404 : 500;
  return Response.json({ error: error instanceof OmpError ? error.message : "OMP request failed; its native session may be missing or unreadable" }, { status });
}
function indexed(id: string) {
  if (!OMP_ID.test(id)) throw new OmpError("Invalid OMP session id");
  const row = readCatalogSession(id);
  if (!row || row.harness !== "omp") throw new OmpError("OMP session not found", 404);
  return row;
}
async function promptInput(id: string, body: Record<string, unknown>): Promise<OmpPrompt> {
  const row = readCatalogSession(id);
  if (row && row.harness !== "omp") throw new OmpError("This session belongs to another harness", 409);
  const directory = typeof body.cwd === "string" ? body.cwd : row?.cwd ?? "";
  if (!path.isAbsolute(directory) || !statSync(directory).isDirectory()) throw new OmpError("Select an existing absolute project directory");
  const cwd = realpathSync(directory);
  if (row && realpathSync(row.cwd) !== cwd) throw new OmpError("An OMP session keeps its project directory", 409);
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new OmpError("Select this project in the web app before starting OMP", 403);
  if ((body.provider !== undefined || body.modelId !== undefined) && (typeof body.provider !== "string" || !body.provider || typeof body.modelId !== "string" || !body.modelId)) throw new OmpError("Select a provider and model id together");
  if (body.message !== undefined && typeof body.message !== "string") throw new OmpError("Expected a text message");
  if (typeof body.message === "string" && Buffer.byteLength(body.message) > 1024 * 1024) throw new OmpError("Message exceeds the OMP input limit", 413);
  if (body.streamingBehavior !== undefined && (body.type !== "prompt" || body.streamingBehavior !== "steer" && body.streamingBehavior !== "followUp")) throw new OmpError("Invalid OMP streaming behavior");
  const images: Array<{ data: string; mimeType: string }> = [];
  if (body.images !== undefined) {
    if (!Array.isArray(body.images) || body.images.length > 8) throw new OmpError("Expected at most 8 images");
    for (const raw of body.images) {
      const image = object(raw);
      if (typeof image.data !== "string" || !image.data || typeof image.mimeType !== "string" || !TOOL_RESULT_IMAGE_MIMES.has(image.mimeType)
        || image.data.length > Math.ceil(MAX_TOOL_RESULT_IMAGE_BYTES * 4 / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new OmpError("Invalid image attachment");
      images.push({ data: image.data, mimeType: image.mimeType });
    }
  }
  if (body.type === "prompt" && Buffer.byteLength(JSON.stringify({ type: "prompt", id: "00000000-0000-0000-0000-000000000000", message: body.message ?? "", images: images.map((image) => ({ type: "image", ...image })) })) + 1 > 1024 * 1024) throw new OmpError("OMP input exceeds 1 MiB; compress attachments or shorten the message", 413);
  const requestId = typeof body.requestId === "string" && /^[\w-]{8,100}$/.test(body.requestId) ? body.requestId : undefined;
  if (body.requestId !== undefined && !requestId) throw new OmpError("Invalid OMP request id");
  return { id, cwd, message: typeof body.message === "string" ? body.message : undefined, images, requestId,
    provider: typeof body.provider === "string" ? body.provider : undefined,
    modelId: typeof body.modelId === "string" ? body.modelId : undefined,
    streamingBehavior: body.streamingBehavior as OmpPrompt["streamingBehavior"],
    thinkingLevel: typeof body.thinkingLevel === "string" ? body.thinkingLevel : undefined,
  };
}
export async function POST(req: Request, { params }: RouteContext): Promise<Response> {
  try {
    const { id } = await params;
    if (!OMP_ID.test(id)) throw new OmpError("Invalid OMP session id");
    const parsed: unknown = await req.json().catch(() => null);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new OmpError("Expected JSON object");
    const body = object(parsed);
    if (body.type === "ensure_session" || body.type === "prompt") {
      const input = await promptInput(id, body);
      const run = getOmpRun(id);
      const data = body.type === "ensure_session" ? await run.ensure(input) : await run.prompt(input);
      return Response.json({ success: true, data });
    }
    const run = findOmpRun(id);
    if (body.type === "abort") {
      // A startup holds a run before its native file/index is ready.
      if (!run) indexed(id);
      return Response.json({ success: true, data: { aborted: run?.abort() ?? false } });
    }
    indexed(id);
    if (body.type === "clear_queue") return Response.json({ success: true, data: run?.clearQueue() ?? { steering: [], followUp: [] } });
    if (body.type === "get_state") {
      await run?.refreshState();
      return Response.json({ success: true, data: run?.state().state ?? { isStreaming: false } });
    }
    if (body.type === "extension_ui_response") {
      if (!run || typeof body.id !== "string") throw new OmpError("OMP input request is no longer pending", 409);
      run.respond(body.id, body);
      return Response.json({ success: true });
    }
    if (body.type === "set_model") {
      if (typeof body.provider !== "string" || typeof body.modelId !== "string" || !body.provider || !body.modelId) throw new OmpError("Expected a provider and model id");
      await promptInput(id, body);
      return Response.json({ success: true, data: await getOmpRun(id).setModel(body.provider, body.modelId) });
    }
    if (body.type === "set_thinking_level") {
      if (typeof body.level !== "string") throw new OmpError("Expected a thinking level");
      await promptInput(id, body);
      return Response.json({ success: true, data: await getOmpRun(id).setThinking(body.level) });
    }
    throw new OmpError("Unsupported OMP command");
  } catch (error) { return replyError(error); }
}
export async function GET(req: Request, { params }: RouteContext): Promise<Response> {
  try {
    const { id } = await params;
    indexed(id);
    const run = findOmpRun(id);
    await run?.refreshState();
    if (new URL(req.url).searchParams.has("state")) return Response.json(run?.state() ?? { running: false, state: { isStreaming: false } }, { headers: { "Cache-Control": "no-store" } });
    return Response.json(getOmpRun(id).view(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return replyError(error); }
}
export async function events(req: Request, { params }: RouteContext): Promise<Response> {
  try {
    const { id } = await params;
    indexed(id);
    if (req.signal.aborted) return new Response(null, { status: 204 });
    const run = getOmpRun(id);
    run.view();
    return new Response(createAgentEventStream(req, id, Promise.resolve(run)), { headers: {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no",
    } });
  } catch (error) { return replyError(error); }
}

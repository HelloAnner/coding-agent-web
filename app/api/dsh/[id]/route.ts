import path from "node:path";
import { NextResponse } from "next/server";
import { dshSessionsRoot } from "@/harness/dsh";
import { abortDshPrompt, clearDshQueue, dshState, isDshRunning, sendDshPrompt, readDshWebTranscript, dshInteractions, answerDshInteraction, type DshStreamingBehavior } from "@/harness/dsh/web-session";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** ACP image blocks, base64 without a prefix. Same limits as the kernel's decoder. */
function readImages(raw: unknown): Array<{ data: string; mimeType: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const images: Array<{ data: string; mimeType: string }> = [];
  let total = 0;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const value = item as { data?: unknown; mimeType?: unknown };
    if (typeof value.data !== "string" || typeof value.mimeType !== "string") continue;
    if (!value.data) continue;
    if (!IMAGE_TYPES.has(value.mimeType)) throw new Error(`Unsupported image type: ${value.mimeType}`);
    total += value.data.length;
    if (total > MAX_IMAGE_BYTES) throw new Error("Images are too large");
    images.push({ data: value.data, mimeType: value.mimeType });
  }
  return images.length > 0 ? images : undefined;
}

/**
 * POST /api/dsh/[id] - one command for a dsh chat.
 *
 *   { type: "prompt", message, cwd, provider?, model?, sessionPath?, streamingBehavior? }
 *   { type: "abort" }
 *   { type: "clear_queue" }
 *   { type: "get_state" }
 *
 * The reply itself does not come back here: it streams on /events.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });

  if (body.streamingBehavior !== undefined && body.streamingBehavior !== "steer" && body.streamingBehavior !== "followUp") return NextResponse.json({ error: "Invalid streaming behavior" }, { status: 400 });
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Expected application/json" }, { status: 415 });

  switch (body.type) {
    case "prompt": {
      const message = typeof body.message === "string" ? body.message : "";
      const cwd = typeof body.cwd === "string" ? body.cwd : "";
      const provider = typeof body.provider === "string" ? body.provider : undefined;
      const model = typeof body.model === "string" ? body.model : undefined;
      const sessionPath = typeof body.sessionPath === "string" ? body.sessionPath : undefined;
      if (body.streamingBehavior !== undefined && body.streamingBehavior !== "steer" && body.streamingBehavior !== "followUp") return NextResponse.json({ error: "Invalid streaming behavior" }, { status: 400 });
      const streamingBehavior = body.streamingBehavior as DshStreamingBehavior | undefined;
      let images: Array<{ data: string; mimeType: string }> | undefined;
      try {
        images = readImages(body.images);
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        );
      }
      if (!message.trim() && !images) return NextResponse.json({ error: "Message is empty" }, { status: 400 });
      if (!cwd || !path.isAbsolute(cwd)) {
        return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
      }
      if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) return NextResponse.json({ error: "Access denied" }, { status: 403 });
      try {
        const result = await sendDshPrompt({ sessionId: id, cwd, text: message, images, provider, model, sessionPath }, streamingBehavior);
        return NextResponse.json({
          success: true,
          data: { sessionId: id, sessionPath: result.sessionPath, accepted: true, queued: result.queued === true },
        });
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    }
    case "abort": {
      return NextResponse.json({ success: true, data: { aborted: await abortDshPrompt(id) } });
    }
    case "clear_queue": {
      return NextResponse.json({ success: true, data: await clearDshQueue(id) });
    }
    case "answer_interaction": {
      if (typeof body.eventId !== "string") return NextResponse.json({ error: "eventId required" }, { status: 400 });
      try { await answerDshInteraction(id, body.eventId, body.value); return NextResponse.json({ success: true }); }
      catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Interaction failed" }, { status: 409 }); }
    }
    case "get_state": {
      return NextResponse.json({ success: true, data: dshState(id) });
    }
    default:
      return NextResponse.json({ error: `Unknown command: ${String(body.type)}` }, { status: 400 });
  }
}

/** Only the kernel's own session directories may be read. */
function insideSessionsRoot(candidate: string): boolean {
  const root = path.resolve(dshSessionsRoot());
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * GET /api/dsh/[id]?path=<session dir> - the transcript, in the shape the chat
 * loads for a pi session. dsh has no branches, so the tree is a single path.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted request" }, { status: 403 });
  const search = new URL(req.url).searchParams;
  if (search.get("interactions") === "1") return NextResponse.json({ interactions: dshInteractions(id) }, { headers: { "Cache-Control": "no-store" } });
  if (search.get("state") === "1") return NextResponse.json({ running: isDshRunning(id), state: dshState(id) }, { headers: { "Cache-Control": "no-store" } });
  const sessionPath = search.get("path") ?? "";
  if (!sessionPath || !path.isAbsolute(sessionPath) || !insideSessionsRoot(sessionPath)) {
    return NextResponse.json({ error: "path must be a dsh session directory" }, { status: 400 });
  }

  let transcript: Awaited<ReturnType<typeof readDshWebTranscript>>;
  try { transcript = await readDshWebTranscript(id); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "dsh history unavailable" }, { status: 404 }); }

  return NextResponse.json({
    sessionId: id,
    filePath: sessionPath,
    totalActiveMs: 0,
    tree: [],
    leafId: null,
    context: {
      messages: transcript.messages,
      entryIds: transcript.entryIds,
      oldestEntryId: null,
      hasMore: transcript.hasMore,
      turnsBefore: 0,
      thinkingLevel: "off",
      model: transcript.model,
    },
  });
}

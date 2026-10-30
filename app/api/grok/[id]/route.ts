import path from "node:path";
import { NextResponse } from "next/server";
import { MAX_TOOL_RESULT_IMAGE_BYTES, TOOL_RESULT_IMAGE_MIMES } from "@/lib/tool-result-images";
import {
  abortGrokPrompt,
  clearGrokQueue,
  grokSessionFile,
  grokState,
  isGrokRunning,
  sendGrokPrompt,
} from "@/harness/grok/runtime";
import { readGrokTranscript } from "@/harness/grok/transcript";

export const dynamic = "force-dynamic";

/** Attached images, base64 without a prefix. Same limits as the other harnesses. */
function readImages(raw: unknown): Array<{ data: string; mimeType: string }> {
  if (!Array.isArray(raw)) return [];
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const item of raw.slice(0, 8)) {
    const image = item as { data?: unknown; mimeType?: unknown } | null;
    if (!image || typeof image.data !== "string" || typeof image.mimeType !== "string") continue;
    if (!TOOL_RESULT_IMAGE_MIMES.has(image.mimeType)) throw new Error(`Unsupported image type: ${image.mimeType}`);
    if (image.data.length > Math.ceil(MAX_TOOL_RESULT_IMAGE_BYTES * 4 / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new Error("Invalid image attachment");
    images.push({ data: image.data, mimeType: image.mimeType });
  }
  return images;
}

/**
 * POST /api/grok/[id] - one command for a grok session.
 *
 *   { type: "prompt", message, cwd, model?, images?, streamingBehavior? }
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

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  }

  switch (body.type) {
    case "prompt": {
      const message = typeof body.message === "string" ? body.message : "";
      const cwd = typeof body.cwd === "string" ? body.cwd : "";
      const model = typeof body.model === "string" ? body.model : undefined;
      const streamingBehavior = body.streamingBehavior;
      if (streamingBehavior !== undefined && streamingBehavior !== "steer" && streamingBehavior !== "followUp") {
        return NextResponse.json({ error: "Invalid streaming behavior" }, { status: 400 });
      }
      if (!cwd || !path.isAbsolute(cwd)) {
        return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
      }
      let images: Array<{ data: string; mimeType: string }>;
      try {
        images = readImages(body.images);
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        );
      }
      if (!message.trim() && images.length === 0) return NextResponse.json({ error: "Message is empty" }, { status: 400 });
      try {
        const result = await sendGrokPrompt({ sessionId: id, cwd, text: message, model, images }, streamingBehavior);
        return NextResponse.json({
          success: true,
          data: { sessionId: id, sessionFile: grokSessionFile(cwd, id), accepted: true, queued: result.queued },
        });
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    }
    case "abort": {
      return NextResponse.json({ success: true, data: { aborted: abortGrokPrompt(id) } });
    }
    case "clear_queue": {
      return NextResponse.json({ success: true, data: clearGrokQueue(id) });
    }
    case "get_state": {
      return NextResponse.json({ success: true, data: grokState(id) });
    }
    default:
      return NextResponse.json({ error: `Unknown command: ${String(body.type)}` }, { status: 400 });
  }
}

/**
 * GET /api/grok/[id]?cwd=<folder> - the transcript, in the shape the chat loads
 * for a pi session. Grok has no branches, so the tree is a single path.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const search = new URL(req.url).searchParams;
  if (search.get("state") === "1") {
    return NextResponse.json({ running: isGrokRunning(id), state: grokState(id) }, { headers: { "Cache-Control": "no-store" } });
  }
  const cwd = search.get("cwd") ?? "";
  if (!cwd || !path.isAbsolute(cwd)) {
    return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
  }

  const transcript = readGrokTranscript(cwd, id);
  if (!transcript.exists) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json({
    sessionId: id,
    filePath: transcript.path ?? "",
    totalActiveMs: 0,
    tree: [],
    leafId: null,
    context: {
      messages: transcript.messages,
      entryIds: transcript.messages.map((_, index) => `${id}:${index}`),
      oldestEntryId: null,
      hasMore: false,
      turnsBefore: 0,
      thinkingLevel: "off",
      model: transcript.model ? { provider: "grok", modelId: transcript.model } : null,
    },
  });
}

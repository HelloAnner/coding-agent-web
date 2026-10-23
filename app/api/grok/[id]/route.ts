import path from "node:path";
import { NextResponse } from "next/server";
import {
  abortGrokPrompt,
  grokSessionFile,
  isGrokRunning,
  sendGrokPrompt,
} from "@/harness/grok/runtime";
import { readGrokTranscript } from "@/harness/grok/transcript";

export const dynamic = "force-dynamic";

/**
 * POST /api/grok/[id] - one command for a grok session.
 *
 *   { type: "prompt", message, cwd, model? }
 *   { type: "abort" }
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

  switch (body.type) {
    case "prompt": {
      const message = typeof body.message === "string" ? body.message : "";
      const cwd = typeof body.cwd === "string" ? body.cwd : "";
      const model = typeof body.model === "string" ? body.model : undefined;
      if (!message.trim()) return NextResponse.json({ error: "Message is empty" }, { status: 400 });
      if (!cwd || !path.isAbsolute(cwd)) {
        return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
      }
      try {
        await sendGrokPrompt({ sessionId: id, cwd, text: message, model });
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
      return NextResponse.json({
        success: true,
        data: { sessionId: id, sessionFile: grokSessionFile(cwd, id), accepted: true },
      });
    }
    case "abort": {
      return NextResponse.json({ success: true, data: { aborted: abortGrokPrompt(id) } });
    }
    case "get_state": {
      return NextResponse.json({ success: true, data: { isStreaming: isGrokRunning(id) } });
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
  const cwd = new URL(req.url).searchParams.get("cwd") ?? "";
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

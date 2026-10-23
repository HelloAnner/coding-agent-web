import path from "node:path";
import { NextResponse } from "next/server";
import { dshSessionsRoot } from "@/harness/dsh";
import { abortDshPrompt, isDshRunning, sendDshPrompt } from "@/harness/dsh/runtime";
import { readDshTranscript } from "@/harness/dsh/transcript";

export const dynamic = "force-dynamic";

/**
 * POST /api/dsh/[id] - one command for a dsh chat.
 *
 *   { type: "prompt", message, cwd, provider?, model?, sessionPath? }
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
      const provider = typeof body.provider === "string" ? body.provider : undefined;
      const model = typeof body.model === "string" ? body.model : undefined;
      const sessionPath = typeof body.sessionPath === "string" ? body.sessionPath : undefined;
      if (!message.trim()) return NextResponse.json({ error: "Message is empty" }, { status: 400 });
      if (!cwd || !path.isAbsolute(cwd)) {
        return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
      }
      try {
        const result = await sendDshPrompt({ sessionId: id, cwd, text: message, provider, model, sessionPath });
        return NextResponse.json({
          success: true,
          data: { sessionId: id, sessionPath: result.sessionPath, accepted: true },
        });
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    }
    case "abort": {
      return NextResponse.json({ success: true, data: { aborted: abortDshPrompt(id) } });
    }
    case "get_state": {
      return NextResponse.json({ success: true, data: { isStreaming: isDshRunning(id) } });
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
  const sessionPath = new URL(req.url).searchParams.get("path") ?? "";
  if (!sessionPath || !path.isAbsolute(sessionPath) || !insideSessionsRoot(sessionPath)) {
    return NextResponse.json({ error: "path must be a dsh session directory" }, { status: 400 });
  }

  const transcript = readDshTranscript(sessionPath);
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
      model: transcript.model ? { provider: "dsh", modelId: transcript.model } : null,
    },
  });
}

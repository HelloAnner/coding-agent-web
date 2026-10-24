import { createAgentEventStream } from "@/lib/agent-event-stream";
import { getClaudeRun } from "@/harness/claude-code/runtime";
import { CLAUDE_UUID } from "@/harness/claude-code/transcript";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!CLAUDE_UUID.test(id)) return Response.json({ error: "Invalid Claude Code session id" }, { status: 400 });
  if (req.signal.aborted) return new Response(null, { status: 204 });
  return new Response(createAgentEventStream(req, id, Promise.resolve(getClaudeRun(id))), {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}

import { createAgentEventStream } from "@/lib/agent-event-stream";
import { getDshSession } from "@/harness/dsh/runtime";

export const dynamic = "force-dynamic";

/**
 * GET /api/dsh/[id]/events - SSE stream of one dsh chat.
 *
 * Same wire as the pi stream (the chat already renders it): the runtime
 * publishes `agent_start`, message deltas, tool executions and `agent_settled`,
 * and a reconnecting tab gets the events of the run still in flight.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  const run = getDshSession(id);
  const stream = createAgentEventStream(req, id, Promise.resolve(run));

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

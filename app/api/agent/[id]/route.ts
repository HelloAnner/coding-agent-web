import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession, setRpcSessionTools } from "@/lib/rpc-manager";
import { recordIntake, markIntakeHanded, closeIntake, settleSessionIntake, type IntakeKind } from "@/lib/prompt-intake";

const INTAKE_KINDS: Record<string, IntakeKind> = { prompt: "prompt", steer: "steer", follow_up: "followUp" };

// A slash command or a `!` shell line runs inside the harness and never returns
// as a user message, so replaying one after a crash would run it twice.
function intakeKind(type: string, message: unknown): IntakeKind | null {
  const kind = INTAKE_KINDS[type];
  if (!kind) return null;
  const text = typeof message === "string" ? message.trim() : "";
  if (text.startsWith("/") || text.startsWith("!")) return null;
  return kind;
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;
  let intakeId: string | null = null;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined
      && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error("toolNames must be an array of strings");
    }
    const toolNames = requestedToolNames as string[] | undefined;

    // The journal row lands before the harness sees the prompt, so a crash
    // between the two leaves something to resume at boot.
    const kind = intakeKind(commandType ?? "", body.message);
    if (kind) {
      intakeId = recordIntake({
        sessionId: id,
        kind,
        text: body.message as string,
        images: body.images as { data: string; mimeType: string }[] | undefined,
      })?.id ?? null;
    }

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (body.type === "set_tools") {
      const filePath = existing?.sessionFile || await resolveSessionPath(id) || undefined;
      if (!existing?.isAlive() && !filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const changed = await setRpcSessionTools(id, filePath, toolNames);
      return NextResponse.json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated },
      });
    }
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      if (intakeId) markIntakeHanded(intakeId);
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    const { session } = await startRpcSession(id, filePath, undefined, {
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";
    if (intakeId) markIntakeHanded(intakeId);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    // The harness refused it: no run, nothing to resume, draft stays in the page.
    if (intakeId) closeIntake(intakeId);
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      // Nothing is running here, so anything still open in the journal either
      // arrived (its text is in the session file) or never will.
      await settleSessionIntake(id).catch(() => 0);
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" }) as Record<string, unknown>;
    // A finished turn means any journal row it delivered is on disk now.
    if (!session.isRunning()) await settleSessionIntake(id).catch(() => 0);
    // Status reads leave out the system prompt, most of the reply (agentStatusUrl()).
    if (new URL(req.url).searchParams.get("systemPrompt") === "0") delete state.systemPrompt;
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

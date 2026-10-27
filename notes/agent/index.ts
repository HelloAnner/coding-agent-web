import type { NotesAgentEvent, NotesAgentState } from "../types";
import { getNotesAgent, listNotesSkills, peekNotesAgent, resetNotesAgent } from "./runtime";
import { NOTES_TASK_CONCURRENCY, NotesTaskError, listNotesTasks, runNotesTaskNow } from "./scheduler";
import { BOARD_FONT_OPTIONS, publicNotesSettings, readNotesSettings, updateNotesSettings } from "./settings";

/**
 * /api/notes/agent and /api/notes/settings: the notes agent's two endpoints.
 * The prompt answer is NDJSON, one event per line, because a fetch POST cannot
 * be an EventSource.
 */

/** GET /api/notes/agent */
export async function getNotesAgentState(): Promise<Response> {
  const agent = peekNotesAgent();
  const settings = readNotesSettings();
  const state: NotesAgentState = {
    messages: agent?.messages ?? [],
    busy: agent?.isBusy ?? false,
    model: agent?.modelLabel ?? (settings.agent.model ? `notes/${settings.agent.model}` : null),
    skills: listNotesSkills(),
  };
  return Response.json(state);
}

/** POST /api/notes/agent { message } */
export async function promptNotesAgent(request: Request): Promise<Response> {
  let message = "";
  try {
    const body = await request.json() as { message?: unknown };
    message = typeof body.message === "string" ? body.message.trim() : "";
  } catch {
    return Response.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (!message) return Response.json({ error: "缺少 message" }, { status: 400 });

  const existing = peekNotesAgent();
  if (existing?.isBusy) return Response.json({ error: "上一条消息还在处理中" }, { status: 409 });

  let agent;
  try {
    agent = await getNotesAgent();
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "笔记 agent 启动失败" }, { status: 500 });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe = () => {};
  const close = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    unsubscribe();
    try {
      controller.close();
    } catch {
      // Already closed by the client going away.
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: NotesAgentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          close(controller);
        }
      };
      unsubscribe = agent.onEvent(send);
      request.signal?.addEventListener("abort", () => close(controller), { once: true });
      // The run continues if the browser closes the stream: its result is
      // already in the transcript, and the panel finds it on the next GET.
      void agent.prompt(message).finally(() => close(controller));
    },
    cancel() {
      closed = true;
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

/** DELETE /api/notes/agent: stop the running turn. */
export async function abortNotesAgent(): Promise<Response> {
  const agent = peekNotesAgent();
  if (!agent) return Response.json({ ok: true });
  await agent.abort();
  return Response.json({ ok: true });
}

/** GET /api/notes/settings: the settings (API key masked), the fonts, the skills. */
export async function getNotesSettings(): Promise<Response> {
  return Response.json({
    ...publicNotesSettings(readNotesSettings()),
    fonts: BOARD_FONT_OPTIONS,
    skills: listNotesSkills(),
  });
}

/** PUT /api/notes/settings: merge the dialog's fields into the stored settings. */
export async function saveNotesSettings(request: Request): Promise<Response> {
  let patch: unknown;
  try {
    patch = await request.json();
  } catch {
    return Response.json({ error: "请求格式错误" }, { status: 400 });
  }
  const before = readNotesSettings();
  const settings = updateNotesSettings(patch);
  // A changed model needs a new pi session; a board font change is picked up by
  // the whiteboard without touching the conversation.
  if (JSON.stringify(before.agent) !== JSON.stringify(settings.agent)) {
    await resetNotesAgent({ clearHistory: true });
  }
  return Response.json({ ...publicNotesSettings(settings), skills: listNotesSkills() });
}

/** GET /api/notes/tasks: the scheduled pool and where each task stands. */
export async function getNotesTasks(): Promise<Response> {
  return Response.json({ tasks: listNotesTasks(), concurrency: NOTES_TASK_CONCURRENCY });
}

/** POST /api/notes/tasks { id }: run one task now. */
export async function runNotesTask(request: Request): Promise<Response> {
  let id = "";
  try {
    const body = await request.json() as { id?: unknown };
    id = typeof body.id === "string" ? body.id.trim() : "";
  } catch {
    return Response.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (!id) return Response.json({ error: "缺少 id" }, { status: 400 });
  try {
    return Response.json({ task: runNotesTaskNow(id) });
  } catch (error) {
    const status = error instanceof NotesTaskError ? error.status : 500;
    return Response.json({ error: error instanceof Error ? error.message : "任务启动失败" }, { status });
  }
}

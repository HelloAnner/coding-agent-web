import { createNotesSession } from "./profile";
import { readCodingSession } from "../ingest";
import { BOARD_EXTENSION, NotesError, readItem } from "../files";

/**
 * The "file this conversation" button on the Coding page. One click opens a
 * dialog: the user writes what this run must focus on, and the agent appends
 * only that to the whiteboard already open in the right panel.
 *
 * Nothing else is possible by construction: the run gets one tool, pinned to
 * that one board, and the tool refuses replace, new boards and other paths.
 * The prompt is the user's focus plus the two drawing skills — no room for the
 * model to decide what the conversation is about.
 */

/** The whole run; a hung pass is aborted here. */
const RUN_BUDGET_MS = 6 * 60_000;

export function sessionDigestPrompt(boardPath: string, focus: string): string {
  return `把一条 Coding 对话里跟下面「重点」有关的部分，补进白板 ${boardPath}。

用户这次只关心这些，他说了算：
<重点>
${focus.trim()}
</重点>

## 只做这些

1. notes_board action=read ${boardPath}，看板上已有的元素、坐标和留白，找空位。
2. 只从对话里挑跟「重点」直接相关、板上还没有的事实，按 whiteboard-style / whiteboard-drawing 画上去。
3. 只能追加：replace 一律 false。已有元素一个都不许删、不许挪、不许改名、不许重画。
4. 只写 ${boardPath} 这一块板。不许新建白板或目录，不许改名、移动、删除任何东西。
5. 「重点」没提到的内容一律不画，哪怕你觉得重要。重点在对话里没有对应事实、板上已经画过、这次没有新东西可加，就一个字都不写，直接说为什么。

做完用两三句话说：加了什么；或者为什么没加。`;
}

export interface SessionDigestResult {
  /** What the agent said last: what it added, or why it added nothing. */
  message: string;
  /** The board it was allowed to write. */
  board: string;
}

declare global {
  // Dev reloads must not let the same conversation run twice at once.
  var __piWebSessionDigestRunning: Set<string> | undefined;
}

/** One session -> one existing board. Throws when it is already running or has no transcript. */
export async function digestSession(
  sessionId: string,
  options: { boardPath: string; focus: string },
): Promise<SessionDigestResult> {
  const boardPath = options.boardPath.trim().replace(/^\/+/, "");
  const focus = options.focus.trim();
  if (!boardPath.toLowerCase().endsWith(BOARD_EXTENSION)) throw new NotesError("先在右侧打开一块白板，再存入笔记", 400);
  if (!focus) throw new NotesError("先写下这次要重点关注什么", 400);
  const board = await readItem(boardPath).catch((error: unknown) => {
    if (error instanceof NotesError && error.status === 404) return null;
    throw error;
  });
  if (!board) throw new NotesError(`白板 ${boardPath} 不存在，先在右侧打开一块已有的白板`, 404);

  const running = (globalThis.__piWebSessionDigestRunning ??= new Set<string>());
  if (running.has(sessionId)) throw new Error("这条对话正在写入笔记，等它跑完");
  running.add(sessionId);
  try {
    const transcript = await readCodingSession(sessionId);
    if (!transcript) throw new Error("找不到这条对话的正文，会话文件可能已经不在了");

    const { session } = await createNotesSession({
      systemPrompt: sessionDigestPrompt(boardPath, focus),
      skills: ["whiteboard-style", "whiteboard-drawing"],
      tools: ["notes_board"],
      appendTo: boardPath,
    });
    let text = "";
    const unsubscribe = session.subscribe((event) => {
      const delta = (event as { assistantMessageEvent?: { type?: string; delta?: unknown } }).assistantMessageEvent;
      if (delta?.type === "text_delta" && typeof delta.delta === "string") text += delta.delta;
    });
    const timer = setTimeout(() => {
      void session.abort();
    }, RUN_BUDGET_MS);
    try {
      await session.prompt(`<对话>\n${transcript}\n</对话>`);
    } finally {
      clearTimeout(timer);
      unsubscribe();
      session.dispose();
    }
    return { message: text.trim() || "已处理完，没有可汇报的内容", board: boardPath };
  } finally {
    running.delete(sessionId);
  }
}

/** POST /api/notes/digest { sessionId, boardPath, focus } */
export async function digestSessionRequest(request: Request): Promise<Response> {
  let sessionId = "";
  let boardPath = "";
  let focus = "";
  try {
    const body = await request.json() as { sessionId?: unknown; boardPath?: unknown; focus?: unknown };
    sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    boardPath = typeof body.boardPath === "string" ? body.boardPath.trim() : "";
    focus = typeof body.focus === "string" ? body.focus.trim() : "";
  } catch {
    return Response.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (!sessionId) return Response.json({ error: "缺少 sessionId" }, { status: 400 });
  try {
    return Response.json(await digestSession(sessionId, { boardPath, focus }));
  } catch (error) {
    const status = error instanceof NotesError ? error.status : 409;
    return Response.json(
      { error: error instanceof Error ? error.message : "写入笔记失败" },
      { status },
    );
  }
}

import { createNotesSession } from "./profile";
import { readCodingSession } from "../ingest";
import { BOARD_EXTENSION, NotesError, readItem } from "../files";

/**
 * The "file this conversation" button on the Coding page. One click opens a
 * dialog: the user writes what this run must do, and the agent does it on the
 * whiteboard already open in the right panel.
 *
 * The user's sentence is the instruction; the only thing the run cannot do is
 * leave that board. The tool is pinned to it, so no new board and no other
 * file can be touched whatever the model decides.
 */

/** The whole run; a hung pass is aborted here. */
const RUN_BUDGET_MS = 6 * 60_000;

export function sessionDigestPrompt(boardPath: string, focus: string): string {
  return `你要在白板 ${boardPath} 上做事。这是用户此刻打开的那块板，也是你唯一能写的地方。

下面是用户的原话，就是这次的指令。它优先级最高，压过下面的默认做法，也压过你自己对这条对话的判断：
<指令>
${focus.trim()}
</指令>

## 边界

- 只写 ${boardPath}。不许新建白板或目录，不许改名、移动、删除任何东西，别的文件一个字都不写。
- 这块板里怎么改全听上面那句：要删就删、要改就改、要整块重画就用 replace=true；用户没让动的地方保持原样。
- 指令里没提的内容不要自己加，哪怕你觉得重要。指令在这条对话里找不到依据、或者做不了，就什么都不写，直接说为什么。

## 怎么做

- 先 notes_board action=read ${boardPath}，看现有元素、坐标和留白，不要凭记忆。
- replace=true 重画时，把用户手改过的文字、坐标和要保留的旧元素一起重画进去。
- 画之前先读 skill whiteboard-style 和 whiteboard-drawing。

做完用两三句话说：改了什么；或者为什么没改。`;
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
      onlyBoard: boardPath,
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

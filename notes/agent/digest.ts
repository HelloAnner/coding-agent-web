import { createNotesSession } from "./profile";
import { readCodingSession } from "../ingest";

/**
 * The "file this conversation" button on the Coding page. One click builds a
 * fresh notes session, hands it the current transcript, and lets it merge the
 * result into an existing board — or skip when no existing folder fits.
 *
 * There is no schedule: the only trigger is the button, one session at a time.
 */

export const SESSION_DIGEST_PROMPT = `你在把一条 Coding 对话沉淀成白板，写进这个人的笔记库。

**只画白板。** 不能新建笔记，不能新建目录，不能改名、移动、删除任何东西。唯一允许的写入：在**已经存在的目录**里新建或重画一块 .excalidraw。

步骤：
1. 先用 notes_ls 看目录树（带用户的手动标记），按对话内容判断它属于哪个已有的目录。看内容，不看 cwd，也不看项目名。
2. 只有一个目录明显合适才画。那个目录里已经有讲同一子主题的白板，就先 notes_board action=read 读它，再 replace=true 把新内容并进去；没有就新建一块，名字写子主题（优雅发布、流量拓扑），不写目录名，不加「白板」「笔记」后缀。
3. 没有明显合适的目录就跳过：不要新建目录，不要硬塞。收尾直接说「没有合适的位置，跳过」，并说这条对话大概属于什么主题。
4. 用户手动的操作优先级最高：notes_ls 里标了「用户手动删除」的路径不要重建；标了手动改名/移动的白板不要动它的名字和位置，内容可以更新。
5. 白板不是文档：留结论、决定和原因、接口与数据结构、踩过的坑、跑得通的命令；寒暄、失败尝试、日志堆砌不要。关系、流程、层级、对比画成形状和箭头；一条 text 最多两行、24 字，一张图最多 6 条。
6. 一张白板只说一件事，3~8 个节点。画之前先读 skill whiteboard-style，再按 whiteboard-drawing 调 notes_board。

做完用两三句话说：画或改了哪块白板、里面是什么；或者为什么跳过、适合放到什么主题。`;

export interface SessionDigestResult {
  /** What the agent最后说的一段话：写了哪块板，或者为什么跳过。 */
  message: string;
}

declare global {
  // Dev reloads must not let the same conversation run twice at once.
  var __piWebSessionDigestRunning: Set<string> | undefined;
}

/** One session -> notes. Throws when it is already running or has no transcript. */
export async function digestSession(sessionId: string): Promise<SessionDigestResult> {
  const running = (globalThis.__piWebSessionDigestRunning ??= new Set<string>());
  if (running.has(sessionId)) throw new Error("这条对话正在写入笔记，等它跑完");
  running.add(sessionId);
  try {
    const transcript = await readCodingSession(sessionId);
    if (!transcript) throw new Error("找不到这条对话的正文，会话文件可能已经不在了");

    const { session } = await createNotesSession({
      systemPrompt: SESSION_DIGEST_PROMPT,
      skills: ["whiteboard-style", "whiteboard-drawing"],
      tools: ["read", "notes_ls", "notes_board"],
    });
    let text = "";
    const unsubscribe = session.subscribe((event) => {
      const delta = (event as { assistantMessageEvent?: { type?: string; delta?: unknown } }).assistantMessageEvent;
      if (delta?.type === "text_delta" && typeof delta.delta === "string") text += delta.delta;
    });
    const timer = setTimeout(() => {
      void session.abort();
    }, 5 * 60_000);
    try {
      await session.prompt(`把下面这条 Coding 对话整理进笔记库。\n\n<对话>\n${transcript}\n</对话>`);
    } finally {
      clearTimeout(timer);
      unsubscribe();
      session.dispose();
    }
    return { message: text.trim() || "已处理完，没有可汇报的内容" };
  } finally {
    running.delete(sessionId);
  }
}

/** POST /api/notes/digest { sessionId } */
export async function digestSessionRequest(request: Request): Promise<Response> {
  let sessionId = "";
  try {
    const body = await request.json() as { sessionId?: unknown };
    sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  } catch {
    return Response.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (!sessionId) return Response.json({ error: "缺少 sessionId" }, { status: 400 });
  try {
    return Response.json(await digestSession(sessionId));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "写入笔记失败" },
      { status: 409 },
    );
  }
}

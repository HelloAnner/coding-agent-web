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

**只画白板。** 不能新建笔记，不能新建目录，不能改名、移动、删除任何东西。唯一允许的写入：在**已经存在的目录**里新建或重画 .excalidraw。

## 先看，再判断，最后才画

1. 先把对话读成一份**关系清单**：把用户和自己讲清的主语—关系—宾语抄出来（A 决定 B、A 依赖 B、A 拦不住 B、选了 A 没选 B、先 A 再 B）。**用户自己提出、反复追问、拍板的那几条排最前面**——那就是这次对话的重点，也是这块板要讲的东西。清单是检查表，不用画上去。
2. 先用 notes_ls 看目录树（带用户的手动标记），按对话内容判断它属于哪个已有的目录。看内容，不看 cwd，也不看项目名。
3. 把那个目录里可能同主题的白板**全部** notes_board action=read 读一遍——同一件事可能被画在两三块板上。没有一块像、而且确实是新主题，才新建一块，名字写子主题（优雅发布、流量拓扑），不写目录名，不加「白板」「笔记」后缀。
4. 拿读到的元素逐条跟对话对账，先想清楚这张板怎么变：
   - 留：对话支持、现在仍然成立的；
   - 删：被推翻、已过期、属于没走通的尝试、跟这次结论打架的；
   - 改：名字/数字变了、角色挪了位的；
   - 加：这次对话才有、板上还没有的结论、约束、坑。
   板要画「对话定下来的结论」，不是「把对话抄上去」。旧元素只有明确要留才留下，别靠追加把它堆在原处。
5. 判断完一次 replace=true 重画整块板：留下的按原坐标重画进去，删掉的不要再出现。不要分几次追加，也不要只补一半就收。
6. 用户手动的操作优先级最高：notes_ls 里标了「用户手动删除」的路径不要重建；标了手动改名/移动的白板不要动它的名字和位置，内容可以更新。

## 板面：一块板可以分几个区域

- 一张板一个主题，板内 2~4 个区域，每区只讲一件事；区域左上角一条 16~18px 标题 text（现状 / 方案 / 顺序 / 坑），区域之间空 ≥240，或用一条竖 line 分隔。
- 每个区域各自独立成图：盖掉别的区域，这一块还讲得通。只有真有因果、调用、先后时，才跨区域拉 arrow。
- 每个区域 3~8 个节点，关系画成 arrow，短语标在箭头上；一条 text 最多两行、24 字。
- 一张板装不下就分板，但同一主题不拆，不同主题才拆第二块板。

## 关系一条都不许丢

- 简化只删措辞，不删关系。关系清单里的每一条，板上都要有落点：**两个节点 + 一条 arrow + 箭头上那句短语**。关系是「没有 / 不存在 / 拦不住」，就把否定画出来（无方向的 line、加叉的 arrow、绕过去的 bypass），不要省掉。
- 用户的措辞可以改短；用户的判断、取舍、边界，和他关心的那个变量不能改、不能丢。对话重点提到的那条关系，哪怕旧元素里已经有，也要保留并重画。
- 画完对着清单逐条打勾：少一条先补；这张板装不下就放到同一主题的另一块板；再不行在收尾里明说「这条没画，因为……」——不许默默漏掉。

## 输出必须是图，不是文档

- 每个区域都得有 arrow / line 连起来的结构。整块板只剩一串 text、一条 arrow 都没有，说明没画完，回去把关系画出来。
- 留结论、决定和原因、接口与数据结构、踩过的坑、跑得通的命令；寒暄、失败尝试、日志堆砌不要。
- 画之前先读 skill whiteboard-style，再按 whiteboard-drawing 调 notes_board。

## 要动的板可能不止一块

- 对话里是几件独立的事，就分别归到各自的板（通常在各自的目录），一块一块来：read → 判断 → replace 重画 → 再 read 确认，然后下一块。不要只改第一块就收尾。
- 一次最多动 3 块；还装不下，说明该先归成一个主题：画最主要的那块，剩下的在收尾里说一句。
- 没有明显合适的目录就跳过：不要新建目录，不要硬塞。

做完用两三句话说：动了哪几块板、每块变了什么（删了什么、加了什么）；或者为什么跳过、适合放到什么主题。不要复述板上的内容。`;

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

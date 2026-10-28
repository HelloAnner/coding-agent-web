import { createNotesSession } from "./profile";
import { readCodingSession } from "../ingest";

/**
 * The "file this conversation" button on the Coding page. One click builds a
 * fresh notes session, hands it the current transcript, and lets it merge the
 * result into an existing board — or skip when no existing folder fits.
 *
 * There is no schedule: the only trigger is the button, one session at a time.
 */

/** One click runs up to this many passes: draw, then self-check twice. */
const MAX_PASSES = 3;
/** Too little time left to start another pass. */
const MIN_PASS_MS = 60_000;
/** The whole run; a pass that hangs is aborted here. */
const RUN_BUDGET_MS = 12 * 60_000;

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

## 说人话

- 节点名要是能念出来的短名（「冻结基线」「发布计划」「ops 预检」），不用内部代号；必须用代号，就紧挨着补一条 13~14px 的 text 解释它是什么。
- 箭头上的短语写动词短语（决定、拦不住、回滚到、先于、不写入），一眼看出两个节点是什么关系；不要写「关联」「关系」这种空话。
- 抽象词（不变量、基线、幂等、冻结、兜底）第一次出现就在旁边一句人话解释：只说「是什么、管什么」，不展开原理。
- 读图的人没看过这条对话。他只看得见板上的字，看不懂就换词，不要照拄对话里的缩写和黑话。

## 不比原来差

- 改旧板就是把它改好：读到的旧板里，名字准的节点、箭头短语、留白、区域划分，都原样保留，不要重新画成一个更难懂的版本。
- 要改的是旧板上真的差的：孤零零一个框、一条 text 当整块板、一排空框用箭头硬串、旧结论已经不准。
- 画完跟改动前比一次：关系条数不能变少（被对话推翻的除外），区域数不能变少，节点名不能变糊。新板更空、更难懂、少了一条关系 → 算返工，回去补。
- 板本来就画得好，就不要为了交差重画一遍；只补这次对话新增和变了的。

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
  /** How many passes the run took: 1 = 一次就过，>1 = 自检又改过。 */
  passes: number;
}

/**
 * The self-check pass: the same session reads its own boards back and judges
 * them against the conversation. It is a prompt, not a new session, so the
 * transcript and the relation list it built are still in context.
 */
export const SELF_CHECK_PROMPT = `现在自检，别急着收尾。

1. 把这次动过的白板逐块 notes_board action=read 读回来，看真实的元素和坐标，不要凭记忆。
2. 对着对话里的关系清单逐条核：
   - 每条关系是不是都有两个节点 + 一条 arrow + 箭头上那句短语？只剩孤立的框，算丢了；
   - 用户自己提出、反复追问、拍板的那几条，是不是在板上最显眼的位置；
   - 有没有被这次对话推翻的旧结论还留在板上？有没有成段的 text、写着「暂无」「无」的占位框、两条不相干的区域硬连的 arrow？
   - 板面是不是按区域排的，区域之间有没有留白，箭头有没有穿过方框？
   - 说人话：每个框名能念出来吗？抽象词、缩写、代号旁边有没有一句人话解释？箭头上的短语是不是动词（决定 / 拦不住 / 回滚到），而不是「关联」？没看过对话的人，只看这张图能念懂吗？
   - 跟改动前比：关系条数和区域数是不是不少于原来（被推翻的除外）？旧板上画对了的那几个节点还在吗？新板比旧板更空、更难懂，就是返工。
3. 有不合适的地方就改：read → 判断留/删/改/加 → replace=true 整块重画，然后回到第 1 步再看一遍。
4. 都核过了，**第一行只写 PASS**，再用两三句话说改完是什么状态（动了哪几块板、删了什么、加了什么）。还有问题就第一行写「FAIL: 具体问题」，继续修。

不要把没确认的东西说成通过了；写 PASS 意味着你已经逐条看过板上的元素。`;

/** A pass counts as done when the agent says so on its first line. */
export function digestPassed(text: string): boolean {
  const head = text.trim().replace(/^[#>*_`\s-]+/, "");
  return /^(PASS|通过)/i.test(head);
}

/** Drop the PASS marker so the tooltip reads like a sentence. */
export function digestReport(text: string): string {
  const trimmed = text.trim().replace(/^[#>*_`\s-]*(PASS|通过)[:：*_`\s-]*/i, "");
  return trimmed || "已处理完，没有可汇报的内容";
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
    // One click is not one shot: draw, then read the boards back and check them
    // until the agent itself reports PASS. The whole run shares one deadline, so
    // a model that keeps revising cannot hang the button.
    const deadline = Date.now() + RUN_BUDGET_MS;
    let text = "";
    const unsubscribe = session.subscribe((event) => {
      const delta = (event as { assistantMessageEvent?: { type?: string; delta?: unknown } }).assistantMessageEvent;
      if (delta?.type === "text_delta" && typeof delta.delta === "string") text += delta.delta;
    });
    const timer = setTimeout(() => {
      void session.abort();
    }, RUN_BUDGET_MS);
    let passes = 0;
    try {
      while (passes < MAX_PASSES && deadline - Date.now() > MIN_PASS_MS) {
        text = "";
        try {
          await session.prompt(passes === 0
            ? `把下面这条 Coding 对话整理进笔记库。\n\n<对话>\n${transcript}\n</对话>`
            : SELF_CHECK_PROMPT);
        } catch {
          break;
        }
        passes++;
        if (passes > 1 && digestPassed(text)) break;
      }
    } finally {
      clearTimeout(timer);
      unsubscribe();
      session.dispose();
    }
    return { message: digestReport(text), passes };
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

import type { NotesTaskDefinition } from "../types";
import { claimSessions, listCodingSessions, sessionsPrompt } from "../ingest";

/**
 * Timed notes jobs. Each one runs on its own fresh pi session; skills, tools and
 * system prompt are per definition, and all of them share the process's one
 * model runtime.
 *
 * The schedule is counted from the previous fire, so a task that takes longer
 * than its interval simply skips a beat instead of piling up.
 *
 * Example:
 *   {
 *     id: "morning-review",
 *     title: "早间复盘",
 *     dailyAt: "08:30",
 *     prompt: "读 工作/日记 下最近三天的笔记，整理成一篇复盘写到 工作/复盘/今天.md",
 *     skills: ["note-writing"],
 *     tools: ["read", "notes_ls", "notes_write"],
 *   }
 *
 * A new task here is picked up on the next server start.
 */

/** The Coding → Notes digest. One id, so the API and the prompt agree. */
export const CODING_DIGEST_TASK_ID = "coding-to-notes";

/** Sessions per turn: one turn covers a readable batch, the rest waits. */
const MAX_SESSIONS_PER_RUN = 3;

export const CODING_DIGEST_PROMPT = `你在做一件固定的事：把 Coding 里的对话沉淀成白板，让笔记库成为这个人的项目知识库。

**只做白板。** 不建 .md 笔记，notes_write 不在这轮的工具栏里。但白板不是文档：关系、流程、层级、对比一律画成形状和箭头，成段的文字不上白板。一条 text 最多两行、24 字，一张图最多 6 条；写不下的结论压成一个节点，或者干脆不写。

笔记库按「场景」组织，不照搬 Coding 的项目目录：
  <场景>/<主题>/<子主题>.excalidraw
  一级是场景，按这个人在做什么归类，不是按仓库归类：项目、面试、AI、工具、运维、写作、生活……
  场景要少而稳定（5~8 个），能放进已有的就别新建。主题是场景下的一块（灰度发布、数据模型、发布流程），
  白板是这张图讲的子主题（优雅发布、流量拓扑）。
  Coding 的项目名不进目录：不同项目里讲同一件事的对话，并进同一块主题/白板；项目名写进节点或一句 text 就够了。
  白板名不写成目录名，也不加「白板」「笔记」这种后缀——树上的图标已经说明类型。一个子主题一块板；
  整个主题的总览才叫「总览」。主题最多再分一个小目录，再深就是没想清楚。

规则，按重要性排序：
1. 合并优先，不轻易新建。先 notes_ls 根目录，看清已有场景和主题：每条对话先判断它属于哪个场景、哪个主题，看内容，不看 cwd。能并进已有的就并进去，用 replace=true 重画合并后的版本——用户手改过的坐标和文字原样保留，被新对话推翻的改掉，新的加上。场景和主题都放不下、而且确实是新领域，才新建一级场景目录；为了一个对话新建场景是不对的。同一个子主题只留一块，重复了就合并、删掉多的；不同子主题各留各的。
2. 先看再画。每一块要动的白板先用 notes_board action=read 读它的现状：每行一个元素，带坐标、尺寸和文字。这是最新的内容，用户自己也可能在上面手写、挪位、改字。
3. 少而准。白板不是过程记录，是下次还能用的知识：结论、决定和原因、接口与数据结构、踩过的坑、跑得通的命令。用户的原话需求、寒暄、失败的尝试、日志堆砌都不要。
4. 一张白板只说一件事，3~8 个节点。画之前先读 skill whiteboard-style，再按 whiteboard-drawing 调 notes_board。结构、流程、分层、依赖都用图形；纯结论最多留一句短 text，不要罗列。合并时也不许膨胀：宁可把旧节点改成更抽象的一句，也不要越并越长。
5. 有层次，不造空目录。场景和主题都用中文短词（项目、面试 / 灰度发布、数据模型、踩坑）；白板名是子主题，一张图只讲一件事。不按 coding 项目、仓库名建目录；归属还不成型的主题放在场景目录根下。
6. 不确定就不画。对话里没有依据的不补全、不推测；两段对话冲突时以最新的为准，把旧的节点改掉并在旁边一句 text 写明被取代。
7. 用户手动的操作优先级最高。notes_ls 里标了「手动改名 / 手动移动」的条目：内容可以更新，但不要改名、不要移动、不要删除；标了「用户手动删除」的路径不要重建，需要恢复让用户自己来。定时任务不许替用户纠正结构。
8. 用 notes_manage 建目录、改名、挪位置、删除；它也能建文件，但 kind 只给 board。确认已经被新白板取代的旧白板才删，删非空目录要 recursive=true。

每一轮只处理提示里列出的会话，用 notes_sessions action=read 读正文。做完用两三句话说：读了哪几个会话，动了哪几块白板，删了什么。没有值得留下来的内容就直说，不要为了有产出而画。`;


/** The manual cleanup run: merge boards, unify titles, tidy the tree. */
export const NOTES_TIDY_TASK_ID = "notes-tidy";

export const NOTES_TIDY_PROMPT = `你在整理这个人的笔记库。只做合并、改名、挪位、去重，不发明内容。

先看全貌：notes_ls 根目录，再往下逐层 notes_ls；要对某个主题动手前，先 read 相关白板和笔记。用户可能手改过，以读到的为准。

目标结构按「场景」组织，不按 Coding 的项目目录：
  <场景>/<主题>/<子主题>.excalidraw
  场景 = 这个人在做什么（项目、面试、AI、工具、运维、写作……），5~8 个，少而稳定；
  主题 = 场景下的一块（灰度发布、数据模型）；白板 = 具体的子主题（优雅发布、流量拓扑）。
  仓库名、项目名不进目录：同一个主题来自几个项目的，并到同一个主题目录里。
  现在根目录下的 anner、cnpc、coding-agent-web、wufan-dev 这类是 coding 项目名，不是场景，要按内容拆开重放。

按优先级做三件事：
1. 合并白板。同一个子主题有多块板才合并：先读每一块，留下真正的结论、决定和坑，去掉重复和过程记录，按 skill whiteboard-style 画成一张（关系用形状和箭头，不要字墙），replace=true 写到主白板上，再用 notes_manage remove 删掉多余的那块。合并后节点不许变多。不同子主题各留各的板，不要为了「一个主题一块」把讲不同事情的图并成一张。
2. 理顺标题。文件名和白板名就是标题，改成一眼前认得出的短标题：去掉日期前缀、对话口气的长句、「新建」「未命名」「副本」，以及名字尾巴上的「· 白板」「· 笔记」「白板」「笔记」；同一层不要同名或者近义重复。白板名不要等于所在目录名：读一下这块板，用这张图真正讲的子主题给它命名；一块板如果就是整个主题的总览，叫「总览」。用 notes_manage rename 改文件或目录名，不改正文。
3. 收拾目录，按场景重新聚合。先把根目录的项目名目录（anner、cnpc、coding-agent-web、wufan-dev……）里的白板按内容归到场景下：先确定 5~8 个场景，再把每块板 move 到 <场景>/<主题>/；同一主题来自不同项目的板放进同一个主题目录。
   场景优先复用根目录里已经是场景的目录（项目、面试、AI 这类），没有合适的才新建，不要为一块板开一个新场景。
   搬空的目录、只有一个孩子又没信息量的中间目录、空目录，都删掉（remove，非空要 recursive=true）。根目录最后只剩场景目录。

用户手动的操作优先级最高：notes_ls 里带「手动改名 / 手动移动」的条目直接跳过，不改名、不移动、不删除；「用户手动删除」的路径不要重建。收尾时说明跳过了哪几个。

不动的东西：笔记正文不重写；归属不确定的主题留在原处，不要为了整齐乱挪；删目录或白板前确认内容已经合并过去或确实为空，删非空目录要 recursive=true。

做完用三四句话说清楚：合并了哪几块板、改了哪些标题、挪了或删了哪些目录、哪些没动。没什么可整理的就直接说。`;

/** Every cron task the notes scheduler knows; a new one is picked up on boot. */
export const NOTES_SCHEDULED_TASKS: NotesTaskDefinition[] = [
  {
    id: NOTES_TIDY_TASK_ID,
    title: "整理笔记库",
    prompt: "整理笔记库：合并白板、理顺标题、收拾目录。",
    manual: true,
    systemPrompt: NOTES_TIDY_PROMPT,
    skills: ["whiteboard-style", "whiteboard-drawing"],
    tools: ["read", "notes_ls", "notes_board", "notes_manage"],
    timeoutMinutes: 15,
  },
  {
    id: CODING_DIGEST_TASK_ID,
    title: "把 Coding 对话聚合成笔记",
    // Replaced per fire by prepare(); kept for the task list.
    prompt: "把 Coding 里非归档的新对话按主题并进笔记。",
    everySeconds: 30,
    systemPrompt: CODING_DIGEST_PROMPT,
    tools: ["read", "notes_ls", "notes_board", "notes_manage", "notes_sessions"],
    timeoutMinutes: 10,
    prepare: async () => {
      const pending = (await listCodingSessions()).filter((session) => session.pending);
      if (!pending.length) return null;
      const batch = pending.slice(0, MAX_SESSIONS_PER_RUN);
      return {
        prompt: sessionsPrompt(batch, pending.length - batch.length),
        // The batch is marked read even when the turn failed: the run already
        // spent its budget on these, and a session that broke one run breaks
        // the next one the same way.
        after: (status) => {
          claimSessions(batch);
          console.log(`[notes-task] ${CODING_DIGEST_TASK_ID} 读入 ${batch.length} 个会话（${status}）`);
        },
      };
    },
  },
];

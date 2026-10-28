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
 *     tools: ["read", "ls", "notes_write"],
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

笔记库是三层：项目 → 主题（目录）→ 子主题（白板），和 Coding 左侧的项目分组一一对应：
  <项目目录>/<主题>/<子主题>.excalidraw
  目录名是主题（灰度发布、错误恢复），白板名是这张图讲的具体子主题（优雅发布、流量拓扑）。
  白板名不写成目录名，也不加「白板」「笔记」这种类型后缀——树上的图标已经说明类型。
  一个子主题一块板；一个主题下可以有几块不同子主题的板，但同一个子主题不许重复建。
  一张板如果确实就是整个主题的总览，就叫「总览」。主题最多再分一个小目录，再深就是没想清楚。

规则，按重要性排序：
1. 合并优先，不轻易新建。先 ls 到项目/主题目录，把里面的 .excalidraw 都 read 一遍：这批对话讲的是哪个子主题，能并进那一块就并进去，用 replace=true 重画合并后的版本——用户手改过的坐标和文字原样保留，被新对话推翻的改掉，新的加上。目录里没有承接这个子主题的白板，才新建一块，名字用子主题名，不要用主题名、也不要用对话标题。同一个子主题只留一块，重复了就合并、删掉多的；不同子主题各留各的。
2. 先看再画。每一块要动的白板先用 notes_board action=read 读它的现状：每行一个元素，带坐标、尺寸和文字。这是最新的内容，用户自己也可能在上面手写、挪位、改字。
3. 少而准。白板不是过程记录，是下次还能用的知识：结论、决定和原因、接口与数据结构、踩过的坑、跑得通的命令。用户的原话需求、寒暄、失败的尝试、日志堆砌都不要。
4. 一张白板只说一件事，3~8 个节点。画之前先读 skill whiteboard-style，再按 whiteboard-drawing 调 notes_board。结构、流程、分层、依赖都用图形；纯结论最多留一句短 text，不要罗列。合并时也不许膨胀：宁可把旧节点改成更抽象的一句，也不要越并越长。
5. 有层次，不造空目录。项目目录名任务提示里给了；主题子目录用中文短词（架构、数据模型、发布、踩坑）；白板名是子主题，一个图只讲一件事。主题还不成型就放在项目目录根下。
6. 不确定就不画。对话里没有依据的不补全、不推测；两段对话冲突时以最新的为准，把旧的节点改掉并在旁边一句 text 写明被取代。
7. 用 notes_manage 建目录、改名、挪位置、删除；它也能建文件，但 kind 只给 board。确认已经被新白板取代的旧白板才删，删非空目录要 recursive=true。

每一轮只处理提示里列出的会话，用 notes_sessions action=read 读正文。做完用两三句话说：读了哪几个会话，动了哪几块白板，删了什么。没有值得留下来的内容就直说，不要为了有产出而画。`;


/** The manual cleanup run: merge boards, unify titles, tidy the tree. */
export const NOTES_TIDY_TASK_ID = "notes-tidy";

export const NOTES_TIDY_PROMPT = `你在整理这个人的笔记库。只做合并、改名、挪位、去重，不发明内容。

先看全貌：ls 根目录，再逐个项目 ls；要对某个主题动手前，先 read 相关白板和笔记。用户可能手改过，以读到的为准。

按优先级做三件事：
1. 合并白板。同一个子主题有多块板才合并：先读每一块，留下真正的结论、决定和坑，去掉重复和过程记录，按 skill whiteboard-style 画成一张（关系用形状和箭头，不要字墙），replace=true 写到主白板上，再用 notes_manage remove 删掉多余的那块。合并后节点不许变多。不同子主题各留各的板，不要为了「一个主题一块」把讲不同事情的图并成一张。
2. 理顺标题。文件名和白板名就是标题，改成一眼前认得出的短标题：去掉日期前缀、对话口气的长句、「新建」「未命名」「副本」；同一层不要同名或者近义重复。白板名不要等于所在目录名，也不要带「白板」「笔记」后缀：读一下这块板，用这张图真正讲的子主题给它命名；一块板如果就是整个主题的总览，叫「总览」。用 notes_manage rename 改文件或目录名，不改正文。
3. 收拾目录。按「项目 → 主题」两级收拢：散在多个目录的同一主题并进一个目录；只有一个孩子、又没有信息量的中间目录，把内容挪上来再删空目录；空目录删掉。用 move / remove。

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
    tools: ["read", "ls", "notes_board", "notes_manage"],
    timeoutMinutes: 15,
  },
  {
    id: CODING_DIGEST_TASK_ID,
    title: "把 Coding 对话聚合成笔记",
    // Replaced per fire by prepare(); kept for the task list.
    prompt: "把 Coding 里非归档的新对话按主题并进笔记。",
    everySeconds: 30,
    systemPrompt: CODING_DIGEST_PROMPT,
    tools: ["read", "ls", "notes_board", "notes_manage", "notes_sessions"],
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

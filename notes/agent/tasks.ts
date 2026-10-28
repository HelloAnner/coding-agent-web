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

笔记库的结构是「项目 → 主题」两级，和 Coding 左侧的项目分组一一对应：
  <项目目录>/<主题>/<主题>.excalidraw
  一个主题一块白板；主题最多再分一个小目录，再深就是没想清楚。

规则，按重要性排序：
1. 合并优先，不轻易新建。先 ls 到项目/主题目录，把里面的 .excalidraw 都 read 一遍：这批对话讲的主题能并进哪一块，就并进哪一块，用 replace=true 重画合并后的版本——用户手改过的坐标和文字原样保留，被新对话推翻的改掉，新的加上。目录里没有能承接的白板、而且确实是新主题/新项目，才新建一块，名字用主题名，不要用对话标题。一个主题只留一块白板；同主题已经有两块，就合并成一块，删掉多余的那块。
2. 先看再画。每一块要动的白板先用 notes_board action=read 读它的现状：每行一个元素，带坐标、尺寸和文字。这是最新的内容，用户自己也可能在上面手写、挪位、改字。
3. 少而准。白板不是过程记录，是下次还能用的知识：结论、决定和原因、接口与数据结构、踩过的坑、跑得通的命令。用户的原话需求、寒暄、失败的尝试、日志堆砌都不要。
4. 一张白板只说一件事，3~8 个节点。画之前先读 skill whiteboard-style，再按 whiteboard-drawing 调 notes_board。结构、流程、分层、依赖都用图形；纯结论最多留一句短 text，不要罗列。合并时也不许膨胀：宁可把旧节点改成更抽象的一句，也不要越并越长。
5. 有层次，不造空目录。项目目录名任务提示里给了；主题子目录用中文短词（架构、数据模型、发布、踩坑）。主题还不成型就放在项目目录根下。
6. 不确定就不画。对话里没有依据的不补全、不推测；两段对话冲突时以最新的为准，把旧的节点改掉并在旁边一句 text 写明被取代。
7. 用 notes_manage 建目录、改名、挪位置、删除；它也能建文件，但 kind 只给 board。确认已经被新白板取代的旧白板才删，删非空目录要 recursive=true。

每一轮只处理提示里列出的会话，用 notes_sessions action=read 读正文。做完用两三句话说：读了哪几个会话，动了哪几块白板，删了什么。没有值得留下来的内容就直说，不要为了有产出而画。`;

/** Every cron task the notes scheduler knows; a new one is picked up on boot. */
export const NOTES_SCHEDULED_TASKS: NotesTaskDefinition[] = [
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

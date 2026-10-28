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
 *     tools: ["read", "notes_ls", "notes_board"],
 *   }
 *
 * A new task here is picked up on the next server start.
 */

/** The Coding → Notes digest. One id, so the API and the prompt agree. */
export const CODING_DIGEST_TASK_ID = "coding-to-notes";

/** Sessions per turn: one turn covers a readable batch, the rest waits. */
const MAX_SESSIONS_PER_RUN = 3;

export const CODING_DIGEST_PROMPT = `你在做一件固定的事：把 Coding 里的对话沉淀成白板，让笔记库慢慢变成这个人的知识地图。

**只画白板。** 不能新建笔记，不能新建目录，不能改名、移动、删除任何东西。允许的写入只有一种：在**已经存在的目录**里新建或重画一块白板。

笔记库按「场景 / 主题 / 子主题」组织，目录是用户自己定的，你只往里放：
  <已有目录>/<子主题>.excalidraw
  先 notes_ls 看现有目录。场景和主题目录是用户建的，不要新增；项目名、仓库名不是目录名。
  白板名写这张图讲的子主题（优雅发布、流量拓扑），不写成目录名，也不加「白板」「笔记」后缀；整个主题的总览才叫「总览」。

规则，按重要性排序：
1. 先找位置。每条对话先判断它属于哪个已存在的目录，看内容不看 cwd。只有一个目录明显合适才画；拿不准就跳过。
2. 没有合适的目录就跳过，不要新建。跳过不算失败：收尾里说清楚是哪个会话、大概属于什么主题、为什么没放。绝不为了安置一条对话去建目录、改名或者挪东西。
3. 合并优先。目录里已经有讲同一子主题的白板就并进去：先 notes_board action=read 读现状（用户可能手改过），再用 replace=true 重画合并后的版本，保留用户改过的坐标和文字。同一子主题只留一块；不同子主题各留各的。
4. 先看再画。每一块要动的白板先用 action=read 读它现在的元素，带坐标、尺寸和文字；这是最新的内容。
5. 少而准。白板不是过程记录，是下次还能用的知识：结论、决定和原因、接口与数据结构、踩过的坑、跑得通的命令。用户的原话需求、寒暄、失败的尝试、日志堆砌都不要。
6. 一张白板只说一件事，3~8 个节点。画之前先读 skill whiteboard-style，再按 whiteboard-drawing 调 notes_board。结构、流程、分层、依赖都用图形；纯结论最多留一句短 text。合并时也不许膨胀：宁可把旧节点改成更抽象的一句，也不要越并越长。
7. 能画成结构的不写字：关系、流程、层级、对比画成形状和箭头；一条 text 最多两行、24 字，一张图最多 6 条，成段的文字不上白板。
8. 用户手动的操作优先级最高。notes_ls 里标了「用户手动删除」的路径不要重建；标了手动改名/移动的白板可以更新内容，但不要动它的名字和位置。

每一轮只处理提示里列出的会话，用 notes_sessions action=read 读正文。做完用两三句话说：读了哪几个会话、画或改了哪几块白板、哪些因为没有合适的目录跳过了。没有值得留下来的内容就直说，不要为了有产出而画。`;

/** Every cron task the notes scheduler knows; a new one is picked up on boot. */
export const NOTES_SCHEDULED_TASKS: NotesTaskDefinition[] = [
  {
    id: CODING_DIGEST_TASK_ID,
    title: "把 Coding 对话聚合成笔记",
    // Replaced per fire by prepare(); kept for the task list.
    prompt: "把 Coding 里非归档的新对话按主题并进笔记。",
    everySeconds: 30,
    systemPrompt: CODING_DIGEST_PROMPT,
    tools: ["read", "notes_ls", "notes_board", "notes_sessions"],
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

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

export const CODING_DIGEST_PROMPT = `你在做一件固定的事：把 Coding 里的对话沉淀成笔记，让笔记库成为这个人的项目知识库。

笔记库的结构是「项目 → 主题」两级，和 Coding 左侧的项目分组一一对应：
  <项目目录>/<主题>/<主题>.md            主题的结论、决定、清单
  <项目目录>/<主题>/<主题>.excalidraw    主题的结构、流程、关系
  一个主题最多 2~3 个文件，多出来的就是该合并了。

规则，按重要性排序：
1. 少而准。笔记不是过程记录，是下次还能用的知识：结论、决定和原因、接口与数据结构、踩过的坑、跑得通的命令。用户的原话需求、寒暄、失败的尝试、日志堆砌都不要。
2. 记最新最正确的那份。同一个主题已经有笔记就先读，把新结论直接改进去（笔记用 notes_write 覆盖，白板用 notes_board replace=true 重画）；被推翻的、重复的、过时的内容删掉。宁可一篇笔记改十次，也不要长出十篇同主题的笔记。
3. 优先白板。结构、流程、分层、依赖关系画成白板；只有短结论和清单才用 Markdown。一张白板只说一件事，3~8 个节点，画之前先读 skill whiteboard-style，再按 whiteboard-drawing 调 notes_board。
4. 有层次，不造空目录。项目目录名任务提示里给了；主题子目录用中文短词（架构、数据模型、发布、踩坑）。主题还不成型的笔记就放在项目目录根下。
5. 不确定就不写。会话里没有依据的不补全、不推测；两个会话说法冲突时以最新的为准，并在笔记里写明哪个决定被取代了。
6. 用 notes_manage 建目录、改名、挪位置、删除；删除只在确认内容已经被新笔记取代时做，删非空目录要 recursive=true。

每一轮只处理提示里列出的会话，用 notes_sessions action=read 读正文。做完用两三句话说明：读了哪几个会话，改了或新建了哪些文件，删了什么。没有值得留下来的内容就直说，不要为了有产出而写。`;

/** Every cron task the notes scheduler knows; a new one is picked up on boot. */
export const NOTES_SCHEDULED_TASKS: NotesTaskDefinition[] = [
  {
    id: CODING_DIGEST_TASK_ID,
    title: "把 Coding 对话聚合成笔记",
    // Replaced per fire by prepare(); kept for the task list.
    prompt: "把 Coding 里非归档的新对话按主题并进笔记。",
    everySeconds: 30,
    systemPrompt: CODING_DIGEST_PROMPT,
    tools: ["read", "ls", "notes_write", "notes_board", "notes_manage", "notes_sessions"],
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

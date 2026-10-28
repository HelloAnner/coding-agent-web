import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { NotesBoardSettings, NotesNode } from "../types";
import { BOARD_EXTENSION, NotesError, createItem, listTree, readItem, writeItem } from "../files";
import { buildBoardScene, describeScene } from "./board";
import { manualCreateBlock, readManualMarks } from "@/notes/manual";
import { listCodingSessions, readCodingSession } from "../ingest";

/**
 * The notes agent's own tools. The agent may read the vault, list it with the
 * user's manual marks, and draw whiteboards. It cannot create notes or
 * directories, and cannot rename, move or delete anything: the only write is a
 * board inside a directory that already exists.
 */

export const NOTES_BOARD_TOOL = "notes_board";
export const NOTES_SESSIONS_TOOL = "notes_sessions";

function vaultPath(value: string, extension: string | null, tool: string): string {
  const target = value.trim().replace(/^\/+/, "");
  if (!target || target.split("/").some((part) => !part || part === ".." || part.startsWith("."))) {
    throw new NotesError("路径必须是笔记库内的相对路径", 400);
  }
  if (extension && !target.toLowerCase().endsWith(extension)) {
    throw new NotesError(`${tool} 只写 ${extension} 文件，收到 ${target}`, 400);
  }
  return target;
}

function parentOf(target: string): string {
  const cut = target.lastIndexOf("/");
  return cut < 0 ? "" : target.slice(0, cut);
}

/** Text a diagram could have shown instead of a paragraph. */
function proseWarnings(elements: readonly { type: string; label?: string }[]): string[] {
  return elements.flatMap((element) => {
    const label = (element.label ?? "").trim();
    if (!label) return [];
    const lines = label.split("\n").length;
    const length = label.replace(/\s/g, "").length;
    if (lines <= 2 && length <= 24) return [];
    return [`${JSON.stringify(label.slice(0, 18))}（${lines} 行 ${length} 字）`];
  });
}

/** How long ago a manual op happened, for the tree listing. */
function ago(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export const NOTES_LS_TOOL = "notes_ls";

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

/** The sidebar node at a path, to tell a full folder from a single note. */
async function findNode(target: string): Promise<NotesNode | null> {
  const walk = (nodes: readonly NotesNode[]): NotesNode | null => {
    for (const node of nodes) {
      if (node.path === target) return node;
      const found = node.children ? walk(node.children) : null;
      if (found) return found;
    }
    return null;
  };
  return walk(await listTree());
}

/** Other whiteboards in the folder a new board would land in. */
async function siblingBoards(target: string): Promise<string[]> {
  const parent = parentOf(target);
  const children = parent ? (await findNode(parent))?.children ?? [] : await listTree();
  return children
    .filter((child) => child.type === "board" && child.path !== target)
    .map((child) => child.path);
}

const boardShape = Type.Object({
  type: Type.Union([
    Type.Literal("rectangle"),
    Type.Literal("ellipse"),
    Type.Literal("diamond"),
    Type.Literal("text"),
    Type.Literal("arrow"),
    Type.Literal("line"),
  ], { description: "形状种类：rectangle / ellipse / diamond / text / arrow / line（line 是没有箭头的连线，做分隔线）" }),
  x: Type.Number({ description: "左边 x，场景坐标" }),
  y: Type.Number({ description: "上边 y，场景坐标" }),
  width: Type.Optional(Type.Number({ description: "宽度，默认 200（rectangle）/160（ellipse、diamond）；arrow、line 不用给" })),
  height: Type.Optional(Type.Number({ description: "高度，默认 100 / 100 / 120；arrow、line 不用给" })),
  label: Type.Optional(Type.String({ description: "形状里的短标签：节点名、箭头短语、一句旁注；text 不是段落，最多两行、24 字" })),
  to: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() }, { description: "arrow、line 的终点，绝对坐标" })),
  strokeColor: Type.Optional(Type.String({ description: "描边色，默认 #1b1b1f" })),
  backgroundColor: Type.Optional(Type.String({ description: "填充色，默认透明" })),
  fontSize: Type.Optional(Type.Number({ description: "文字大小，默认用设置里的白板字号" })),
});

export function notesAgentTools(board: NotesBoardSettings): ToolDefinition[] {
  return [
    defineTool({
      name: NOTES_LS_TOOL,
      label: "看目录",
      description: "列出笔记库的目录树，并标出用户手动做过的改动：手动改名/移动的条目，以及手动删除、不允许重建的路径。改动前先看这个；不要用 ls，它看不到这些标记。",
      promptSnippet: "List the vault tree with the user's manual marks",
      promptGuidelines: [
        "List the vault with notes_ls; plain ls cannot see the user's manual marks.",
        "An entry marked 手动改名/手动移动 keeps its name and place: update its content, never rename, move or delete it.",
        "A path under 用户手动删除 must not be recreated.",
      ],
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "只列这个目录（相对路径，空字符串是根目录）；不传就是整棵树" })),
      }),
      async execute(_toolCallId, params) {
        const marks = readManualMarks();
        const markAt = new Map(marks.filter((mark) => mark.op !== "remove").map((mark) => [mark.path, mark]));
        const tree = await listTree();
        const requested = (params.path ?? "").trim().replace(/^\/+|\/+$/g, "");
        const scope = requested ? await findNode(requested) : null;
        if (requested && !scope) throw new NotesError(`没有这个目录：${requested}`, 404);

        const lines: string[] = [];
        const emit = (nodes: readonly NotesNode[], depth: number): void => {
          for (const node of nodes) {
            const mark = markAt.get(node.path);
            const suffix = mark
              ? `   ← 手动${mark.op === "move" ? "移动" : "改名"}${mark.fromPath ? `（原名 ${mark.fromPath}）` : ""}`
              : "";
            lines.push(`${"  ".repeat(depth)}${node.name}${node.type === "dir" ? "/" : ""}${suffix}`);
            if (node.type === "dir" && node.children?.length) emit(node.children, depth + 1);
          }
        };
        if (scope) {
          if (scope.type === "dir") emit(scope.children ?? [], 0);
          else lines.push(scope.path);
        } else {
          emit(tree, 0);
        }

        const tombstones = marks
          .filter((mark) => mark.op === "remove")
          .filter((mark) => !scope || mark.path === scope.path || mark.path.startsWith(`${scope.path}/`));
        const body = lines.length ? lines.join("\n") : "（空目录）";
        const removed = tombstones.length
          ? `\n\n用户手动删除，不要重建：\n${tombstones.map((mark) => `  ${mark.path}（${mark.kind === "dir" ? "目录" : mark.kind === "board" ? "白板" : "笔记"}，${ago(mark.at)}）`).join("\n")}`
          : "";
        return textResult(`${body}${removed}`, {
          entries: lines.length,
          manual: marks.length,
        });
      },
    }),
    defineTool({
      name: NOTES_BOARD_TOOL,
      label: "白板",
      description: "一块 Excalidraw 白板的读取和绘制。action=read（默认）先看白板上现在有什么：每行一个元素，带类型、坐标、尺寸和文字；action=draw 给一组 rectangle / ellipse / diamond / text / arrow / line 画上去，默认追加，replace=true 则清空重画。文字字体和字号来自笔记设置。风格见 skill whiteboard-style。",
      promptSnippet: "Read or draw an Excalidraw whiteboard in the vault",
      promptGuidelines: [
        "Read every same-topic board with notes_board action=read before changing one: the user edits boards by hand.",
        "Decide per element first — keep, delete, change, add — then redraw the whole board once with replace=true.",
        "One board holds 2-4 regions (heading text, ≥240 gaps); a second board only for a different theme.",
        "When several boards need the change, do them one at a time and read each back.",
        "Draw boards with notes_board: pass shapes, never raw Excalidraw JSON.",
      ],
      parameters: Type.Object({
        path: Type.String({ description: "笔记库内的相对路径，以 .excalidraw 结尾，例如 方案/架构图.excalidraw" }),
        action: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("draw")], {
          description: "read 读现有内容（默认），draw 画",
        })),
        elements: Type.Optional(Type.Array(boardShape, {
          description: "action=draw 时要画的形状，按绘制顺序；后面的盖住前面的",
          minItems: 1,
          maxItems: 200,
        })),
        replace: Type.Optional(Type.Boolean({ description: "draw 时 true 清空已有内容后重画。改已有白板用它，并把要保留的旧元素一起重画进去；默认追加只用于新开板" })),
      }),
      async execute(_toolCallId, params) {
        const target = vaultPath(params.path, BOARD_EXTENSION, NOTES_BOARD_TOOL);
        const existing = await readItem(target).catch((error: unknown) => {
          if (error instanceof NotesError && error.status === 404) return null;
          throw error;
        });
        if (params.action !== "draw") {
          if (!existing) throw new NotesError(`${target} 还不存在`, 404);
          const lines = describeScene(existing.content);
          const body = lines.length ? lines.join("\n") : "（空白板）";
          return textResult(`${target} 现有 ${lines.length} 个元素：\n${body}`, {
            path: target,
            elements: lines.length,
          });
        }
        if (!params.elements?.length) throw new NotesError("draw 需要 elements", 400);
        if (!existing) {
          const blocked = manualCreateBlock(target);
          if (blocked) throw new NotesError(blocked, 409);
          const dir = parentOf(target);
          // Only an existing folder can take a new board. No mkdir: a run that
          // cannot find a fitting folder skips the conversation instead.
          if (dir && !(await findNode(dir))) {
            throw new NotesError(`目录 ${dir} 不存在。白板只能建在已有的目录里；没有合适的位置就跳过这条对话，不要新建目录`, 400);
          }
          await createItem(dir, target.split("/").pop()!, "board", { source: "agent" });
        }
        const scene = buildBoardScene(params.elements, board, {
          existing: existing?.content ?? null,
          replace: params.replace ?? false,
        });
        await writeItem(target, scene);
        const total = (JSON.parse(scene) as { elements: unknown[] }).elements.length;
        const prose = proseWarnings(params.elements);
        // A new board beside an existing one is almost always a theme that
        // should have been merged: say so while the model can still redraw it.
        const siblings = existing ? [] : await siblingBoards(target);
        return textResult(
          `白板 ${target} 现有 ${total} 个元素`
            + (siblings.length
              ? `\n注意：同目录已有白板 ${siblings.join("、")}。同主题应合并进其中一块（read 后一次 replace=true 重画），不要另开新板；只有确实是一个新主题/新项目才新建。`
              : "")
            + (prose.length
              ? `\n注意：${prose.join("、")} 超过「一条 text 两行、24 字」。能画成结构的关系画成形状和箭头，成段的话不要上白板。`
              : ""),
          {
            path: target,
            drawn: params.elements.length,
            created: !existing,
            ...(siblings.length ? { siblings } : {}),
            ...(prose.length ? { prose } : {}),
          },
        );
      },
    }),
    defineTool({
      name: NOTES_SESSIONS_TOOL,
      label: "读 Coding 会话",
      description: "看 Coding 模块里的会话：list 列出非归档会话，标出哪些有笔记还没读过的新内容；read 读一个会话的正文（用户提问、助手回答、工具调用摘要）。只读，不改笔记。",
      promptSnippet: "List Coding sessions and read a session's transcript",
      promptGuidelines: [
        "Read Coding conversations with notes_sessions; never open session files with read or bash.",
        "Only the sessions the task prompt lists are this run's job.",
      ],
      parameters: Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("read")], {
          description: "list 列会话 / read 读一个会话的正文",
        }),
        session: Type.Optional(Type.String({ description: "read 的会话 id（任务提示或 list 里给的）" })),
        project: Type.Optional(Type.String({ description: "list 只看某个项目：项目根路径或文件夹名的一部分" })),
      }),
      async execute(_toolCallId, params) {
        if (params.action === "read") {
          const id = (params.session ?? "").trim();
          if (!id) throw new NotesError("read 需要 session", 400);
          const text = await readCodingSession(id);
          if (text === null) throw new NotesError(`没有这个会话：${id}`, 404);
          return textResult(text, { session: id });
        }
        const filter = (params.project ?? "").trim().toLowerCase();
        const sessions = await listCodingSessions();
        const shown = filter
          ? sessions.filter((session) => session.projectRoot.toLowerCase().includes(filter)
            || session.projectDir.toLowerCase().includes(filter))
          : sessions;
        if (!shown.length) {
          return textResult(filter ? `没有匹配「${params.project}」的会话` : "还没有任何 Coding 会话", { count: 0 });
        }
        const lines = shown.map((session) => `来自 ${session.projectDir} · 「${session.name}」 id=${session.id} · ${session.modified} · ${session.messageCount} 条`);
        return textResult(lines.join("\n"), {
          count: shown.length,
          pending: shown.filter((session) => session.pending).length,
        });
      },
    }),
  ];
}

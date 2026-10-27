import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { NotesBoardSettings, NotesNode } from "../types";
import {
  BOARD_EXTENSION,
  NOTE_EXTENSION,
  NotesError,
  createDirectory,
  createItem,
  listTree,
  moveItem,
  readItem,
  removeItem,
  renameItem,
  writeItem,
} from "../files";
import { buildBoardScene } from "./board";

/**
 * The notes agent's own tools. `read` and `ls` come from pi; these three are
 * what the vault needs beyond files: a Markdown note, a whiteboard built from
 * shapes rather than hand-written scene JSON, and the sidebar tree itself
 * (directories, creating, renaming, moving and deleting entries). All accept
 * only vault-relative paths, so the agent stays inside data/notes.
 */

export const NOTES_WRITE_TOOL = "notes_write";
export const NOTES_BOARD_TOOL = "notes_board";
export const NOTES_MANAGE_TOOL = "notes_manage";

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

function isExistsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EEXIST" || (error instanceof NotesError && error.status === 409);
}

/** Create a directory and every missing ancestor; existing ones are fine. */
async function ensureDirectories(target: string): Promise<void> {
  if (!target) return;
  let dir = "";
  for (const segment of target.split("/")) {
    try {
      await createDirectory(dir, segment);
    } catch (error) {
      if (!isExistsError(error)) throw error;
    }
    dir = dir ? `${dir}/${segment}` : segment;
  }
}

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
  label: Type.Optional(Type.String({ description: "形状里的文字；text 形状就是正文，可用 \\n 换行" })),
  to: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() }, { description: "arrow、line 的终点，绝对坐标" })),
  strokeColor: Type.Optional(Type.String({ description: "描边色，默认 #1b1b1f" })),
  backgroundColor: Type.Optional(Type.String({ description: "填充色，默认透明" })),
  fontSize: Type.Optional(Type.Number({ description: "文字大小，默认用设置里的白板字号" })),
});

export function notesAgentTools(board: NotesBoardSettings): ToolDefinition[] {
  return [
    defineTool({
      name: NOTES_WRITE_TOOL,
      label: "写笔记",
      description: "创建或整体覆盖一篇 Markdown 笔记。路径相对笔记库，缺少的目录会自动创建。只写 .md；白板用 notes_board。",
      promptSnippet: "Create or overwrite a Markdown note in the vault",
      promptGuidelines: ["Write notes with notes_write, not bash: the path is vault-relative and directories are created for you."],
      parameters: Type.Object({
        path: Type.String({ description: "笔记库内的相对路径，以 .md 结尾，例如 工作/周报.md" }),
        content: Type.String({ description: "完整 Markdown 正文；覆盖已有文件" }),
      }),
      async execute(_toolCallId, params) {
        const target = vaultPath(params.path, NOTE_EXTENSION, NOTES_WRITE_TOOL);
        const existing = await readItem(target).catch((error: unknown) => {
          if (error instanceof NotesError && error.status === 404) return null;
          throw error;
        });
        if (existing) {
          await writeItem(target, params.content);
          return textResult(`已更新 ${target}`, { path: target, created: false });
        }
        const dir = parentOf(target);
        await ensureDirectories(dir);
        await createItem(dir, target.split("/").pop()!, "note");
        await writeItem(target, params.content);
        return textResult(`已创建 ${target}`, { path: target, created: true });
      },
    }),
    defineTool({
      name: NOTES_BOARD_TOOL,
      label: "画白板",
      description: "在 Excalidraw 白板上画图形：给一组 rectangle / ellipse / diamond / text / arrow / line，工具生成合法的 scene JSON 写进 .excalidraw。默认追加到已有白板，replace=true 则清空重画。文字字体和字号来自笔记设置。风格见 skill whiteboard-style。",
      promptSnippet: "Draw shapes on an Excalidraw whiteboard in the vault",
      promptGuidelines: [
        "Draw whiteboards with notes_board: pass shapes, never raw Excalidraw JSON.",
        "Lay shapes out on a grid: 200 wide boxes at y=0, 60px gaps, text under or inside boxes.",
      ],
      parameters: Type.Object({
        path: Type.String({ description: "笔记库内的相对路径，以 .excalidraw 结尾，例如 方案/架构图.excalidraw" }),
        elements: Type.Array(boardShape, { description: "要画的形状，按绘制顺序；后面的盖住前面的", minItems: 1, maxItems: 200 }),
        replace: Type.Optional(Type.Boolean({ description: "true 清空已有内容后重画，默认追加" })),
      }),
      async execute(_toolCallId, params) {
        const target = vaultPath(params.path, BOARD_EXTENSION, NOTES_BOARD_TOOL);
        const existing = await readItem(target).catch((error: unknown) => {
          if (error instanceof NotesError && error.status === 404) return null;
          throw error;
        });
        if (!existing) {
          const dir = parentOf(target);
          await ensureDirectories(dir);
          await createItem(dir, target.split("/").pop()!, "board");
        }
        const scene = buildBoardScene(params.elements, board, {
          existing: existing?.content ?? null,
          replace: params.replace ?? false,
        });
        await writeItem(target, scene);
        const total = (JSON.parse(scene) as { elements: unknown[] }).elements.length;
        return textResult(`白板 ${target} 现有 ${total} 个元素`, {
          path: target,
          drawn: params.elements.length,
          created: !existing,
        });
      },
    }),
    defineTool({
      name: NOTES_MANAGE_TOOL,
      label: "整理目录",
      description: "整理笔记库的目录树：mkdir 新建目录（多级用 a/b 一次建好）、create 新建空的笔记或白板、rename 重命名、move 换目录、remove 删除。写内容用 notes_write，画图用 notes_board。",
      promptSnippet: "Create directories and create, rename, move or delete vault entries",
      promptGuidelines: [
        "Use notes_manage for the sidebar tree: mkdir, create, rename, move, remove. Never touch the vault with bash.",
        "Deleting a directory deletes everything inside it; only remove when the user asked for it.",
      ],
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("mkdir"),
          Type.Literal("create"),
          Type.Literal("rename"),
          Type.Literal("move"),
          Type.Literal("remove"),
        ], { description: "mkdir 建目录 / create 建空文件 / rename 改名 / move 换目录 / remove 删除" }),
        path: Type.String({
          description: "目标路径，相对笔记库。mkdir 是要建的目录（如 工作/项目），create 是新文件名（带 .md 或 .excalidraw，缺目录自动建），rename/move/remove 是被操作的目录或文件",
        }),
        name: Type.Optional(Type.String({ description: "rename 的新名字；文件可以不写扩展名，会自动保留" })),
        dir: Type.Optional(Type.String({ description: "move 的目标目录，空字符串表示根目录" })),
        kind: Type.Optional(Type.Union([Type.Literal("note"), Type.Literal("board")], {
          description: "create 建哪种文件：note（.md，默认）或 board（.excalidraw）",
        })),
        recursive: Type.Optional(Type.Boolean({
          description: "remove 删一个非空目录时必须给 true；删单个文件或空目录不用给",
        })),
      }),
      async execute(_toolCallId, params) {
        const target = vaultPath(params.path, null, NOTES_MANAGE_TOOL);
        if (params.action === "mkdir") {
          await ensureDirectories(target);
          return textResult(`已创建目录 ${target}`, { action: params.action, path: target });
        }
        if (params.action === "create") {
          const kind = params.kind === "board" ? "board" : "note";
          const extension = kind === "board" ? BOARD_EXTENSION : NOTE_EXTENSION;
          const full = vaultPath(target, extension, NOTES_MANAGE_TOOL);
          const dir = parentOf(full);
          await ensureDirectories(dir);
          const node = await createItem(dir, full.split("/").pop()!, kind).catch((error: unknown) => {
            if (isExistsError(error)) throw new NotesError(`${full} 已存在`, 409);
            throw error;
          });
          return textResult(`已创建 ${node.path}`, { action: params.action, path: node.path });
        }
        if (params.action === "rename") {
          if (!params.name) throw new NotesError("rename 需要 name", 400);
          const next = await renameItem(target, params.name);
          return textResult(`${target} 重命名为 ${next}`, { action: params.action, path: next, from: target });
        }
        if (params.action === "move") {
          if (typeof params.dir !== "string") throw new NotesError("move 需要 dir，根目录传空字符串", 400);
          const next = await moveItem(target, params.dir.trim());
          return textResult(`${target} 移到 ${next}`, { action: params.action, path: next, from: target });
        }
        const node = await findNode(target);
        if (node?.type === "dir" && (node.children?.length ?? 0) > 0 && params.recursive !== true) {
          throw new NotesError(
            `${target} 里还有 ${node.children?.length} 项，确实要连里面的内容一起删就传 recursive=true`,
            400,
          );
        }
        await removeItem(target);
        return textResult(`已删除 ${target}`, { action: params.action, path: target });
      },
    }),
  ];
}

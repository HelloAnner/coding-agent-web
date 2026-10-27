import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { NotesBoardSettings } from "../types";
import { BOARD_EXTENSION, NOTE_EXTENSION, NotesError, createDirectory, createItem, readItem, writeItem } from "../files";
import { buildBoardScene } from "./board";

/**
 * The notes agent's own tools. `read` and `ls` come from pi; these two are what
 * the vault needs beyond files: a Markdown note, and a whiteboard built from
 * shapes rather than hand-written scene JSON. Both accept only vault-relative
 * paths, so the agent stays inside data/notes.
 */

export const NOTES_WRITE_TOOL = "notes_write";
export const NOTES_BOARD_TOOL = "notes_board";

function vaultPath(value: string, extension: string, tool: string): string {
  const target = value.trim().replace(/^\/+/, "");
  if (!target || target.split("/").some((part) => !part || part === ".." || part.startsWith("."))) {
    throw new NotesError("路径必须是笔记库内的相对路径", 400);
  }
  if (!target.toLowerCase().endsWith(extension)) {
    throw new NotesError(`${tool} 只写 ${extension} 文件，收到 ${target}`, 400);
  }
  return target;
}

function isExistsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "EEXIST" || (error instanceof NotesError && error.status === 409);
}

/** Create the missing parent directories of a vault path. */
async function ensureParentDirectories(target: string): Promise<string> {
  const segments = target.split("/").slice(0, -1);
  let dir = "";
  for (const segment of segments) {
    try {
      await createDirectory(dir, segment);
    } catch (error) {
      if (!isExistsError(error)) throw error;
    }
    dir = dir ? `${dir}/${segment}` : segment;
  }
  return dir;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
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
        const dir = await ensureParentDirectories(target);
        const name = target.split("/").pop()!;
        await createItem(dir, name, "note");
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
          const dir = await ensureParentDirectories(target);
          const name = target.split("/").pop()!;
          await createItem(dir, name, "board");
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
  ];
}

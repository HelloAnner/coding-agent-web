import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { watch as watchDirectory, type FSWatcher } from "node:fs";
import path from "node:path";
import type { NotesFileKind, NotesIndexRow, NotesNode } from "./types";
import { manualCreateBlock, manualStructureBlock, recordManualCreate, recordManualRelocate, recordManualRemove } from "./manual";

/**
 * The notes app's storage: one file per note or whiteboard under data/notes,
 * one directory per sidebar directory. Nothing else is stored, so the folder
 * tree on disk is the tree in the page.
 */

export const NOTE_EXTENSION = ".md";
export const BOARD_EXTENSION = ".excalidraw";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_NAME_LENGTH = 120;
const KIND_EXTENSIONS: Record<NotesFileKind, string> = {
  note: NOTE_EXTENSION,
  board: BOARD_EXTENSION,
};

export type { NotesFileKind, NotesNode } from "./types";

export class NotesError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Who is mutating the tree. The page is "manual" and wins: its operations are
 * recorded and refine what an agent may touch later. Agent tools pass "agent",
 * which is refused on anything the user changed by hand.
 */
export interface NotesMutateOptions {
  source?: "manual" | "agent";
}

/** The vault's root. data/ is outside git, so the notes are local files. */
export function notesRoot(): string {
  return path.resolve(process.env.CODING_AGENT_WEB_NOTES_DIR || path.join(process.cwd(), "data", "notes"));
}

function kindForName(name: string): NotesFileKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(NOTE_EXTENSION)) return "note";
  if (lower.endsWith(BOARD_EXTENSION)) return "board";
  return null;
}

function kindForPath(relative: string): NotesFileKind {
  const kind = kindForName(relative);
  if (!kind) throw new NotesError("只支持 Markdown 笔记和白板文件", 400);
  return kind;
}

/** A whiteboard path the view-state endpoints accept, normalized. */
export function normalizeBoardPath(relative: string): string {
  if (kindForPath(relative) !== "board") throw new NotesError("只支持白板文件", 400);
  return normalizeRelative(relative);
}

function joinRelative(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function parentOf(relative: string): string {
  return relative.split("/").slice(0, -1).join("/");
}

/** What the client sent as a path: relative, no heading dot, no traversal. */
function normalizeRelative(value: string): string {
  const raw = value.trim().replaceAll("\\", "/");
  if (!raw || raw === "/") return "";
  if (raw.startsWith("/")) throw new NotesError("路径无效", 400);
  const segments = raw.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
    throw new NotesError("路径无效", 400);
  }
  return segments.join("/");
}

/** An absolute path inside the notes root, or a rejection. */
function resolveInsideRoot(relative: string): string {
  const root = notesRoot();
  const target = path.resolve(root, normalizeRelative(relative));
  if (target !== root && !target.startsWith(root + path.sep)) throw new NotesError("路径无效", 400);
  return target;
}

/** The real path of an existing entry, refusing symlinks that leave the vault. */
async function resolveExisting(relative: string): Promise<string> {
  const root = notesRoot();
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  const lexical = resolveInsideRoot(relative);
  // The tree never shows a symlink; never follow one for reads or writes.
  if (normalizeRelative(relative)) {
    try {
      if ((await lstat(lexical)).isSymbolicLink()) throw new NotesError("路径无效", 400);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NotesError("文件或目录不存在", 404);
      throw error;
    }
  }
  const target = await realpath(lexical);
  if (target !== realRoot && !target.startsWith(realRoot + path.sep)) throw new NotesError("路径无效", 400);
  return target;
}

/** The real directory a new entry goes into. */
async function resolveParent(relative: string): Promise<string> {
  const parent = await resolveExisting(relative);
  const info = await stat(parent);
  if (!info.isDirectory()) throw new NotesError("目标不是目录", 400);
  return parent;
}

function cleanName(value: string): string {
  const name = value.trim();
  if (!name) throw new NotesError("名称不能为空", 400);
  if (name.length > MAX_NAME_LENGTH) throw new NotesError(`名称不能超过 ${MAX_NAME_LENGTH} 个字符`, 400);
  if (name.startsWith(".") || name.endsWith(".")) throw new NotesError("名称不能以点开头或结尾", 400);
  if (/[/\\:*?"<>|\u0000-\u001f]/.test(name)) throw new NotesError("名称不能包含 / \\ : * ? \" < > |", 400);
  return name;
}

function fileNameFor(name: string, kind: NotesFileKind): string {
  const clean = cleanName(name);
  const extension = KIND_EXTENSIONS[kind];
  return clean.toLowerCase().endsWith(extension) ? clean : `${clean}${extension}`;
}

export function notesErrorResponse(error: unknown): Response {
  const message = error instanceof NotesError
    ? error.message
    : (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "文件或目录不存在"
      : (error as NodeJS.ErrnoException)?.code === "EEXIST"
        ? "同名条目已存在"
        : (error as NodeJS.ErrnoException)?.code === "ENOTDIR"
          ? "目标不是目录"
          : "Notes 操作失败";
  const status = error instanceof NotesError
    ? error.status
    : (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? 404
      : (error as NodeJS.ErrnoException)?.code === "EEXIST"
        ? 409
        : 500;
  return Response.json({ error: message }, { status });
}

async function readDirectory(absolute: string, relative: string): Promise<NotesNode[]> {
  const entries = await readdir(absolute, { withFileTypes: true });
  const nodes: NotesNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const childRelative = joinRelative(relative, entry.name);
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: childRelative,
        type: "dir",
        children: await readDirectory(path.join(absolute, entry.name), childRelative),
      });
    } else if (entry.isFile()) {
      const kind = kindForName(entry.name);
      if (kind) nodes.push({ name: entry.name, path: childRelative, type: kind });
    }
  }
  nodes.sort((a, b) => {
    if (a.type === "dir" !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
  });
  return nodes;
}

/** Flatten the sidebar tree into the rows stored in the notes database. */
export function flattenNotesIndex(nodes: readonly NotesNode[], root: string): NotesIndexRow[] {
  const rows: NotesIndexRow[] = [];
  const walk = (list: readonly NotesNode[], parent: string) => {
    for (const node of list) {
      rows.push({
        path: node.path,
        parent,
        name: node.name,
        type: node.type,
        absPath: path.join(root, ...node.path.split("/")),
      });
      if (node.children) walk(node.children, node.path);
    }
  };
  walk(nodes, "");
  return rows;
}

export async function listTree(): Promise<NotesNode[]> {
  const root = notesRoot();
  await mkdir(root, { recursive: true });
  return readDirectory(root, "");
}

function initialBoard(): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "coding-agent-web",
    elements: [],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  }, null, 2);
}

export async function createDirectory(dir: string, name: string, options: NotesMutateOptions = {}): Promise<NotesNode> {
  const parent = await resolveParent(dir);
  const nodeName = cleanName(name);
  const relative = joinRelative(normalizeRelative(dir), nodeName);
  if (options.source === "agent") {
    const blocked = manualCreateBlock(relative);
    if (blocked) throw new NotesError(blocked, 409);
  } else {
    recordManualCreate(relative);
  }
  await mkdir(path.join(parent, nodeName));
  return { name: nodeName, path: relative, type: "dir", children: [] };
}

export async function createItem(dir: string, name: string, kind: NotesFileKind, options: NotesMutateOptions = {}): Promise<NotesNode> {
  const parent = await resolveParent(dir);
  const fileName = fileNameFor(name, kind);
  const relative = joinRelative(normalizeRelative(dir), fileName);
  if (options.source === "agent") {
    const blocked = manualCreateBlock(relative);
    if (blocked) throw new NotesError(blocked, 409);
  } else {
    recordManualCreate(relative);
  }
  const absolute = path.join(parent, fileName);
  // wx: creation fails if the name is taken, instead of truncating a note.
  await writeFile(absolute, kind === "board" ? initialBoard() : "", { encoding: "utf8", flag: "wx" });
  return { name: fileName, path: relative, type: kind };
}

export async function renameItem(relative: string, name: string, options: NotesMutateOptions = {}): Promise<string> {
  const normalized = normalizeRelative(relative);
  const source = await resolveExisting(normalized);
  const isDir = (await stat(source)).isDirectory();
  // Folders keep the name as typed; files get their extension back.
  const fileName = isDir ? cleanName(name) : fileNameFor(name, kindForPath(normalized));
  const target = path.join(path.dirname(source), fileName);
  const next = joinRelative(parentOf(normalized), fileName);
  if (target === source) return normalized;
  if (options.source === "agent") {
    const blocked = manualStructureBlock(normalized);
    if (blocked) throw new NotesError(blocked, 409);
  }
  try {
    await stat(target);
    throw new NotesError("同名条目已存在", 409);
  } catch (error) {
    if (error instanceof NotesError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(source, target);
  if (options.source !== "agent") recordManualRelocate(normalized, next, isDir ? "dir" : kindForPath(normalized));
  return next;
}

/** Move a note, board or directory into another directory. */
export async function moveItem(relative: string, dir: string, options: NotesMutateOptions = {}): Promise<string> {
  const normalized = normalizeRelative(relative);
  const source = await resolveExisting(normalized);
  const isDir = (await stat(source)).isDirectory();
  if (!isDir) kindForPath(normalized);
  const destination = await resolveParent(dir);
  if (path.dirname(source) === destination) return normalized;
  const fileName = path.basename(source);
  const target = path.join(destination, fileName);
  const next = joinRelative(normalizeRelative(dir), fileName);
  if (options.source === "agent") {
    const blocked = manualStructureBlock(normalized);
    if (blocked) throw new NotesError(blocked, 409);
  }
  try {
    await lstat(target);
    throw new NotesError("同名条目已存在", 409);
  } catch (error) {
    if (error instanceof NotesError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(source, target);
  if (options.source !== "agent") recordManualRelocate(normalized, next, isDir ? "dir" : kindForPath(normalized));
  return next;
}

/** Delete a note, board or directory (a directory takes its contents). */
export async function removeItem(relative: string, options: NotesMutateOptions = {}): Promise<void> {
  const normalized = normalizeRelative(relative);
  if (!normalized) throw new NotesError("不能删除根目录", 400);
  const absolute = await resolveExisting(normalized);
  const realRoot = await realpath(notesRoot());
  if (absolute === realRoot) throw new NotesError("不能删除根目录", 400);
  if (options.source === "agent") {
    const blocked = manualStructureBlock(normalized);
    if (blocked) throw new NotesError(blocked, 409);
  }
  const isDir = (await stat(absolute)).isDirectory();
  await rm(absolute, { recursive: true });
  if (options.source !== "agent") recordManualRemove(normalized, isDir ? "dir" : kindForPath(normalized));
}

export async function readItem(relative: string): Promise<{ path: string; kind: NotesFileKind; content: string }> {
  const kind = kindForPath(relative);
  const absolute = await resolveExisting(relative);
  const info = await stat(absolute);
  if (!info.isFile()) throw new NotesError("目标不是文件", 400);
  if (info.size > MAX_FILE_BYTES) throw new NotesError("文件过大", 413);
  return { path: normalizeRelative(relative), kind, content: await readFile(absolute, "utf8") };
}

export async function writeItem(relative: string, content: string): Promise<void> {
  const kind = kindForPath(relative);
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new NotesError("文件过大", 413);
  if (kind === "board") {
    try {
      JSON.parse(content);
    } catch {
      throw new NotesError("白板内容不是有效的 JSON", 400);
    }
  }
  const absolute = await resolveExisting(relative);
  const info = await stat(absolute);
  if (!info.isFile()) throw new NotesError("目标不是文件", 400);
  await writeFile(absolute, content, "utf8");
}

/** GET /api/notes: the whole tree. */
export async function listNotesTree(): Promise<Response> {
  try {
    return Response.json({ root: notesRoot(), tree: await listTree() });
  } catch (error) {
    return notesErrorResponse(error);
  }
}

/** POST /api/notes: create, mkdir, rename, move or remove. */
export async function mutateNotes(request: Request): Promise<Response> {
  try {
    const body = await request.json() as {
      action?: unknown;
      dir?: unknown;
      path?: unknown;
      name?: unknown;
      kind?: unknown;
    };
    const text = (value: unknown) => typeof value === "string" ? value : "";
    if (body.action === "mkdir") {
      return Response.json({ node: await createDirectory(text(body.dir), text(body.name)) }, { status: 201 });
    }
    if (body.action === "create") {
      const kind = body.kind === "board" ? "board" : body.kind === "note" ? "note" : null;
      if (!kind) return Response.json({ error: "未知的类型" }, { status: 400 });
      return Response.json({ node: await createItem(text(body.dir), text(body.name), kind) }, { status: 201 });
    }
    if (body.action === "rename") {
      return Response.json({ path: await renameItem(text(body.path), text(body.name)) });
    }
    if (body.action === "move") {
      return Response.json({ path: await moveItem(text(body.path), text(body.dir)) });
    }
    if (body.action === "remove") {
      await removeItem(text(body.path));
      return Response.json({ ok: true });
    }
    return Response.json({ error: "未知的操作" }, { status: 400 });
  } catch (error) {
    return notesErrorResponse(error);
  }
}

/** GET /api/notes/file?path= */
export async function readNotesFile(request: Request): Promise<Response> {
  try {
    const relative = new URL(request.url).searchParams.get("path") ?? "";
    return Response.json(await readItem(relative));
  } catch (error) {
    return notesErrorResponse(error);
  }
}

/** PUT /api/notes/file?path= */
export async function writeNotesFile(request: Request): Promise<Response> {
  try {
    const relative = new URL(request.url).searchParams.get("path") ?? "";
    const body = await request.json() as { content?: unknown };
    if (typeof body.content !== "string") return Response.json({ error: "缺少 content" }, { status: 400 });
    await writeItem(relative, body.content);
    return Response.json({ ok: true });
  } catch (error) {
    return notesErrorResponse(error);
  }
}

/** A save is several events (write, rename, temp file); tell the tree once. */
const WATCH_COALESCE_MS = 200;

/**
 * GET /api/notes/watch: every change under the vault root, as it happens.
 * The tree is files on disk, so an agent writing a note has no other way to
 * say "something appeared".
 */
export async function watchNotes(): Promise<Response> {
  const root = notesRoot();
  await mkdir(root, { recursive: true });
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Which files changed in the window: the tree reloads, the board filters to
  // its own path. A platform that reports no name leaves the list unknown.
  let changed = new Set<string>();
  let unknown = false;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    try { watcher?.close(); } catch { /* already closed */ }
    watcher = null;
  };
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(new TextEncoder().encode(payload));
        } catch {
          // client disconnected
        }
      };
      try {
        watcher = watchDirectory(root, { recursive: true }, (_event, filename) => {
          if (filename) changed.add(String(filename).replaceAll("\\", "/"));
          else unknown = true;
          if (timer) return;
          timer = setTimeout(() => {
            timer = null;
            const paths = unknown ? null : [...changed];
            changed = new Set();
            unknown = false;
            send("change", { paths, at: Date.now() });
          }, WATCH_COALESCE_MS);
        });
        watcher.on("error", () => {
          stop();
          try { controller.close(); } catch { /* already closed */ }
        });
        // The client reads the tree once this arrives, so it is sent only
        // after the watcher exists: nothing changes unseen between the two.
        send("connected", { root });
      } catch {
        send("error", { message: "无法监听笔记目录" });
        controller.close();
      }
    },
    cancel() {
      stop();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

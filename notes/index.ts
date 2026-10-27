import { flattenNotesIndex, listTree, notesErrorResponse, notesRoot, normalizeBoardPath } from "./files";
import { readBoardView, readNotesMentions, replaceNotesIndex, writeBoardView } from "./db";
import type { NotesBoardView, NotesIndexRow, NotesMention, NotesNode } from "./types";

/** Read the vault and rebuild its database index. */
export async function syncNotesIndex(): Promise<{ root: string; tree: NotesNode[]; rows: NotesIndexRow[] }> {
  const root = notesRoot();
  const tree = await listTree();
  const rows = flattenNotesIndex(tree, root);
  replaceNotesIndex(root, rows);
  return { root, tree, rows };
}

function fallbackMentions(rows: readonly NotesIndexRow[]): NotesMention[] {
  return rows
    .filter((row) => row.type !== "dir")
    .map((row) => ({ name: row.name, path: row.path, absPath: row.absPath, kind: row.type as NotesMention["kind"] }));
}

/** GET /api/notes: the tree, and the same tree written to the index. */
export async function listNotesTreeIndexed(): Promise<Response> {
  try {
    const root = notesRoot();
    const tree = await listTree();
    try {
      replaceNotesIndex(root, flattenNotesIndex(tree, root));
    } catch {
      // The database is an index, not the source: the tree still works.
    }
    return Response.json({ root, tree });
  } catch (error) {
    return notesErrorResponse(error);
  }
}

/** GET /api/notes/mentions: files the coding composer can @, from the index. */
export async function listNotesMentions(): Promise<Response> {
  try {
    const root = notesRoot();
    const tree = await listTree();
    const rows = flattenNotesIndex(tree, root);
    try {
      replaceNotesIndex(root, rows);
      return Response.json({ root, notes: readNotesMentions() });
    } catch {
      return Response.json({ root, notes: fallbackMentions(rows) });
    }
  } catch (error) {
    return notesErrorResponse(error);
  }
}

/** GET /api/notes/view: where a whiteboard was left (null on first open). */
export async function readNotesBoardView(request: Request): Promise<Response> {
  try {
    const path = normalizeBoardPath(new URL(request.url).searchParams.get("path") ?? "");
    return Response.json({ view: readBoardView(path) });
  } catch (error) {
    return notesErrorResponse(error);
  }
}

/** PUT /api/notes/view: remember pan and zoom for the next open. */
export async function saveNotesBoardView(request: Request): Promise<Response> {
  try {
    const path = normalizeBoardPath(new URL(request.url).searchParams.get("path") ?? "");
    const body = await request.json() as Partial<NotesBoardView>;
    const view = { scrollX: Number(body.scrollX), scrollY: Number(body.scrollY), zoom: Number(body.zoom) };
    if (!Number.isFinite(view.scrollX) || !Number.isFinite(view.scrollY) || !(view.zoom > 0)) {
      return Response.json({ error: "白板视图无效" }, { status: 400 });
    }
    writeBoardView(path, view);
    return Response.json({ ok: true });
  } catch (error) {
    return notesErrorResponse(error);
  }
}

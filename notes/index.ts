import { flattenNotesIndex, listTree, notesErrorResponse, notesRoot } from "./files";
import { readNotesMentions, replaceNotesIndex } from "./db";
import type { NotesIndexRow, NotesMention, NotesNode } from "./types";

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

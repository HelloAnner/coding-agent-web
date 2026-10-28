import { notesDatabase } from "./db";
import type { NotesFileKind } from "./types";

/**
 * The user's own tree operations, remembered across runs.
 *
 * The page writes a row every time the user renames, moves or deletes
 * something. The agent reads those rows through `notes_ls` and is refused by
 * the mutators in files.ts, so a scheduled run cannot undo — or recreate — what
 * the user did by hand. The filesystem stays the source of truth for content;
 * this table only records intent.
 */

export type NotesManualOp = "remove" | "rename" | "move";

export interface NotesManualMark {
  /** Current path; for a delete, the path that was removed (a tombstone). */
  path: string;
  op: NotesManualOp;
  /** Where it was before a rename or move; null for a delete. */
  fromPath: string | null;
  kind: NotesFileKind | "dir";
  at: number;
}

interface ManualRow {
  path: string;
  op: NotesManualOp;
  from_path: string | null;
  kind: NotesFileKind | "dir";
  at: number;
}

function under(path: string, ancestor: string): boolean {
  return path.startsWith(`${ancestor}/`);
}

export function readManualMarks(): NotesManualMark[] {
  const rows = notesDatabase()
    .prepare("SELECT path, op, from_path, kind, at FROM notes_manual_ops ORDER BY at")
    .all() as unknown as ManualRow[];
  return rows.map((row) => ({
    path: row.path,
    op: row.op,
    fromPath: row.from_path,
    kind: row.kind,
    at: row.at,
  }));
}

function upsert(path: string, op: NotesManualOp, fromPath: string | null, kind: NotesManualMark["kind"], at = Date.now()): void {
  notesDatabase()
    .prepare(
      `INSERT INTO notes_manual_ops (path, op, from_path, kind, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET op = excluded.op, from_path = excluded.from_path, kind = excluded.kind, at = excluded.at`,
    )
    .run(path, op, fromPath, kind, at);
}

/** The user deleted this path: keep a tombstone so the agent never rebuilds it. */
export function recordManualRemove(path: string, kind: NotesManualMark["kind"]): void {
  const db = notesDatabase();
  db.prepare("DELETE FROM notes_manual_ops WHERE path = ? OR path LIKE ?").run(path, `${path}/%`);
  upsert(path, "remove", null, kind);
}

/** The user renamed or moved something: the new path is authoritative. */
export function recordManualRelocate(from: string, to: string, kind: NotesManualMark["kind"]): void {
  if (from === to) return;
  const db = notesDatabase();
  // A directory carries its marks: everything under `from` moves to `to`.
  db.prepare("UPDATE notes_manual_ops SET path = ? || substr(path, ?) WHERE path LIKE ?")
    .run(to, from.length + 1, `${from}/%`);
  upsert(to, kind === "dir" ? "move" : "rename", from, kind);
}

/** The user created or restored an entry: drop the tombstones it supersedes. */
export function recordManualCreate(path: string): void {
  notesDatabase().prepare("DELETE FROM notes_manual_ops WHERE path = ? OR path LIKE ?").run(path, `${path}/%`);
}

/**
 * Why the agent may not change this path's structure (rename, move, delete),
 * or null when it is free. A marked descendant also locks its folders: moving
 * the folder would move the user's entry.
 */
export function manualStructureBlock(path: string): string | null {
  for (const mark of readManualMarks()) {
    if (mark.path === path) {
      return mark.op === "remove"
        ? `「${path}」用户已经手动删除，不要重建`
        : `「${path}」用户手动${mark.op === "move" ? "移动" : "改名"}过，不要改动它的名字和位置`;
    }
    if (under(path, mark.path)) {
      return mark.op === "remove"
        ? `「${mark.path}」被用户手动删除，它下面的路径不要重建`
        : `「${mark.path}」是用户手动改过的条目，不要动它所在的目录`;
    }
    if (under(mark.path, path)) {
      return `「${path}」下面有用户手动改过的条目（${mark.path}），不要动这个目录`;
    }
  }
  return null;
}

/** Why the agent may not create this path, or null when it is free. */
export function manualCreateBlock(path: string): string | null {
  for (const mark of readManualMarks()) {
    if (mark.op !== "remove") continue;
    if (mark.path === path || under(path, mark.path)) {
      return `「${mark.path}」用户手动删除过，不要重建；需要恢复请让用户自己操作`;
    }
  }
  return null;
}

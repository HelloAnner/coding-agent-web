import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NotesBoardView, NotesFileKind, NotesIndexRow, NotesMention } from "./types";

/**
 * The notes index in the app's SQLite database: one row per directory, note
 * and whiteboard, with the absolute path a coding harness can read. The
 * filesystem stays the source of truth; the table is rebuilt from a tree scan.
 */

let open: { file: string; db: DatabaseSync } | null = null;

function database(): DatabaseSync {
  const file = process.env.CODING_AGENT_WEB_DATA || path.join(homedir(), ".coding-agent-web", "data.db");
  if (open?.file === file) return open.db;
  open?.db.close();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try { chmodSync(file, 0o600); } catch { /* In-memory databases have no file. */ }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS notes_entries (
      path TEXT PRIMARY KEY,
      parent TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      abs_path TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_entries_parent ON notes_entries(parent);
    CREATE TABLE IF NOT EXISTS notes_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes_board_views (
      path TEXT PRIMARY KEY,
      scroll_x REAL NOT NULL,
      scroll_y REAL NOT NULL,
      zoom REAL NOT NULL
    );
  `);
  open = { file, db };
  return db;
}

/** Replace the whole index in one transaction: the tree is the source. */
export function replaceNotesIndex(root: string, rows: readonly NotesIndexRow[]): void {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM notes_entries");
    const insert = db.prepare(
      "INSERT INTO notes_entries (path, parent, name, type, abs_path) VALUES (?, ?, ?, ?, ?)",
    );
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.path)) continue;
      seen.add(row.path);
      insert.run(row.path, row.parent, row.name, row.type, row.absPath);
    }
    const meta = db.prepare(
      "INSERT INTO notes_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    meta.run("root", root);
    meta.run("synced_at", String(Date.now()));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function readNotesIndexRows(): NotesIndexRow[] {
  const rows = database()
    .prepare("SELECT path, parent, name, type, abs_path FROM notes_entries ORDER BY path")
    .all() as { path: string; parent: string; name: string; type: NotesFileKind; abs_path: string }[];
  return rows.map((row) => ({
    path: row.path,
    parent: row.parent,
    name: row.name,
    type: row.type,
    absPath: row.abs_path,
  }));
}

export function readNotesMentions(): NotesMention[] {
  return readNotesIndexRows()
    .filter((row) => row.type !== "dir")
    .map((row) => ({
      name: row.name,
      path: row.path,
      absPath: row.absPath,
      kind: row.type as NotesFileKind,
    }));
}

export function readNotesRoot(): string | null {
  const row = database().prepare("SELECT value FROM notes_meta WHERE key = 'root'").get() as { value: string } | undefined;
  return row?.value ?? null;
}

/** The pan and zoom a whiteboard was last left at, or null on first open. */
export function readBoardView(relative: string): NotesBoardView | null {
  const row = database()
    .prepare("SELECT scroll_x, scroll_y, zoom FROM notes_board_views WHERE path = ?")
    .get(relative) as { scroll_x: number; scroll_y: number; zoom: number } | undefined;
  return row ? { scrollX: row.scroll_x, scrollY: row.scroll_y, zoom: row.zoom } : null;
}

export function writeBoardView(relative: string, view: NotesBoardView): void {
  database()
    .prepare(
      `INSERT INTO notes_board_views (path, scroll_x, scroll_y, zoom) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET scroll_x = excluded.scroll_x, scroll_y = excluded.scroll_y, zoom = excluded.zoom`,
    )
    .run(relative, view.scrollX, view.scrollY, view.zoom);
}

export function closeNotesDb(): void {
  open?.db.close();
  open = null;
}

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
    CREATE TABLE IF NOT EXISTS notes_session_ingest (
      session_id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      project TEXT NOT NULL,
      modified TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      processed_at INTEGER NOT NULL
    );
    -- What the user did in the tree by hand: the agent may change content but
    -- must not undo these. A remove row is also the "do not recreate" tombstone.
    CREATE TABLE IF NOT EXISTS notes_manual_ops (
      path TEXT PRIMARY KEY,
      op TEXT NOT NULL,
      from_path TEXT,
      kind TEXT NOT NULL,
      at INTEGER NOT NULL
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

/** One Coding session the notes agent has already read, at which version. */
export interface NotesIngestRow {
  sessionId: string;
  /** Absolute path of the harness session file. */
  path: string;
  /** Project root the session belongs to (the Coding sidebar's group). */
  project: string;
  /** The session's last-message time, as read from the catalogue. */
  modified: string;
  messageCount: number;
  processedAt: number;
}

/** What every session the notes agent has already ingested looks like. */
export function readIngestRows(): Map<string, NotesIngestRow> {
  const rows = database()
    .prepare("SELECT session_id, path, project, modified, message_count, processed_at FROM notes_session_ingest")
    .all() as { session_id: string; path: string; project: string; modified: string; message_count: number; processed_at: number }[];
  return new Map(rows.map((row) => [row.session_id, {
    sessionId: row.session_id,
    path: row.path,
    project: row.project,
    modified: row.modified,
    messageCount: row.message_count,
    processedAt: row.processed_at,
  }]));
}

/** Remember the version of each session a run has just read. */
export function writeIngestRows(rows: readonly Omit<NotesIngestRow, "processedAt">[]): void {
  if (!rows.length) return;
  const db = database();
  const insert = db.prepare(
    `INSERT INTO notes_session_ingest (session_id, path, project, modified, message_count, processed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       path = excluded.path,
       project = excluded.project,
       modified = excluded.modified,
       message_count = excluded.message_count,
       processed_at = excluded.processed_at`,
  );
  const at = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) insert.run(row.sessionId, row.path, row.project, row.modified, row.messageCount, at);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** The open handle, for the modules that keep their own tables here. */
export function notesDatabase(): DatabaseSync {
  return database();
}

export function closeNotesDb(): void {
  open?.db.close();
  open = null;
}

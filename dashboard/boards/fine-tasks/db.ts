import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import type { FineTask } from "./types";

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
    CREATE TABLE IF NOT EXISTS fine_tasks (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fine_task_sync (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_synced_at INTEGER,
      error TEXT
    );
  `);
  const columns = db.prepare("PRAGMA table_info(fine_tasks)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "completed")) {
    db.exec("ALTER TABLE fine_tasks ADD COLUMN completed INTEGER NOT NULL DEFAULT 0");
  }
  open = { file, db };
  return db;
}

export function readFineTasks(): { tasks: FineTask[]; lastSyncedAt: number | null; error: string | null } {
  const db = database();
  const rows = db.prepare("SELECT payload FROM fine_tasks WHERE completed = 0 ORDER BY id").all() as { payload: string }[];
  const sync = db.prepare("SELECT last_synced_at, error FROM fine_task_sync WHERE id = 1").get() as { last_synced_at: number | null; error: string | null } | undefined;
  return { tasks: rows.map((row) => JSON.parse(row.payload) as FineTask), lastSyncedAt: sync?.last_synced_at ?? null, error: sync?.error ?? null };
}

// Replace only after the complete remote snapshot succeeds; partial failures keep the cache.
export function saveFineTasks(tasks: FineTask[], now = Date.now()): void {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const previous = db.prepare("SELECT id, payload FROM fine_tasks WHERE completed = 0").all() as { id: string; payload: string }[];
    const activeIds = new Set(tasks.map((task) => task.id));
    const complete = db.prepare("UPDATE fine_tasks SET completed = 1, payload = ?, synced_at = ? WHERE id = ?");
    for (const row of previous) {
      if (!activeIds.has(row.id)) complete.run(JSON.stringify({ ...JSON.parse(row.payload), status: "完成" }), now, row.id);
    }
    const insert = db.prepare("INSERT INTO fine_tasks (id, payload, completed, synced_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, completed = excluded.completed, synced_at = excluded.synced_at");
    const seen = new Set<string>();
    for (const task of tasks) {
      if (seen.has(task.id)) throw new Error("Duplicate task identity");
      seen.add(task.id);
      insert.run(task.id, JSON.stringify(task.completed ? { ...task, status: "完成" } : task), task.completed ? 1 : 0, now);
    }
    db.prepare("INSERT INTO fine_task_sync (id, last_synced_at, error) VALUES (1, ?, NULL) ON CONFLICT(id) DO UPDATE SET last_synced_at = excluded.last_synced_at, error = NULL").run(now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveFineTaskError(error: string): void {
  database().prepare("INSERT INTO fine_task_sync (id, error) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET error = excluded.error").run(error);
}

export function closeFineTaskDb(): void {
  open?.db.close();
  open = null;
}

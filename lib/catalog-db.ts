import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionInfo } from "./types";

/**
 * The web's own index. One sqlite file, not a scan of any harness.
 * `CODING_AGENT_WEB_DATA` overrides `~/.coding-agent-web/data.db` (tests).
 */
export function catalogDbPath(): string {
  return process.env.CODING_AGENT_WEB_DATA || path.join(homedir(), ".coding-agent-web", "data.db");
}

let open: { path: string; db: DatabaseSync } | null = null;
let readOpen: { path: string; db: DatabaseSync } | null = null;

function database(file = catalogDbPath()): DatabaseSync {
  if (open?.path === file) return open.db;
  open?.db.close();
  readOpen?.db.close();
  readOpen = null;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try { chmodSync(file, 0o600); } catch { /* :memory: has nothing to chmod */ }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS directories (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      directory_id TEXT NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
      harness TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      session_path TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_by_directory ON sessions(directory_id, updated_at);
    CREATE TABLE IF NOT EXISTS project_preferences (
      directory_id TEXT PRIMARY KEY REFERENCES directories(id) ON DELETE CASCADE,
      harness TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
  `);
  open = { path: file, db };
  return db;
}

/** Reads only: opening WAL would write, which a read-only data file cannot allow. */
function readDatabase(file: string): DatabaseSync {
  if (readOpen?.path === file) return readOpen.db;
  readOpen?.db.close();
  const db = new DatabaseSync(file, { readOnly: true });
  readOpen = { path: file, db };
  return db;
}

/** Close the cached handle so tests can point at another file. */
export function closeCatalogDb(): void {
  open?.db.close();
  open = null;
  readOpen?.db.close();
  readOpen = null;
}

export interface CatalogSessionInput {
  id?: string;
  cwd: string;
  harness: string;
  provider?: string;
  model?: string;
  title?: string;
  sessionPath?: string;
}

interface SessionRow {
  id: string;
  cwd: string;
  harness: string;
  provider: string;
  model: string;
  title: string;
  session_path: string;
  created_at: number;
  updated_at: number;
}

function directoryId(db: DatabaseSync, cwd: string, now: number): string {
  const found = db.prepare("SELECT id FROM directories WHERE path = ?").get(cwd) as { id: string } | undefined;
  if (found) return found.id;
  const id = randomUUID();
  db.prepare("INSERT INTO directories (id, path, name, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    cwd,
    path.basename(cwd) || cwd,
    now,
  );
  return id;
}

/** A row already belongs to another harness. The index does not retarget it. */
export class CatalogHarnessLockedError extends Error {
  constructor() {
    super("A session keeps its harness");
    this.name = "CatalogHarnessLockedError";
  }
}

/** The harness, provider and model a project started its last chat with. */
export interface ProjectPreference {
  harness: string;
  provider: string;
  model: string;
}

/** One preference per project folder. Unknown folders have none. */
export function readProjectPreference(cwd: string, file = catalogDbPath()): ProjectPreference | null {
  // A read must not create the web's data directory on a machine that has never written it.
  if (!existsSync(file)) return null;
  try {
    const db = readDatabase(file);
    const row = db.prepare(`
      SELECT project_preferences.harness, project_preferences.provider, project_preferences.model
      FROM project_preferences
      JOIN directories ON directories.id = project_preferences.directory_id
      WHERE directories.path = ?
    `).get(cwd.trim()) as ProjectPreference | undefined;
    return row ? { harness: row.harness, provider: row.provider, model: row.model } : null;
  } catch {
    // An older index without the table has no preference yet; the next write adds it.
    return null;
  }
}

/** Replace the project's preference. The folder row is created when needed. */
export function writeProjectPreference(
  cwd: string,
  preference: ProjectPreference,
  file = catalogDbPath(),
): void {
  const directory = cwd.trim();
  if (!path.isAbsolute(directory)) throw new Error("cwd must be an absolute path");
  const harness = preference.harness.trim();
  if (!harness) throw new Error("harness is required");
  const db = database(file);
  const now = Date.now();
  db.prepare(`
    INSERT INTO project_preferences (directory_id, harness, provider, model, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(directory_id) DO UPDATE SET
      harness = excluded.harness,
      provider = excluded.provider,
      model = excluded.model,
      updated_at = excluded.updated_at
  `).run(
    directoryId(db, directory, now),
    harness,
    preference.provider.trim(),
    preference.model.trim(),
    now,
  );
}

/** Insert or replace the index row for one conversation. */
export function upsertCatalogSession(input: CatalogSessionInput, file = catalogDbPath()): string {
  const cwd = input.cwd.trim();
  if (!path.isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
  const harness = input.harness.trim();
  if (!harness) throw new Error("harness is required");
  const db = database(file);
  const now = Date.now();
  const id = input.id?.trim() || randomUUID();
  const existing = db.prepare("SELECT harness FROM sessions WHERE id = ?").get(id) as { harness: string } | undefined;
  if (existing && existing.harness !== harness) throw new CatalogHarnessLockedError();
  const directory = directoryId(db, cwd, now);
  db.prepare(`
    INSERT INTO sessions (id, directory_id, harness, provider, model, title, session_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      directory_id = excluded.directory_id,
      harness = excluded.harness,
      provider = excluded.provider,
      model = excluded.model,
      title = excluded.title,
      session_path = excluded.session_path,
      updated_at = excluded.updated_at
  `).run(
    id,
    directory,
    harness,
    input.provider ?? "",
    input.model ?? "",
    input.title ?? "",
    input.sessionPath ?? "",
    now,
    now,
  );
  return id;
}

export function updateCatalogSession(
  id: string,
  patch: { harness?: string; provider?: string; model?: string; title?: string; sessionPath?: string; cwd?: string },
  file = catalogDbPath(),
): boolean {
  const db = database(file);
  const existing = db.prepare("SELECT id, directory_id, harness FROM sessions WHERE id = ?").get(id) as { id: string; directory_id: string; harness: string } | undefined;
  if (!existing) return false;
  if (patch.harness && patch.harness !== existing.harness) throw new CatalogHarnessLockedError();
  const now = Date.now();
  const directory = patch.cwd ? directoryId(db, patch.cwd, now) : existing.directory_id;
  db.prepare(`
    UPDATE sessions SET
      directory_id = ?,
      harness = COALESCE(?, harness),
      provider = COALESCE(?, provider),
      model = COALESCE(?, model),
      title = COALESCE(?, title),
      session_path = COALESCE(?, session_path),
      updated_at = ?
    WHERE id = ?
  `).run(
    directory,
    patch.harness ?? null,
    patch.provider ?? null,
    patch.model ?? null,
    patch.title ?? null,
    patch.sessionPath ?? null,
    now,
    id,
  );
  return true;
}

export function deleteCatalogSession(id: string, file = catalogDbPath()): boolean {
  const db = database(file);
  const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

function rows(file = catalogDbPath()): SessionRow[] {
  const db = database(file);
  return db.prepare(`
    SELECT sessions.id, directories.path AS cwd, sessions.harness, sessions.provider, sessions.model,
           sessions.title, sessions.session_path, sessions.created_at, sessions.updated_at
    FROM sessions
    JOIN directories ON directories.id = sessions.directory_id
    ORDER BY sessions.updated_at DESC
  `).all() as unknown as SessionRow[];
}

/** One indexed session. Null for an id the index has never seen. */
export interface CatalogSession {
  id: string;
  cwd: string;
  harness: string;
  provider: string;
  model: string;
  title: string;
  sessionPath: string;
}

export function readCatalogSession(id: string, file = catalogDbPath()): CatalogSession | null {
  const db = database(file);
  const row = db.prepare(`
    SELECT sessions.id, directories.path AS cwd, sessions.harness, sessions.provider, sessions.model,
           sessions.title, sessions.session_path
    FROM sessions
    JOIN directories ON directories.id = sessions.directory_id
    WHERE sessions.id = ?
  `).get(id) as SessionRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    cwd: row.cwd,
    harness: row.harness,
    provider: row.provider,
    model: row.model,
    title: row.title,
    sessionPath: row.session_path,
  };
}

/** Sidebar rows. Empty until something is written here. Does not read a harness. */
export function listCatalogSessionInfos(file = catalogDbPath()): { sessions: SessionInfo[]; sessionListVersion: number } {
  const listed = rows(file);
  let version = 0;
  const sessions: SessionInfo[] = listed.map((row) => {
    if (row.updated_at > version) version = row.updated_at;
    const stamp = new Date(row.created_at).toISOString();
    return {
      id: row.id,
      path: row.session_path,
      cwd: row.cwd,
      name: row.title || undefined,
      created: stamp,
      modified: new Date(row.updated_at).toISOString(),
      messageCount: 0,
      firstMessage: "",
      projectRoot: row.cwd,
      projectKey: row.cwd,
      harness: row.harness,
      modelProvider: row.provider || undefined,
      modelId: row.model || undefined,
    };
  });
  return { sessions, sessionListVersion: version };
}

/** Max `updated_at` of the index. The sidebar poll reloads when this moves. */
export function catalogListVersion(file = catalogDbPath()): number {
  const db = database(file);
  const row = db.prepare("SELECT COALESCE(MAX(updated_at), 0) AS version FROM sessions").get() as { version: number } | undefined;
  return Number(row?.version) || 0;
}

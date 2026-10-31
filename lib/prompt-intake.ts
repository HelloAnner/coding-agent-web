// Every prompt the browser hands over is written to disk before the harness
// sees it: text plus the image files, in one sqlite row. The run itself stays
// where it already is — in the harness, which keeps going when the page or the
// machine goes away. This journal is only the recovery record for the window
// where the message has been accepted but is not yet in the session history
// (a run in flight, a queued steer, a restart in between).
//
//   POST prompt  ->  intake row (open)  ->  harness queue  ->  user message in
//                                                                 the JSONL
//                                        \__ crash here __/   |
//                                            resume at boot     -> close row
//
// A row closes when the same text shows up in the session file, so a resume can
// never duplicate a message the harness already delivered.

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getSessionEntries, resolveSessionPath } from "./session-reader";
import { startRpcSession } from "./rpc-manager";

export type IntakeKind = "prompt" | "steer" | "followUp";

export interface IntakeImage {
  data: string;
  mimeType: string;
}

interface IntakeFile {
  file: string;
  mimeType: string;
}

export interface IntakeRow {
  id: string;
  sessionId: string;
  kind: IntakeKind;
  text: string;
  files: IntakeFile[];
  createdAt: number;
  handedAt: number | null;
  attempts: number;
}

export interface IntakeCommand {
  type: "prompt";
  message: string;
  images?: { type: "image"; data: string; mimeType: string }[];
  [key: string]: unknown;
}

const MAX_RESUME_ATTEMPTS = 3;

/** `CODING_AGENT_WEB_INTAKE_DIR` points the journal (and its image files) elsewhere, for tests. */
export function intakeRoot(): string {
  return process.env.CODING_AGENT_WEB_INTAKE_DIR || path.join(homedir(), ".coding-agent-web", "intake");
}

let open: { root: string; db: DatabaseSync } | null = null;

function database(root = intakeRoot()): DatabaseSync {
  if (open?.root === root) return open.db;
  open?.db.close();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, "intake.db");
  const db = new DatabaseSync(file);
  try { chmodSync(file, 0o600); } catch { /* :memory: has nothing to chmod */ }
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS intake (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      files TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      handed_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS intake_open ON intake(session_id, created_at);
  `);
  open = { root, db };
  return db;
}

/** Close the cached handle so tests can point at another directory. */
export function closeIntakeDb(): void {
  open?.db.close();
  open = null;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function filesDir(id: string): string {
  return path.join(intakeRoot(), "files", id);
}

function removeFiles(id: string): void {
  rmSync(filesDir(id), { recursive: true, force: true });
}

/**
 * Store an accepted prompt. Returns null when there is nothing to store, which
 * is also how slash commands and `!` shell lines stay out of the journal: they
 * run inside the harness and must never be replayed.
 */
export function recordIntake(input: {
  sessionId: string;
  kind: IntakeKind;
  text: string;
  images?: IntakeImage[];
}): IntakeRow | null {
  const text = typeof input.text === "string" ? input.text : "";
  const images = (input.images ?? []).filter((image) => image && typeof image.data === "string");
  if (!text.trim() && images.length === 0) return null;
  if (!text.trim() && input.kind !== "prompt") return null;

  const id = randomUUID();
  const dir = filesDir(id);
  const files: IntakeFile[] = [];
  if (images.length > 0) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    images.forEach((image, index) => {
      const file = path.join(dir, `${index}.${EXTENSIONS[image.mimeType] ?? "bin"}`);
      writeFileSync(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
      files.push({ file, mimeType: image.mimeType });
    });
  }

  const now = Date.now();
  database().prepare(
    "INSERT INTO intake (id, session_id, kind, text, files, created_at, handed_at, attempts) VALUES (?, ?, ?, ?, ?, ?, NULL, 0)",
  ).run(id, input.sessionId, input.kind, text, JSON.stringify(files), now);
  return { id, sessionId: input.sessionId, kind: input.kind, text, files, createdAt: now, handedAt: null, attempts: 0 };
}

function rowFrom(record: Record<string, unknown>): IntakeRow {
  let files: IntakeFile[] = [];
  try {
    const parsed = JSON.parse(String(record.files ?? "[]"));
    if (Array.isArray(parsed)) files = parsed as IntakeFile[];
  } catch {
    files = [];
  }
  return {
    id: String(record.id),
    sessionId: String(record.session_id),
    kind: String(record.kind) as IntakeKind,
    text: String(record.text ?? ""),
    files,
    createdAt: Number(record.created_at),
    handedAt: record.handed_at === null || record.handed_at === undefined ? null : Number(record.handed_at),
    attempts: Number(record.attempts ?? 0),
  };
}

/** The harness took it: from here a crash is recoverable by reading the session file. */
export function markIntakeHanded(id: string): void {
  database().prepare("UPDATE intake SET handed_at = ?, attempts = attempts + 1 WHERE id = ?").run(Date.now(), id);
}

/** A resume that threw before the harness had it; the count stops the retry loop. */
function bumpIntakeAttempt(id: string): number {
  database().prepare("UPDATE intake SET attempts = attempts + 1 WHERE id = ?").run(id);
  const found = database().prepare("SELECT attempts FROM intake WHERE id = ?").get(id) as { attempts?: number } | undefined;
  return Number(found?.attempts ?? MAX_RESUME_ATTEMPTS);
}

export function openIntake(sessionId?: string): IntakeRow[] {
  const db = database();
  const records = sessionId
    ? db.prepare("SELECT * FROM intake WHERE session_id = ? ORDER BY created_at").all(sessionId)
    : db.prepare("SELECT * FROM intake ORDER BY created_at").all();
  return (records as Record<string, unknown>[]).map(rowFrom);
}

/** The harness refused the prompt, or history proves it arrived: nothing left to recover. */
export function closeIntake(id: string): void {
  database().prepare("DELETE FROM intake WHERE id = ?").run(id);
  removeFiles(id);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** User message texts in a session file, newest last. */
export function readUserTexts(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const texts: string[] = [];
  for (const entry of getSessionEntries(filePath)) {
    if (entry.type !== "message") continue;
    const message = (entry as { message?: { role?: string; content?: unknown } }).message;
    if (!message || message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    const parts = content
      .filter((part): part is { type: string; text?: string } => Boolean(part) && typeof part === "object")
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string);
    if (parts.length > 0) texts.push(parts.join("\n"));
  }
  return texts;
}

/**
 * Close every open row whose text is already in the session file. Called when a
 * page asks for state and at boot: a row that reached history needs no recovery.
 * Each history text settles at most one row, so sending the same message twice
 * keeps the second one open until its own delivery lands.
 */
export function settleIntake(sessionId: string, userTexts: string[]): number {
  const rows = openIntake(sessionId);
  if (rows.length === 0) return 0;
  const remaining = userTexts.map(normalize).filter((text) => text.length > 0);
  let closed = 0;
  for (const row of rows) {
    const wanted = normalize(row.text);
    if (!wanted) continue;
    const index = remaining.indexOf(wanted);
    if (index === -1) continue;
    remaining.splice(index, 1);
    closeIntake(row.id);
    closed += 1;
  }
  return closed;
}

/** Settle a session against its own file; a no-op when nothing is open there. */
export async function settleSessionIntake(sessionId: string): Promise<number> {
  if (openIntake(sessionId).length === 0) return 0;
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return 0;
  return settleIntake(sessionId, readUserTexts(filePath));
}

function imageCommand(file: IntakeFile) {
  try {
    return {
      type: "image" as const,
      data: readFileSync(file.file).toString("base64"),
      mimeType: file.mimeType,
    };
  } catch {
    return null;
  }
}

/**
 * The prompt to send again after a crash. A steered or follow-up message loses
 * its place in a run that no longer exists, so it goes back as an ordinary
 * prompt: the history it was steering is still there.
 */
export function intakeCommand(row: IntakeRow): IntakeCommand {
  const images = row.files.map(imageCommand).filter((image): image is NonNullable<typeof image> => image !== null);
  return {
    type: "prompt",
    message: row.text,
    ...(images.length > 0 ? { images } : {}),
  };
}

/**
 * Send open rows again after a restart. Rows already in the session history are
 * closed instead, so this is safe to run on every boot.
 */
export async function resumeOpenIntake(
  log: Pick<Console, "error" | "warn"> = console,
): Promise<void> {
  for (const row of openIntake()) {
    try {
      const filePath = await resolveSessionPath(row.sessionId);
      if (!filePath) {
        closeIntake(row.id);
        continue;
      }
      settleIntake(row.sessionId, readUserTexts(filePath));
      if (!openIntake(row.sessionId).some((still) => still.id === row.id)) continue;
      if (row.attempts >= MAX_RESUME_ATTEMPTS) {
        log.warn(`[pi-web] giving up on an undelivered prompt for session ${row.sessionId}`);
        closeIntake(row.id);
        continue;
      }
      const { session } = await startRpcSession(row.sessionId, filePath, undefined);
      await session.send(intakeCommand(row));
      markIntakeHanded(row.id);
    } catch (error) {
      log.error(
        `[pi-web] could not resume a pending prompt for session ${row.sessionId}:`,
        error instanceof Error ? error.message : error,
      );
      if (bumpIntakeAttempt(row.id) >= MAX_RESUME_ATTEMPTS) closeIntake(row.id);
    }
  }
}

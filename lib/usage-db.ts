import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { UsageBucket, UsageDaySummary, UsageSnapshot, UsageSourceDiagnostic } from "./usage-types";

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
    CREATE TABLE IF NOT EXISTS usage_days (
      day TEXT PRIMARY KEY, payload TEXT NOT NULL, collected_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_buckets (
      day TEXT NOT NULL, hour INTEGER NOT NULL, harness TEXT NOT NULL,
      model TEXT NOT NULL, provider TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY (day, hour, harness, model, provider)
    );
    CREATE TABLE IF NOT EXISTS usage_collection (
      id INTEGER PRIMARY KEY CHECK (id = 1), last_collected_at TEXT,
      time_zone TEXT, diagnostics TEXT NOT NULL DEFAULT '[]', error TEXT
    );
  `);
  open = { file, db };
  return db;
}

export function readUsageData() {
  const db = database();
  const state = db.prepare("SELECT * FROM usage_collection WHERE id = 1").get() as {
    last_collected_at: string | null; time_zone: string | null; diagnostics: string; error: string | null;
  } | undefined;
  const days = (db.prepare("SELECT payload FROM usage_days ORDER BY day").all() as { payload: string }[])
    .map(({ payload }) => JSON.parse(payload) as UsageDaySummary);
  const buckets = (db.prepare("SELECT payload FROM usage_buckets ORDER BY day, hour, harness, model, provider").all() as { payload: string }[])
    .map(({ payload }) => JSON.parse(payload) as UsageBucket);
  return {
    days, buckets,
    timeZone: state?.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    diagnostics: JSON.parse(state?.diagnostics ?? "[]") as UsageSourceDiagnostic[],
    sync: { lastCollectedAt: state?.last_collected_at ? Date.parse(state.last_collected_at) : null, error: state?.error ?? null },
  };
}

// Replace each represented calendar day atomically. Historical days whose source
// files have been removed stay available; requests never increment saved counters.
export function saveUsageSnapshot(snapshot: UsageSnapshot): void {
  if (!snapshot.complete) throw new Error("Incomplete usage collection");
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const previous = db.prepare("SELECT time_zone FROM usage_collection WHERE id = 1").get() as { time_zone: string | null } | undefined;
    if (previous?.time_zone && previous.time_zone !== snapshot.timeZone) throw new Error("Usage timezone changed");
    const clearBuckets = db.prepare("DELETE FROM usage_buckets WHERE day = ?");
    const insertDay = db.prepare("INSERT INTO usage_days VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET payload = excluded.payload, collected_at = excluded.collected_at");
    const insertBucket = db.prepare("INSERT INTO usage_buckets VALUES (?, ?, ?, ?, ?, ?)");
    for (const day of snapshot.days) {
      clearBuckets.run(day.day);
      insertDay.run(day.day, JSON.stringify(day), snapshot.collectedAt);
    }
    const days = new Set(snapshot.days.map((day) => day.day));
    for (const bucket of snapshot.buckets) {
      if (!days.has(bucket.day)) throw new Error("Usage bucket has no daily summary");
      insertBucket.run(bucket.day, bucket.hour, bucket.harness, JSON.stringify(bucket.model), JSON.stringify(bucket.provider), JSON.stringify(bucket));
    }
    db.prepare(`INSERT INTO usage_collection (id, last_collected_at, time_zone, diagnostics, error) VALUES (1, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET last_collected_at = excluded.last_collected_at, time_zone = excluded.time_zone,
      diagnostics = excluded.diagnostics, error = NULL`).run(snapshot.collectedAt, snapshot.timeZone, JSON.stringify(snapshot.diagnostics));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveUsageError(error: string, diagnostics?: UsageSourceDiagnostic[]): void {
  const db = database();
  db.prepare("INSERT INTO usage_collection (id, error) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET error = excluded.error").run(error);
  if (diagnostics) db.prepare("UPDATE usage_collection SET diagnostics = ? WHERE id = 1").run(JSON.stringify(diagnostics));
}

export function closeUsageDb(): void {
  open?.db.close();
  open = null;
}

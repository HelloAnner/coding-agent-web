import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const db = await createJiti(import.meta.url).import("./catalog-db.ts");

const root = mkdtempSync(path.join(tmpdir(), "catalog-db-"));
const file = path.join(root, "data.db");

test.after(() => {
  db.closeCatalogDb();
  rmSync(root, { recursive: true, force: true });
});

test("starts empty and does not invent sessions", () => {
  assert.deepEqual(db.listCatalogSessionInfos(file), { sessions: [], sessionListVersion: 0 });
});

test("stores a directory, a harness and the real session path", () => {
  const id = db.upsertCatalogSession({
    cwd: "/tmp/project",
    harness: "dsh",
    provider: "fineres",
    model: "deepseek-v4.1-flash",
    title: "hello",
    sessionPath: "/tmp/dsh/session-1",
  }, file);
  const listed = db.listCatalogSessionInfos(file);
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].id, id);
  assert.equal(listed.sessions[0].cwd, "/tmp/project");
  assert.equal(listed.sessions[0].harness, "dsh");
  assert.equal(listed.sessions[0].modelProvider, "fineres");
  assert.equal(listed.sessions[0].modelId, "deepseek-v4.1-flash");
  assert.equal(listed.sessions[0].path, "/tmp/dsh/session-1");
  assert.equal(listed.sessions[0].name, "hello");

  assert.throws(() => db.updateCatalogSession(id, { harness: "pi", title: "renamed" }, file), /keeps its harness/);
  assert.equal(db.updateCatalogSession(id, { title: "renamed" }, file), true);
  const again = db.listCatalogSessionInfos(file).sessions[0];
  assert.equal(again.harness, "dsh");
  assert.equal(again.name, "renamed");
  assert.equal(again.modelId, "deepseek-v4.1-flash");
  assert.throws(() => db.upsertCatalogSession({
    id,
    cwd: "/tmp/project",
    harness: "pi",
    sessionPath: "/tmp/pi/session-1",
  }, file), /keeps its harness/);
  assert.equal(db.listCatalogSessionInfos(file).sessions[0].path, "/tmp/dsh/session-1");

  assert.equal(db.deleteCatalogSession(id, file), true);
  assert.equal(db.listCatalogSessionInfos(file).sessions.length, 0);
});

test("refuses a relative directory", () => {
  assert.throws(() => db.upsertCatalogSession({ cwd: "relative", harness: "pi" }, file));
});

test("one project preference per folder, replaced on every pick", () => {
  assert.equal(db.readProjectPreference("/tmp/no-such-project", file), null);
  assert.equal(db.readProjectPreference("/tmp/a", file), null);

  db.writeProjectPreference("/tmp/a", { harness: "pi", provider: "anthropic", model: "claude-sonnet" }, file);
  assert.deepEqual(db.readProjectPreference("/tmp/a", file), {
    harness: "pi",
    provider: "anthropic",
    model: "claude-sonnet",
  });

  db.writeProjectPreference("/tmp/b", { harness: "dsh", provider: "fineres", model: "deepseek" }, file);
  db.writeProjectPreference("/tmp/a", { harness: "dsh", provider: "fineres", model: "deepseek" }, file);

  assert.deepEqual(db.readProjectPreference("/tmp/a", file), {
    harness: "dsh",
    provider: "fineres",
    model: "deepseek",
  });
  assert.deepEqual(db.readProjectPreference("/tmp/b", file), {
    harness: "dsh",
    provider: "fineres",
    model: "deepseek",
  });
});

test("a preference read never creates a data file", () => {
  const missing = path.join(root, "never-written.db");
  assert.equal(db.readProjectPreference("/tmp/a", missing), null);
  assert.equal(existsSync(missing), false);
});

test("keeps the Claude profile directory beside the transcript path", () => {
  const id = db.upsertCatalogSession({
    cwd: "/tmp/project",
    harness: "claude-code",
    provider: "local",
    model: "default",
    sessionPath: "/tmp/claude/projects/-tmp-project/session.jsonl",
    profilePath: "/tmp/claude",
  }, file);
  const row = db.readCatalogSession(id, file);
  assert.equal(row.sessionPath, "/tmp/claude/projects/-tmp-project/session.jsonl");
  assert.equal(row.profilePath, "/tmp/claude");
  assert.throws(() => db.updateCatalogSession(id, { profilePath: "/tmp/other" }, file), /keeps its profile/);

  // A writer that does not know the path must not blank it.
  db.upsertCatalogSession({ id, cwd: "/tmp/project", harness: "claude-code", provider: "local", model: "default" }, file);
  assert.equal(db.readCatalogSession(id, file).sessionPath, "/tmp/claude/projects/-tmp-project/session.jsonl");

  // Only the harvester may relocate a row.
  assert.equal(db.relocateCatalogSession(id, { sessionPath: "/tmp/claude/projects/-tmp-project/session.jsonl", profilePath: "/tmp/claude" }, file), true);
  assert.equal(db.deleteCatalogSession(id, file), true);
});

test("an older index gains the profile column without losing rows", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const legacy = path.join(root, "legacy.db");
  const raw = new DatabaseSync(legacy);
  raw.exec(`
    CREATE TABLE directories (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE sessions (
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
    INSERT INTO directories VALUES ('d1', '/tmp/legacy', 'legacy', 1);
    INSERT INTO sessions VALUES ('s1', 'd1', 'claude-code', 'local', 'default', 'old', '/tmp/claude', 1, 2);
  `);
  raw.close();

  const rows = db.listCatalogSessionPaths(legacy);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionPath, "/tmp/claude");
  assert.equal(rows[0].profilePath, "");
});

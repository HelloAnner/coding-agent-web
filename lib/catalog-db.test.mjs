import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

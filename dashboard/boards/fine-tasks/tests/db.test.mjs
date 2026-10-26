import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const db = await createJiti(import.meta.url).import("../db.ts");

test("Fine tasks use an independent table and preserve the last good snapshot on errors", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fine-tasks-"));
  const previous = process.env.CODING_AGENT_WEB_DATA;
  process.env.CODING_AGENT_WEB_DATA = path.join(root, "data.db");
  try {
    assert.deepEqual(db.readFineTasks(), { tasks: [], lastSyncedAt: null, error: null });
    const task = { id: "fine:story:1", title: "First", testers: [], fields: [] };
    db.saveFineTasks([task], 100);
    db.saveFineTaskError("Meegle unavailable");
    assert.deepEqual(db.readFineTasks(), { tasks: [task], lastSyncedAt: 100, error: "Meegle unavailable" });
    assert.throws(() => db.saveFineTasks([task, task], 200));
    assert.equal(db.readFineTasks().lastSyncedAt, 100);
    assert.equal(db.readFineTasks().tasks.length, 1);
    db.saveFineTasks([{ ...task, completed: true }], 250);
    assert.equal(db.readFineTasks().tasks.length, 0);
    db.saveFineTasks([task], 275);
    assert.equal(db.readFineTasks().tasks.length, 1);
    db.saveFineTasks([], 300);
    assert.deepEqual(db.readFineTasks(), { tasks: [], lastSyncedAt: 300, error: null });
  } finally {
    db.closeFineTaskDb();
    if (previous === undefined) delete process.env.CODING_AGENT_WEB_DATA;
    else process.env.CODING_AGENT_WEB_DATA = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

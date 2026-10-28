import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(path.join(tmpdir(), "notes-manual-"));
process.env.CODING_AGENT_WEB_NOTES_DIR = path.join(root, "notes");
process.env.CODING_AGENT_WEB_DATA = path.join(root, "data.db");

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const files = await jiti.import("./files.ts");
const db = await jiti.import("./db.ts");

test.after(() => {
  db.closeNotesDb();
  rmSync(root, { recursive: true, force: true });
});

test("a manual delete becomes a tombstone the agent cannot recreate", async () => {
  await files.createItem("", "旧方案", "board");
  await files.removeItem("旧方案.excalidraw");

  await assert.rejects(
    files.createItem("", "旧方案", "board", { source: "agent" }),
    /手动删除/,
  );
  // The user may recreate it himself: that clears the tombstone.
  await files.createItem("", "旧方案", "board");
  assert.ok(await files.readItem("旧方案.excalidraw"));
});

test("a manual rename and move are authoritative", async () => {
  await files.createDirectory("", "项目", { source: "agent" });
  await files.createItem("项目", "草稿", "board");
  const renamed = await files.renameItem("项目/草稿.excalidraw", "优雅发布");
  assert.equal(renamed, "项目/优雅发布.excalidraw");

  await assert.rejects(
    files.renameItem(renamed, "草稿", { source: "agent" }),
    /手动改名/,
  );
  await assert.rejects(
    files.removeItem(renamed, { source: "agent" }),
    /手动改名/,
  );
  await files.createDirectory("", "归档", { source: "agent" });
  await assert.rejects(
    files.moveItem(renamed, "归档", { source: "agent" }),
    /手动改名/,
  );

  // A marked child also locks its folder: moving 项目 would move the entry.
  await assert.rejects(
    files.moveItem("项目", "归档", { source: "agent" }),
    /手动改过/,
  );
});

test("the user may still rename and move his own marks", async () => {
  const next = await files.moveItem("项目/优雅发布.excalidraw", "归档");
  assert.equal(next, "归档/优雅发布.excalidraw");
  const renamed = await files.renameItem("归档/优雅发布.excalidraw", "发布流程");
  assert.equal(renamed, "归档/发布流程.excalidraw");
  assert.ok(await files.readItem("归档/发布流程.excalidraw"));
});

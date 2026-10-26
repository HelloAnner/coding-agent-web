import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const root = await mkdtemp(path.join(tmpdir(), "pi-web-notes-index-"));
const dataDir = await mkdtemp(path.join(tmpdir(), "pi-web-notes-db-"));
process.env.CODING_AGENT_WEB_NOTES_DIR = root;
process.env.CODING_AGENT_WEB_DATA = path.join(dataDir, "data.db");

const { flattenNotesIndex, listTree } = await import("./files.ts");
const { closeNotesDb, readNotesIndexRows, readNotesMentions, readNotesRoot, replaceNotesIndex } = await import("./db.ts");

after(async () => {
  closeNotesDb();
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

test("the tree is flattened with parents, kinds and absolute paths", async () => {
  await mkdir(path.join(root, "工作", "项目"), { recursive: true });
  await writeFile(path.join(root, "工作", "项目", "会议.md"), "");
  await writeFile(path.join(root, "工作", "架构.excalidraw"), "{}");

  const tree = await listTree();
  const rows = flattenNotesIndex(tree, root);
  replaceNotesIndex(root, rows);
  assert.deepEqual(flattenNotesIndex(tree, root), rows);
  assert.deepEqual(rows.map((row) => [row.path, row.parent, row.type]), [
    ["工作", "", "dir"],
    ["工作/项目", "工作", "dir"],
    ["工作/项目/会议.md", "工作/项目", "note"],
    ["工作/架构.excalidraw", "工作", "board"],
  ]);
  assert.equal(rows.find((row) => row.path === "工作/项目/会议.md")?.absPath, path.join(root, "工作", "项目", "会议.md"));
});

test("the database keeps every row and mentions only files", async () => {
  const mentions = readNotesMentions();
  assert.deepEqual(mentions.map((note) => [note.path, note.kind]), [
    ["工作/架构.excalidraw", "board"],
    ["工作/项目/会议.md", "note"],
  ]);
  assert.ok(mentions.every((note) => note.absPath.startsWith(root)));
  assert.equal(readNotesRoot(), root);
  assert.equal(readNotesIndexRows().length, 4);
});

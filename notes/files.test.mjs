import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(path.join(tmpdir(), "pi-web-notes-"));
process.env.CODING_AGENT_WEB_NOTES_DIR = root;
// Renames and deletes write manual marks; keep them out of the real data.db.
process.env.CODING_AGENT_WEB_DATA = path.join(root, "data.db");
const notes = await createJiti(import.meta.url).import("./files.ts");

after(() => rm(root, { recursive: true, force: true }));

test("directories and files mirror the page tree", async () => {
  await notes.createDirectory("", "工作");
  await notes.createDirectory("工作", "项目");
  const note = await notes.createItem("工作/项目", "会议记录", "note");
  const board = await notes.createItem("工作", "架构图", "board");

  assert.equal(note.path, "工作/项目/会议记录.md");
  assert.equal(board.path, "工作/架构图.excalidraw");

  const tree = await notes.listTree();
  assert.deepEqual(tree.map((node) => [node.name, node.type]), [["工作", "dir"]]);
  assert.deepEqual(tree[0].children.map((node) => [node.name, node.type]), [
    ["项目", "dir"],
    ["架构图.excalidraw", "board"],
  ]);

  const stored = await notes.readItem(note.path);
  assert.equal(stored.kind, "note");
  assert.equal(stored.content, "");

  const scene = JSON.parse((await readFile(path.join(root, board.path), "utf8")));
  assert.equal(scene.type, "excalidraw");
  assert.deepEqual(scene.elements, []);
});

test("a name cannot escape the notes root or hide in a dot folder", async () => {
  await assert.rejects(() => notes.createItem("", "../escape", "note"), /名称/);
  await assert.rejects(() => notes.createDirectory("", ".hidden"), /名称/);
  await assert.rejects(() => notes.readItem("../逃逸.md"), /路径/);
  await assert.rejects(() => notes.createItem("", "a/b", "note"), /名称/);
});

test("rename keeps the extension and never overwrites a sibling", async () => {
  await notes.createItem("", "旧标题", "note");
  await notes.writeItem("旧标题.md", "正文");
  const renamed = await notes.renameItem("旧标题.md", "新标题");
  assert.equal(renamed, "新标题.md");
  assert.equal((await notes.readItem(renamed)).content, "正文");

  await notes.createItem("", "占位", "note");
  await assert.rejects(() => notes.renameItem("新标题.md", "占位"), /已存在/);
});

test("folders rename without an extension and take their contents along", async () => {
  await notes.createDirectory("", "旧目录");
  await notes.createItem("旧目录", "笔记", "note");
  const renamed = await notes.renameItem("旧目录", "新目录");
  assert.equal(renamed, "新目录");
  assert.equal((await notes.readItem("新目录/笔记.md")).kind, "note");
  await assert.rejects(() => notes.renameItem("新目录", "a/b"), /名称/);
});

test("a board must stay valid JSON", async () => {
  await notes.createItem("", "坏了", "board");
  await assert.rejects(() => notes.writeItem("坏了.excalidraw", "{not json"), /JSON/);
  await notes.writeItem("坏了.excalidraw", '{"type":"excalidraw","elements":[]}');
});

test("a symlink cannot read or write outside the vault", async () => {
  const outside = path.join(root, "..", `outside-${Date.now()}.md`);
  await writeFile(outside, "secret");
  await symlink(outside, path.join(root, "link.md"));

  assert.equal(await notes.listTree().then((tree) => tree.some((node) => node.path === "link.md")), false);
  await assert.rejects(() => notes.readItem("link.md"), /路径/);
  await assert.rejects(() => notes.writeItem("link.md", "changed"), /路径/);
  assert.equal(await readFile(outside, "utf8"), "secret");

  await rm(path.join(root, "link.md"));
  await rm(outside);
});

test("a note can move between directories, but never over another file", async () => {
  await notes.createDirectory("", "目标");
  await notes.createItem("", "移动我", "note");
  await notes.writeItem("移动我.md", "内容");

  const moved = await notes.moveItem("移动我.md", "目标");
  assert.equal(moved, "目标/移动我.md");
  assert.equal((await notes.readItem(moved)).content, "内容");
  assert.equal((await notes.listTree()).some((node) => node.path === "移动我.md"), false);

  await notes.createItem("", "移动我", "note");
  await assert.rejects(() => notes.moveItem("移动我.md", "目标"), /已存在/);
});

test("a directory moves with its contents", async () => {
  await notes.createDirectory("", "归档");
  await notes.createDirectory("", "旧项目");
  await notes.createItem("旧项目", "总结", "note");

  const moved = await notes.moveItem("旧项目", "归档");
  assert.equal(moved, "归档/旧项目");
  assert.equal((await notes.readItem("归档/旧项目/总结.md")).kind, "note");
  assert.equal(await notes.moveItem("归档/旧项目", ""), "旧项目");
  assert.equal((await notes.readItem("旧项目/总结.md")).kind, "note");
});

test("remove deletes files and whole directories, but not the root", async () => {
  await notes.createDirectory("", "待删");
  await notes.createItem("待删", "笔记", "note");
  await notes.removeItem("待删/笔记.md");
  await assert.rejects(() => notes.readItem("待删/笔记.md"), /不存在/);
  await notes.removeItem("待删");
  await assert.rejects(() => notes.readItem("待删/x.md"), /不存在/);
  await assert.rejects(() => notes.removeItem(""), /根目录/);
});

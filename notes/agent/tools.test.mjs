import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(path.join(tmpdir(), "pi-web-notes-tools-"));
process.env.CODING_AGENT_WEB_NOTES_DIR = root;
// jiti resolves the tools' extensionless imports; plain --experimental-strip-types does not.
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const notes = await jiti.import("../files.ts");
const { notesAgentTools, NOTES_MANAGE_TOOL, NOTES_SESSIONS_TOOL, NOTES_WRITE_TOOL } = await jiti.import("./tools.ts");

const tools = notesAgentTools({ fontFamily: 3, fontSize: 20 });
const manage = tools.find((tool) => tool.name === NOTES_MANAGE_TOOL);
const write = tools.find((tool) => tool.name === NOTES_WRITE_TOOL);

/** A tool call as pi makes it; these tools ignore the id, signal and context. */
const run = (tool, params) => tool.execute("call", params, undefined, undefined, {});

after(() => rm(root, { recursive: true, force: true }));

test("the notes agent gets a tree tool and a session reader next to write and board", () => {
  assert.deepEqual(tools.map((tool) => tool.name), [NOTES_WRITE_TOOL, "notes_board", NOTES_MANAGE_TOOL, NOTES_SESSIONS_TOOL]);
});

test("mkdir builds every missing level", async () => {
  const result = await run(manage, { action: "mkdir", path: "工作/2024/复盘" });
  assert.match(result.content[0].text, /已创建目录 工作\/2024\/复盘/);
  const tree = await notes.listTree();
  assert.equal(tree[0].path, "工作");
  assert.equal(tree[0].children[0].children[0].path, "工作/2024/复盘");
});

test("create makes an empty note or a blank whiteboard", async () => {
  const note = await run(manage, { action: "create", path: "工作/空笔记.md", kind: "note" });
  assert.equal(note.details.path, "工作/空笔记.md");
  assert.equal((await notes.readItem("工作/空笔记.md")).content, "");

  const board = await run(manage, { action: "create", path: "工作/白板.excalidraw", kind: "board" });
  assert.equal(board.details.path, "工作/白板.excalidraw");
  assert.deepEqual(JSON.parse((await notes.readItem("工作/白板.excalidraw")).content).elements, []);

  await assert.rejects(() => run(manage, { action: "create", path: "工作/空笔记.md" }), /已存在/);
});

test("rename keeps the extension, move changes the directory, remove deletes", async () => {
  const renamed = await run(manage, { action: "rename", path: "工作/空笔记.md", name: "周报" });
  assert.equal(renamed.details.path, "工作/周报.md");

  const moved = await run(manage, { action: "move", path: "工作/周报.md", dir: "" });
  assert.equal(moved.details.path, "周报.md");

  const back = await run(manage, { action: "move", path: "周报.md", dir: "工作/2024" });
  assert.equal(back.details.path, "工作/2024/周报.md");

  await run(manage, { action: "rename", path: "工作/2024", name: "归档" });
  assert.equal((await notes.readItem("工作/归档/周报.md")).kind, "note");

  await assert.rejects(() => run(manage, { action: "remove", path: "工作/归档" }), /recursive=true/);
  const removed = await run(manage, { action: "remove", path: "工作/归档", recursive: true });
  assert.match(removed.content[0].text, /已删除 工作\/归档/);
  assert.equal((await notes.listTree()).some((node) => node.name === "归档"), false);
});

test("the tree tool refuses paths outside the vault and the wrong extension", async () => {
  await assert.rejects(() => run(manage, { action: "mkdir", path: "../逃逸" }), /相对路径/);
  await assert.rejects(() => run(manage, { action: "remove", path: "" }), /相对路径/);
  await assert.rejects(
    () => run(manage, { action: "create", path: "图.excalidraw", kind: "note" }),
    /只写 \.md/,
  );
  await assert.rejects(() => run(write, { path: "笔记.md", content: "x" })
    .then(() => run(manage, { action: "move", path: "笔记.md" })), /需要 dir/);
});

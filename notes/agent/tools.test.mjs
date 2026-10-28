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
const { notesAgentTools, NOTES_BOARD_TOOL, NOTES_LS_TOOL, NOTES_SESSIONS_TOOL } = await jiti.import("./tools.ts");

const tools = notesAgentTools({ fontFamily: 3, fontSize: 20 });
const board = tools.find((tool) => tool.name === NOTES_BOARD_TOOL);
const ls = tools.find((tool) => tool.name === NOTES_LS_TOOL);

/** A tool call as pi makes it; these tools ignore the id, signal and context. */
const run = (tool, params) => tool.execute("call", params, undefined, undefined, {});

after(() => rm(root, { recursive: true, force: true }));

await notes.createDirectory("", "方案");
await notes.createDirectory("", "已有");

test("the notes agent gets a tree tool, a board tool and a session reader", () => {
  assert.deepEqual(tools.map((tool) => tool.name), [NOTES_LS_TOOL, NOTES_BOARD_TOOL, NOTES_SESSIONS_TOOL]);
});

test("a board is read back before it is redrawn, so a hand edit survives", async () => {
  await run(board, {
    path: "方案/链路.excalidraw",
    action: "draw",
    elements: [
      { type: "rectangle", x: 0, y: 0, label: "浏览器" },
      { type: "arrow", x: 200, y: 50, to: { x: 360, y: 50 } },
    ],
  });

  const read = await run(board, { action: "read", path: "方案/链路.excalidraw" });
  assert.match(read.content[0].text, /rectangle 0,0 200x100「浏览器」/);
  assert.match(read.content[0].text, /arrow 200,50 -> 360,50/);

  // The user edits a box by hand; the redraw starts from what is on the board.
  await run(board, {
    path: "方案/链路.excalidraw",
    action: "draw",
    replace: true,
    elements: [
      { type: "rectangle", x: 0, y: 0, label: "浏览器（用户改过）" },
      { type: "arrow", x: 200, y: 50, to: { x: 360, y: 50 } },
      { type: "text", x: 0, y: -40, label: "结论：走同一条路由" },
    ],
  });
  const after = await run(board, { action: "read", path: "方案/链路.excalidraw" });
  assert.match(after.content[0].text, /「浏览器（用户改过）」/);
  assert.match(after.content[0].text, /「结论：走同一条路由」/);

  await assert.rejects(() => run(board, { action: "read", path: "方案/没有.excalidraw" }), /还不存在/);
  await assert.rejects(() => run(board, { action: "draw", path: "方案/链路.excalidraw" }), /需要 elements/);
});

test("a board tool refuses paths outside the vault and the wrong extension", async () => {
  await assert.rejects(() => run(board, { action: "read", path: "../逃逸.excalidraw" }), /相对路径/);
  await assert.rejects(() => run(board, { action: "read", path: "方案/链路.md" }), /只写 \.excalidraw/);
});

test("a new board only lands in a folder that already exists", async () => {
  await assert.rejects(
    () => run(board, { action: "draw", path: "不存在/新板.excalidraw", elements: [{ type: "text", x: 0, y: 0, label: "x" }] }),
    /目录 不存在 不存在/,
  );
  const created = await run(board, { action: "draw", path: "已有/新板.excalidraw", elements: [{ type: "text", x: 0, y: 0, label: "x" }] });
  assert.equal(created.details.created, true);
});

test("the tree tool lists the vault", async () => {
  const tree = await run(ls, {});
  assert.match(tree.content[0].text, /已有\//);
});

test("a pinned board tool writes that one board and nothing else", async () => {
  const pinnedTools = notesAgentTools({ fontFamily: 3, fontSize: 20 }, { onlyBoard: "方案/链路.excalidraw" });
  const pinned = pinnedTools.find((tool) => tool.name === NOTES_BOARD_TOOL);
  const shape = [{ type: "rectangle", x: 600, y: 600, label: "后来画的" }];

  await run(pinned, { action: "draw", path: "方案/链路.excalidraw", elements: shape });
  const read = await run(pinned, { action: "read", path: "方案/链路.excalidraw" });
  // The hand-edited box from the earlier test is still there: appending keeps everything.
  assert.match(read.content[0].text, /「浏览器（用户改过）」/);
  assert.match(read.content[0].text, /「后来画的」/);

  // The user's instruction may say "redraw it": replace is allowed on the pinned board.
  await run(pinned, { action: "draw", path: "方案/链路.excalidraw", replace: true, elements: shape });
  const redrawn = await run(pinned, { action: "read", path: "方案/链路.excalidraw" });
  assert.doesNotMatch(redrawn.content[0].text, /「浏览器（用户改过）」/);

  // Every other path stays out of reach.
  await assert.rejects(
    () => run(pinned, { action: "draw", path: "已有/新板.excalidraw", elements: shape }),
    /只能改 方案\/链路\.excalidraw/,
  );
  await assert.rejects(
    () => run(pinned, { action: "draw", path: "已有/另一块.excalidraw", elements: shape }),
    /只能改 方案\/链路\.excalidraw/,
  );
});

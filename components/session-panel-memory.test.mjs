import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// The module reads window.localStorage; a Map-backed stand-in is all it uses.
const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  },
};

// jiti resolves the module's extensionless imports; plain --experimental-strip-types does not.
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const {
  forgetSessionPanel,
  readNotesTreePosition,
  readSessionPanel,
  saveNotesTreePosition,
  saveSessionPanel,
} = await jiti.import("./session-panel-memory.ts");

const panel = {
  open: true,
  treeSource: "notes",
  treeCollapsed: true,
  fileTabs: [{ id: "file:/repo/a.ts", label: "a.ts", filePath: "/repo/a.ts" }],
  noteTabs: [{ path: "a/plan.md", name: "plan", kind: "note" }],
  terminalTabs: [{ id: "0123456789abcdef0123456789abcdef", cwd: "/repo", restored: true }],
  activeTabId: "note:a/plan.md",
};

test("each conversation keeps its own panel", () => {
  store.clear();
  saveSessionPanel("s1", panel);
  saveSessionPanel("s2", { ...panel, open: false, treeSource: "project", fileTabs: [], noteTabs: [], activeTabId: null });

  assert.deepEqual(readSessionPanel("s1"), panel);
  assert.equal(readSessionPanel("s2").open, false);
  assert.equal(readSessionPanel("s2").treeSource, "project");
  assert.equal(readSessionPanel("s3"), null, "a fresh conversation has no memory");

  forgetSessionPanel("s1");
  assert.equal(readSessionPanel("s1"), null);
  assert.equal(readSessionPanel("s2").open, false, "forgetting one session keeps the others");
});

test("the notes tree's position rides along with the panel", () => {
  store.clear();
  saveSessionPanel("s1", panel);
  saveNotesTreePosition("s1", { expanded: ["a"], scrollTop: 120 });
  assert.deepEqual(readNotesTreePosition("s1"), { expanded: ["a"], scrollTop: 120 });
  assert.deepEqual(readSessionPanel("s1"), panel, "one write does not drop the other's fields");
  assert.equal(readNotesTreePosition("s2"), null);
});

test("foreign or corrupt storage reads as no memory", () => {
  store.clear();
  assert.equal(readSessionPanel("s1"), null);

  store.set("pi-web:session-panel", "not json");
  assert.equal(readSessionPanel("s1"), null);

  store.set("pi-web:session-panel", JSON.stringify({ s1: { open: true, fileTabs: "nope", noteTabs: [{ path: 1 }] } }));
  const rescued = readSessionPanel("s1");
  assert.equal(rescued.open, true);
  assert.deepEqual(rescued.fileTabs, [], "a tab without a path is dropped");
  assert.deepEqual(rescued.noteTabs, []);
});

test("a conversation's terminals come back as reattaching tabs", () => {
  store.clear();
  saveSessionPanel("s1", { ...panel, terminalTabs: [{ id: "0123456789abcdef0123456789abcdef", cwd: "/repo" }] });
  assert.deepEqual(readSessionPanel("s1").terminalTabs, [
    { id: "0123456789abcdef0123456789abcdef", cwd: "/repo", restored: true },
  ], "a restored terminal reattaches instead of spawning a shell");

  store.set("pi-web:session-panel", JSON.stringify({ s1: { terminalTabs: [{ id: "../../bad", cwd: "/repo" }, { id: "0123456789abcdef0123456789abcdef" }] } }));
  assert.deepEqual(readSessionPanel("s1").terminalTabs, [], "a terminal needs a valid id and a cwd");
});

test("the oldest conversations are the ones forgotten", () => {
  store.clear();
  for (let index = 0; index < 61; index += 1) {
    saveSessionPanel(`s${index}`, { ...panel, activeTabId: `file:${index}` });
  }
  assert.equal(readSessionPanel("s0"), null, "the first conversation was dropped");
  assert.equal(readSessionPanel("s60").activeTabId, "file:60");
});

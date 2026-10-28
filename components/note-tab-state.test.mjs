import assert from "node:assert/strict";
import test from "node:test";

import { noteTabIdAfterMove, remapNoteTabs } from "./note-tab-state.ts";

const tabs = [
  { path: "a.md", name: "a", kind: "note" },
  { path: "dir/b.md", name: "b", kind: "note" },
  { path: "dir/sub/c.md", name: "c", kind: "note" },
  { path: "other.md", name: "other", kind: "note" },
];

test("a moved note's tab follows it", () => {
  const next = remapNoteTabs(tabs, "a.md", "dir/a.md");
  assert.equal(next[0].path, "dir/a.md");
  assert.deepEqual(next.slice(1), tabs.slice(1));
  assert.equal(tabs[0].path, "a.md", "the input is not mutated");
});

test("a moved folder takes the tabs below it, and only those", () => {
  const next = remapNoteTabs(tabs, "dir", "moved/dir");
  assert.deepEqual(next.map((tab) => tab.path), ["a.md", "moved/dir/b.md", "moved/dir/sub/c.md", "other.md"]);
});

test("a path that only starts with the same letters is not under the folder", () => {
  const doubled = [...tabs, { path: "dir2/kept.md", name: "kept", kind: "note" }];
  const next = remapNoteTabs(doubled, "dir", "x");
  assert.equal(next[4].path, "dir2/kept.md");
});

test("a move to the root drops the folder part", () => {
  const next = remapNoteTabs(tabs, "dir", "");
  assert.deepEqual(next.map((tab) => tab.path), ["a.md", "b.md", "sub/c.md", "other.md"]);
  assert.equal(noteTabIdAfterMove("note:dir/b.md", "dir", ""), "note:b.md");
});

test("the active tab id moves with its note, and other tabs stay put", () => {
  assert.equal(noteTabIdAfterMove("note:dir/b.md", "dir", "moved"), "note:moved/b.md");
  assert.equal(noteTabIdAfterMove("note:other.md", "dir", "moved"), "note:other.md");
  assert.equal(noteTabIdAfterMove("file:/repo/a.md", "a.md", "b.md"), "file:/repo/a.md");
  assert.equal(noteTabIdAfterMove(null, "a.md", "b.md"), null);
});

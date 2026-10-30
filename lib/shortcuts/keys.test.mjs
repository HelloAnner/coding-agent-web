import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// jiti resolves the sources the way the bundler does (extensionless relative
// imports), so the modules under test stay importable from components too.
const jiti = createJiti(import.meta.url);
const {
  isActivatableTarget,
  isEditableTarget,
  isEnterFocusKey,
  isFocusComposerKey,
  isLeaderKey,
  isNewSessionKey,
  isOwnedByOverlay,
  scrollChatKey,
  stepProjectKey,
  stepRunningKey,
  stepSessionKey,
  stepUnreadKey,
} = await jiti.import("./keys.ts");
const { LEADER_COMMANDS, leaderCommandFor } = await jiti.import("./leader.ts");

function key(key, modifiers = {}) {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers };
}

test("session jumps are ⌘↑ / ⌘↓ and nothing else", () => {
  assert.equal(stepSessionKey(key("ArrowDown", { metaKey: true })), 1);
  assert.equal(stepSessionKey(key("ArrowUp", { metaKey: true })), -1);
  // ⌘⇧ and ⌃ belong to their own jumps, plain ↑ the browser's scrolling.
  assert.equal(stepSessionKey(key("ArrowDown", { metaKey: true, shiftKey: true })), 0);
  assert.equal(stepSessionKey(key("ArrowDown")), 0);
  assert.equal(stepSessionKey(key("ArrowDown", { ctrlKey: true })), 0);
  assert.equal(stepSessionKey(key("ArrowDown", { metaKey: true, altKey: true })), 0);
});

test("unread, project and running jumps each own one chord", () => {
  assert.equal(stepUnreadKey(key("ArrowUp", { metaKey: true, shiftKey: true })), -1);
  assert.equal(stepProjectKey(key("ArrowDown", { ctrlKey: true, shiftKey: true })), 1);
  assert.equal(stepRunningKey(key("ArrowUp", { ctrlKey: true, altKey: true })), -1);
  // They must not overlap: one key, one meaning.
  assert.equal(stepUnreadKey(key("ArrowUp", { ctrlKey: true, shiftKey: true })), 0);
  assert.equal(stepProjectKey(key("ArrowUp", { ctrlKey: true, altKey: true })), 0);
  assert.equal(stepRunningKey(key("ArrowUp", { ctrlKey: true, shiftKey: true })), 0);
  assert.equal(stepProjectKey(key("ArrowUp", { ctrlKey: true })), 0);
});

test("⌃E, ⌃N, ⌃↵ and the bare keys", () => {
  assert.equal(isLeaderKey(key("e", { ctrlKey: true })), true);
  assert.equal(isLeaderKey(key("E", { ctrlKey: true })), true);
  assert.equal(isLeaderKey(key("e")), false);
  assert.equal(isLeaderKey(key("e", { metaKey: true })), false);
  assert.equal(isNewSessionKey(key("n", { ctrlKey: true })), true);
  assert.equal(isNewSessionKey(key("n", { ctrlKey: true, altKey: true })), false);
  assert.equal(isFocusComposerKey(key("Enter", { ctrlKey: true })), true);
  assert.equal(scrollChatKey(key("j")), 1);
  assert.equal(scrollChatKey(key("K")), -1);
  assert.equal(scrollChatKey(key("j", { ctrlKey: true })), 0);
  assert.equal(isEnterFocusKey(key("Enter")), true);
  assert.equal(isEnterFocusKey(key("Enter", { shiftKey: true })), false);
});

test("the browser's own keys are never taken", () => {
  // ⌘ letters, ⌘1–9, ⌃Tab, text-editing chords: all left alone.
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  for (const letter of letters) {
    const event = key(letter, { metaKey: true });
    assert.equal(isLeaderKey(event), false, `⌘${letter}`);
    assert.equal(stepSessionKey(event), 0);
    assert.equal(stepUnreadKey(event), 0);
    assert.equal(stepProjectKey(event), 0);
    assert.equal(stepRunningKey(event), 0);
    assert.equal(isNewSessionKey(event), false);
  }
  for (let digit = 0; digit <= 9; digit += 1) {
    assert.equal(stepSessionKey(key(String(digit), { metaKey: true })), 0);
  }
  assert.equal(stepSessionKey(key("Tab", { ctrlKey: true })), 0);
});

test("⌃E then the second key picks one command", () => {
  for (const command of LEADER_COMMANDS) {
    const event = command.key === "" ? key("e", { ctrlKey: true }) : key(command.key);
    assert.equal(leaderCommandFor(event)?.id, command.id, command.id);
  }
  // Capitalised by a stray shift is the same key.
  assert.equal(leaderCommandFor(key("D"))?.id, "archive");
  // A modified second key is not a command: ⌘D, ⌃D belong to someone else.
  assert.equal(leaderCommandFor(key("d", { metaKey: true })), null);
  assert.equal(leaderCommandFor(key("d", { ctrlKey: true })), null);
  assert.equal(leaderCommandFor(key("x")), null);
});

test("text fields, menus and the terminal keep their keys", () => {
  const inField = { closest: (selector) => (selector.includes("textarea") ? {} : null) };
  assert.equal(isEditableTarget(inField), true);
  assert.equal(isEditableTarget({ closest: () => null }), false);
  assert.equal(isEditableTarget(null), false);

  const inTerminal = { closest: (selector) => (selector.includes(".xterm") ? {} : null) };
  assert.equal(isOwnedByOverlay(inTerminal), true);

  const onButton = { closest: (selector) => (selector.includes("button") ? {} : null) };
  assert.equal(isActivatableTarget(onButton), true);
  assert.equal(isActivatableTarget({ closest: () => null }), false);
});

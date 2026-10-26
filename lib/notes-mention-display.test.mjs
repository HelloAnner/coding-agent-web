import assert from "node:assert/strict";
import test from "node:test";
import { highlightAbsoluteAtMentions } from "./notes-mention-display.ts";

test("a quoted absolute mention becomes a local-file link with a short label", () => {
  assert.equal(
    highlightAbsoluteAtMentions('看 @"/tmp/my notes.md" 和 @"/tmp/架构.excalidraw"'),
    "看 [my notes.md](file:///tmp/my%20notes.md) 和 [架构.excalidraw](file:///tmp/%E6%9E%B6%E6%9E%84.excalidraw)",
  );
});

test("relative and unquoted tokens keep their text", () => {
  assert.equal(highlightAbsoluteAtMentions('@"notes/todo.md"'), '@"notes/todo.md"');
  assert.equal(highlightAbsoluteAtMentions("@/tmp/todo.md"), "@/tmp/todo.md");
});

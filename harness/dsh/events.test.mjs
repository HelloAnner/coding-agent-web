import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { DshEventMapper } = await createJiti(import.meta.url).import("./events.ts");

function collect(updates, stopReason) {
  const events = [];
  const mapper = new DshEventMapper("deepseek-v4-flash", (event) => events.push(event));
  for (const update of updates) mapper.push(update);
  mapper.finish(stopReason);
  return events;
}

test("one committed message per kernel message id", () => {
  const events = collect([
    { sessionUpdate: "agent_thought_chunk", messageId: "m1", content: { type: "text", text: "look" } },
    { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "done" } },
    { sessionUpdate: "agent_message_chunk", messageId: "m2", content: { type: "text", text: "next" } },
  ], "end_turn");

  const ends = events.filter((event) => event.type === "message_end");
  assert.equal(ends.length, 2);
  assert.deepEqual(ends[0].message.content, [
    { type: "thinking", thinking: "look" },
    { type: "text", text: "done" },
  ]);
  assert.deepEqual(ends[1].message.content, [{ type: "text", text: "next" }]);
  assert.equal(ends[1].message.stopReason, "end_turn");
  assert.equal(ends[1].message.provider, "dsh");
});

test("a tool call closes the step and its result becomes a toolResult", () => {
  const events = collect([
    { sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", status: "in_progress", rawInput: { command: "ls" } },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "a.txt" } }],
    },
  ]);

  const kinds = events.map((event) => event.type);
  assert.deepEqual(kinds, [
    "message_start",
    "message_update", // toolcall_start
    "message_update", // toolcall_end
    "tool_execution_start",
    "tool_execution_end",
    "message_end",
    "message_start",
    "message_end",
  ]);
  const assistant = events.find((event) => event.type === "message_end");
  assert.deepEqual(assistant.message.content, [
    { type: "toolCall", toolCallId: "c1", toolName: "bash", input: { command: "ls" } },
  ]);
  const result = events.at(-1);
  assert.equal(result.message.role, "toolResult");
  assert.equal(result.message.toolName, "bash");
  assert.equal(result.message.content[0].text, "a.txt");
});

test("a failed tool result is marked as an error", () => {
  const events = collect([
    { sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", rawInput: "not json" },
    { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed", content: [] },
  ]);
  assert.equal(events.find((event) => event.type === "tool_execution_end").isError, true);
  assert.equal(events.at(-1).message.isError, true);
  assert.deepEqual(events.find((event) => event.type === "message_end").message.content[0].input, { arguments: "not json" });
});

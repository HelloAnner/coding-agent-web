import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseClaudeTranscript } = await jiti.import("./transcript.ts");
const { ClaudeEventMapper } = await jiti.import("./events.ts");
const { endsAssistantResponse, findMessageGroupEnd } = await jiti.import("../../lib/message-display.ts");

function assistant(id, content, stop_reason) {
  return { type: "assistant", uuid: id, message: { id, model: "test", content, stop_reason } };
}
const text = (text) => ({ type: "text", text });
const tool = { type: "tool_use", id: "read", name: "Read", input: { file_path: "/test" } };

test("keeps a completed answer outside later background work and its follow-up", () => {
  const records = [
    { type: "user", uuid: "user", message: { content: "Investigate" } },
    assistant("read", [tool], "tool_use"),
    assistant("answer", [text("Full report with findings and recommendations")], "end_turn"),
    assistant("more-work", [tool], "tool_use"),
    assistant("follow-up", [text("Background check agrees with the report")], "end_turn"),
  ].map((record, index, all) => ({ ...record, parentUuid: all[index - 1]?.uuid }));
  const messages = parseClaudeTranscript(records.map(JSON.stringify).join("\n"));
  assert.equal(messages[2].stopReason, "end_turn");
  assert.equal(findMessageGroupEnd(messages, 0), 3);
  assert.equal(findMessageGroupEnd(messages, 3), 5);
});

test("retains the completion reason when native content blocks are merged", () => {
  const messages = parseClaudeTranscript([
    { ...assistant("answer", [{ type: "thinking", thinking: "Plan" }], null), apiBlockIndex: 0 },
    { ...assistant("answer", [text("Report")], "end_turn"), uuid: "text", parentUuid: "answer", apiBlockIndex: 1 },
  ].map(JSON.stringify).join("\n"));
  assert.equal(messages.length, 1);
  assert.equal(endsAssistantResponse(messages[0]), true);
});

test("normalizes output limits without treating tool calls or other harnesses as completion boundaries", () => {
  const [limited] = parseClaudeTranscript(JSON.stringify(assistant("limit", [text("Partial")], "max_tokens")));
  assert.equal(limited.stopReason, "length");
  assert.equal(endsAssistantResponse(limited), false);
  assert.equal(endsAssistantResponse({ ...limited, stopReason: "tool_use" }), false);
  assert.equal(endsAssistantResponse({ ...limited, provider: "pi", stopReason: "end_turn" }), false);
  assert.equal(endsAssistantResponse({ ...limited, content: [{ type: "thinking", thinking: "Plan" }], stopReason: "end_turn" }), false);
});

test("preserves end_turn from complete live assistant frames with or without streaming", () => {
  for (const streaming of [false, true]) {
    const events = [];
    const mapper = new ClaudeEventMapper((event) => events.push(event));
    if (streaming) mapper.push({ type: "stream_event", event: { type: "message_start", message: { id: "answer", model: "test" } } });
    mapper.push(assistant("answer", [text("Report")], "end_turn"));
    mapper.finish();
    const ended = events.findLast((event) => event.type === "message_end");
    assert.equal(ended.message.stopReason, "end_turn");
    assert.equal(endsAssistantResponse(ended.message), true);
  }
});

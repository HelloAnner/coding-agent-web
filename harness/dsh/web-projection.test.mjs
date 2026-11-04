import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { attemptFailure, nativeMessage, nativeSurface } = await jiti.import("./web-projection.ts");
const noImage = async () => null;

/** dsh logs a failed step as an attempt with a finish chunk, never as an assistant message. */
function failedAttempt(message = "Insufficient Balance") {
  return {
    type: "assistant/attempt", seq: 17, time: 1793756814618,
    data: { turn: 1, step: 1, stream: [{ type: "chunk", time: 1793756814617, chunk: { type: "finish", reason: { kind: "error", failure: { message, code: "QUOTA", status: 402 } } } }] },
  };
}

test("a failed step keeps its provider error in history", async () => {
  const event = failedAttempt();
  assert.equal(attemptFailure(event.data), "Insufficient Balance");
  const message = await nativeMessage(event, noImage);
  assert.equal(message.role, "assistant");
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "Insufficient Balance");
  assert.deepEqual(nativeSurface([event]).map((item) => item.seq), [17]);
});

test("a completed turn contributes no attempt and no error", async () => {
  const event = { type: "assistant/message", seq: 15, time: 1, data: { message: { role: "assistant", content: [{ type: "text", text: "ok" }], source: { kind: "model", provider: "opencode-zen", model: "deepseek-v4.1-flash" } } } };
  assert.equal(attemptFailure(event.data), null);
  const message = await nativeMessage(event, noImage);
  assert.equal(message.stopReason, undefined);
  assert.equal(message.errorMessage, undefined);
  assert.deepEqual(nativeSurface([event]).map((item) => item.seq), [15]);
});

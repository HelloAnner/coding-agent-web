import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { mergeClaudeHistory, upsertClaudeMessage, runtimeStatusUrl, sendClaudeCommand, ClaudeTrustRequiredError } = await createJiti(import.meta.url).import("./claude-code-client.ts");
const assistant = (nativeId, text) => ({ role: "assistant", nativeId, model: "m", provider: "claude-code", content: [{ type: "text", text }] });

test("native frame reconciliation replaces one message instead of duplicating the streamed answer", () => {
  const original = assistant("a", "hel");
  const full = assistant("a", "hello");
  assert.deepEqual(upsertClaudeMessage([original], full), [full]);
  assert.deepEqual(upsertClaudeMessage([original], assistant("b", "next")), [original, assistant("b", "next")]);
});

test("reconnecting history wins over stale frames while retaining a new in-flight tail", () => {
  const history = [assistant("a", "full")];
  const tail = assistant("b", "new completion");
  assert.deepEqual(mergeClaudeHistory(history, [assistant("a", "old"), tail]), [...history, tail]);
  assert.equal(runtimeStatusUrl("claude-code", "s"), "/api/claude-code/s?state=1");
  assert.equal(runtimeStatusUrl("pi", "s").startsWith("/api/agent/s"), true);
});

test("workspace consent is explicit and the send payload never changes harness endpoints", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    return options.body.includes('"trusted":true')
      ? Response.json({ success: true, data: { accepted: true } })
      : Response.json({ requiresTrust: true, cwd: "/project" }, { status: 409 });
  };
  await assert.rejects(sendClaudeCommand("s", { type: "prompt", cwd: "/project" }), (error) => error instanceof ClaudeTrustRequiredError && error.cwd === "/project");
  assert.deepEqual(await sendClaudeCommand("s", { type: "prompt", cwd: "/project", trusted: true }), { accepted: true });
  assert.ok(calls.every(([url]) => url === "/api/claude-code/s"));
  assert.equal(calls[0][1].trusted, undefined);
});

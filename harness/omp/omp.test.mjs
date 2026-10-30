import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { OmpFrameDecoder, readJsonLines } = await jiti.import("./rpc.ts");
const { piModelContext, OMP_MODEL_API } = await jiti.import("./model-bridge.ts");
const { ompModelMetadata, selectedOmpModel } = await jiti.import("./models.ts");
const { parseOmpTranscript } = await jiti.import("./transcript.ts");

const chunk = (bytes, index, count, total) => ({ type: "rpc_chunk", chunkId: "a", index, count, byteLength: total, data: bytes.toString("base64") });
test("OMP v2 reconstructs strict UTF-8 and refuses broken, interleaved, oversized chunks", () => {
  const bytes = Buffer.from(JSON.stringify({ type: "response", text: "中文🙂" }));
  const decoder = new OmpFrameDecoder();
  assert.equal(decoder.push(chunk(bytes.subarray(0, 30), 0, 2, bytes.length)), null);
  assert.deepEqual(decoder.push(chunk(bytes.subarray(30), 1, 2, bytes.length)), JSON.parse(bytes));
  for (const invalid of [
    chunk(Buffer.from("x"), 1, 2, 2),
    { ...chunk(bytes, 0, 1, bytes.length), byteLength: 70 * 1024 * 1024 },
    chunk(Buffer.from([0xff]), 0, 1, 1),
    { ...chunk(bytes, 0, 1, bytes.length), data: "not base64" },
  ]) assert.throws(() => new OmpFrameDecoder().push(invalid));
  const unfinished = new OmpFrameDecoder();
  unfinished.push(chunk(Buffer.from("{"), 0, 2, 2));
  assert.throws(() => unfinished.push({ type: "ready" }), /Interrupted/);
  assert.throws(() => unfinished.finish(), /Incomplete/);
});
test("OMP JSONL handles byte splits, joined lines, limits, and an incomplete EOF", async () => {
  const input = new PassThrough();
  const events = []; const errors = [];
  readJsonLines(input, (frame) => events.push(frame), (error) => errors.push(error));
  const bytes = Buffer.from('{"text":"中"}\n{"text":"next"}\n');
  input.write(bytes.subarray(0, 10)); input.end(bytes.subarray(10));
  await new Promise((resolve) => input.on("end", resolve));
  assert.deepEqual(events, [{ text: "中" }, { text: "next" }]);
  assert.equal(errors.length, 0);
  for (const [text, limit] of [["{unfinished", 100], ['{"text":"too large"}\n', 8]]) {
    const pipe = new PassThrough(); const failures = [];
    readJsonLines(pipe, () => assert.fail("must not accept invalid input"), (error) => failures.push(error), limit);
    pipe.end(text); await new Promise((resolve) => pipe.on("end", resolve));
    assert.equal(failures.length, 1);
  }
});
test("Pi metadata is shared without restricting APIs or leaking configuration/credentials", () => {
  const model = { provider: "gateway", id: "a/b", name: "Custom", api: "extension-private-api", baseUrl: "https://private.example", headers: { Authorization: "secret" }, reasoning: true,
    thinkingLevelMap: { high: "custom-high", xhigh: null }, input: ["text", "image"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 9000,
    samplingParams: { top_k: 12 } };
  const metadata = ompModelMetadata({ scope: { visible: [model], scopedModels: [] } });
  assert.equal(metadata[0].id, "a/b");
  assert.equal(metadata[0].maxTokens, 9000);
  assert.ok(metadata[0].thinking.efforts.includes("high"));
  assert.ok(!metadata[0].thinking.efforts.includes("xhigh"));
  assert.doesNotMatch(JSON.stringify(metadata), /secret|private\.example|samplingParams|Authorization/);
  assert.throws(() => selectedOmpModel({}, "gateway"), /together/);
  assert.throws(() => selectedOmpModel({ scope: { visible: [model] }, runtime: { getError: () => undefined, getModel: () => undefined } }, model.provider, model.id), /listed but not registered/);
  const context = piModelContext({ systemPrompt: ["native OMP instructions", "project context"], tools: [{ name: "read" }], messages: [{ role: "assistant", api: OMP_MODEL_API, piWebApi: "extension-private-api", provider: "gateway", model: "a/b", content: [{ type: "thinking", thinking: "reason", thinkingSignature: "signed" }] }] });
  assert.equal(context.systemPrompt, "native OMP instructions\n\nproject context");
  assert.equal(context.messages[0].api, "extension-private-api");
  assert.equal(context.messages[0].content[0].thinkingSignature, "signed");
  assert.ok(!("piWebApi" in context.messages[0]));
  assert.deepEqual(context.tools, [{ name: "read" }]);
  assert.throws(() => piModelContext({ messages: [{ role: "assistant", api: OMP_MODEL_API }] }), /original provider API/);
});
test("stopping during startup retains the lock and emits one aborted terminal without sending", async () => {
  const { getOmpRun } = await jiti.import("./runtime.ts");
  const run = getOmpRun("omp-early-stop-check");
  const ready = Promise.withResolvers();
  run.open = () => ready.promise;
  const events = [];
  const off = run.onEvent((event) => events.push(event));
  const input = { id: run.id, cwd: "/unused", message: "A" };
  const sending = run.prompt(input);
  assert.equal(run.state().state.isStreaming, true);
  const { POST } = await jiti.import("./api.ts");
  const stopped = await POST(new Request("http://localhost/api/omp/" + run.id, { method: "POST", body: JSON.stringify({ type: "abort" }) }), { params: Promise.resolve({ id: run.id }) });
  assert.equal((await stopped.json()).data.aborted, true, "startup can stop before a catalog row exists");
  await assert.rejects(run.prompt({ ...input, message: "B" }), /already working/);
  ready.resolve();
  await assert.rejects(sending, /stopped before sending/);
  assert.equal(run.isBusy, false);
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
  assert.equal(events.find((event) => event.type === "agent_settled").aborted, true);
  assert.equal(events.some((event) => event.type === "prompt_error"), false);
  off();
  const failed = getOmpRun("omp-startup-error-check");
  failed.open = async () => { throw new Error("unexpected native output: fake-private-secret"); };
  const failureEvents = [];
  const remove = failed.onEvent((event) => failureEvents.push(event));
  await assert.rejects(failed.prompt({ id: failed.id, cwd: "/unused", message: "fail safely" }));
  assert.ok(failureEvents.some((event) => event.type === "prompt_error"));
  assert.doesNotMatch(JSON.stringify(failureEvents), /fake-private-secret/);
  remove();
});

test("OMP history skips its title slot and abandoned branches, preserving model IDs and tool results", () => {
  const entry = (id, parentId, message) => ({ type: "message", id, parentId, message });
  const data = [
    { type: "title", title: "native" }, { type: "session", version: 3, id: "native-id", cwd: "/project" },
    entry("u1", null, { role: "user", content: "same question" }),
    entry("abandoned", "u1", { role: "assistant", content: [{ type: "text", text: "not this branch" }] }),
    { type: "model_change", id: "m", parentId: "u1", model: "gateway/path/to/model" },
    entry("u2", "m", { role: "user", content: "same question" }),
    entry("a", "u2", { role: "assistant", provider: "gateway", model: "path/to/model", content: [{ type: "toolCall", id: "t", name: "read", arguments: { path: "file" } }] }),
    entry("t", "a", { role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: "contents" }] }),
  ].map((value) => JSON.stringify(value)).join("\n") + "\n";
  const result = parseOmpTranscript(data + '{"partial');
  assert.equal(result.header.id, "native-id");
  assert.equal(result.messages.filter((message) => message.role === "user").length, 2);
  assert.doesNotMatch(JSON.stringify(result.messages), /not this branch/);
  assert.deepEqual(result.model, { provider: "gateway", modelId: "path/to/model" });
  assert.equal(result.messages.at(-1).role, "toolResult");
  assert.equal(result.messages.at(-2).content[0].toolCallId, "t");
  assert.throws(() => parseOmpTranscript("not a header\n"), /damaged/);
  assert.throws(() => parseOmpTranscript(JSON.stringify({ type: "session", id: "x", cwd: "/p" }) + "\n" + JSON.stringify({ type: "message", id: "a", parentId: "a" })), /cycle/);
});

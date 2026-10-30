import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { nativeMessage, nativeSurface } = await jiti.import("./web-projection.ts");

test("native surface replacements and tool/image projection preserve authoritative data", async () => {
  const event = (seq, type, data, surfaceOp = "append") => ({ seq, type, data, time: 100, surfaceOp });
  const history = [event(1, "user/message", { source: { kind: "user" }, content: "old" }), event(2, "assistant/message", { message: { source: { provider: "p", model: "m" }, content: [{ type: "text", text: "reply" }] } }), event(3, "user/message", { source: { kind: "user" }, content: "new" }, { op: "replace", startSeq: 1, endSeq: 2 })];
  assert.deepEqual(nativeSurface(history).map((item) => item.seq), [3]);
  assert.equal((await nativeMessage(history[2], async () => null)).content, "new");
  const message = await nativeMessage(event(4, "assistant/message", { message: { source: { provider: "p", model: "m" }, content: [{ type: "tool-call", id: "tool-1", name: "read", arguments: '{"path":"README.md"}' }] } }), async () => null);
  assert.equal(message.model, "m"); assert.equal(message.provider, "p");
  assert.deepEqual(message.content[0].input, { path: "README.md" });
});

test("native shared chat sends, streams, switches models, reads history and resumes without ACP/TUI", { skip: process.env.DSH_NATIVE_TEST !== "1", timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "coding-agent-dsh-session-"));
  process.env.CODING_AGENT_WEB_DATA = join(home, "catalog.db");
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (delta, finish_reason) => `data: ${JSON.stringify({ id: "test-completion", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.write(frame({ role: "assistant", content: "Native " }, null));
      setTimeout(() => { res.write(frame({ content: "reply" }, null)); res.end(frame({}, "stop") + "data: [DONE]\n\n"); }, 30);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const profile = join(home, "profiles", "coding-agent-web");
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, "package.json"), JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } } }));
  await writeFile(join(profile, "cordis.patch.yml"), `- id: session-title-llm\n  disabled: true\n- id: llm-pi-ai\n  config:\n    providers:\n      test-gateway:\n        api: openai-completions\n        baseURL: http://127.0.0.1:${port}/v1\n        apiKeyEnv: DSH_WEB_TEST_KEY\n        models:\n          - id: test-model\n            name: Test model\n            contextWindow: 32768\n            maxTokens: 1024\n`);
  process.env.DSH_WEB_TEST_KEY = "local-test-not-a-secret";
  const { DshWebHost } = await jiti.import("./web-host.ts");
  const host = new DshWebHost(home);
  globalThis[Symbol.for("coding-agent-web.dshWebHost")] = host;
  const runtime = await jiti.import("./web-session.ts");
  const { upsertCatalogSession, closeCatalogDb } = await jiti.import("../../lib/catalog-db.ts");
  try {
    const models = await runtime.listDshWebModels();
    assert.ok(models.models.some((model) => model.provider === "test-gateway"));
    const run = runtime.getDshSession("dsh-native-web-test");
    const events = [];
    let settled;
    const done = new Promise((resolve) => { settled = resolve; });
    run.onEvent((event) => { events.push(event); if (event.type === "agent_settled") settled(); });
    const sent = await runtime.sendDshPrompt({ sessionId: run.id, cwd: home, text: "Say hello", provider: "test-gateway", model: "test-model" });
    upsertCatalogSession({ id: run.id, cwd: home, harness: "dsh", provider: "test-gateway", model: "test-model", sessionPath: sent.sessionPath });
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("No native settlement: " + JSON.stringify(events))), 15_000).unref())]);
    assert.ok(events.some((event) => event.type === "message_update"));
    assert.equal(events.filter((event) => event.type === "message_end" && event.message.role === "assistant").length, 1);
    const transcript = await runtime.readDshWebTranscript(run.id);
    assert.equal(transcript.messages.filter((message) => message.role === "user").length, 1);
    assert.match(transcript.messages.find((message) => message.role === "assistant").content[0].text, /Native reply/);
    const ref = "CODING_AGENT_DSH_NATIVE_NOTES_CHECK";
    await host.call("credentials/set", { ref, value: "managed-native-test-key" });
    const settings = await host.call("settings/describe");
    const ns = settings.namespaces.find((item) => item.ns === "llm-pi-ai");
    await host.call("settings/mutate", { ns: ns.ns, expectedRevision: ns.revision, ops: [{ op: "set", path: ["providers", "test-gateway", "apiKeyEnv"], value: ref }] });
    const { dshModelConfig } = await jiti.import("./model-config.ts");
    assert.equal((await dshModelConfig({ provider: "test-gateway", model: "test-model" })).config.apiKey, "managed-native-test-key", "Notes reads native managed credentials server-side, not TUI auth");
    const { codingSessionModel } = await jiti.import("../../notes/agent/model.ts");
    const notes = await codingSessionModel(run.id);
    assert.equal((await notes.runtime.getAuth(notes.model)).auth.apiKey, "managed-native-test-key");
    assert.equal(notes.model.reasoning, false);
    await host.stop();
    await new Promise((resolve) => setImmediate(resolve));
    const restored = await runtime.readDshWebTranscript(run.id);
    assert.equal(restored.messages.length, transcript.messages.length);
    await assert.rejects(runtime.sendDshPrompt({ sessionId: run.id, cwd: tmpdir(), text: "wrong cwd" }), /directory/);
  } finally {
    await host.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    closeCatalogDb();
    await rm(home, { recursive: true, force: true });
  }
});

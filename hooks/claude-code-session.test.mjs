import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(shimPath);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };

function setup(t) {
  const previous = { fetch: globalThis.fetch, EventSource: globalThis.EventSource, document: globalThis.document, window: globalThis.window };
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  globalThis.window = new EventTarget();
  const sources = [], requests = [], created = [];
  const server = { history: [], started: false, running: false, rejectAnswer: false };
  globalThis.EventSource = class {
    readyState = 0;
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.readyState = 2; }
    emit(event) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(event) }); }
  };
  globalThis.fetch = async (url, options = {}) => {
    assert.match(url, /^\/api\/claude-code\//, "Claude must never call a pi endpoint");
    const command = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, command });
    if (command?.type === "prompt") {
      server.started = true; server.running = true;
      server.history.push({ role: "user", content: command.message, nativeId: command.promptId });
      return Response.json({ success: true, data: { sessionPath: "/native/profile", provider: "example", model: "profile-one", cwd: "/project" } });
    }
    if (command?.type === "extension_ui_response" && server.rejectAnswer) return Response.json({ error: "Answer every question" }, { status: 400 });
    if (command) return Response.json({ success: true, data: {} });
    if (url.includes("?state=")) return Response.json({ running: server.running, state: { isStreaming: server.running } });
    if (!server.started) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ sessionId: url.split("/").at(-1), filePath: "/native/profile/projects/p/session.jsonl", tree: [], leafId: null, context: { messages: server.history, entryIds: server.history.map((message) => message.nativeId), oldestEntryId: null, hasMore: false, turnsBefore: 0, thinkingLevel: "high", model: { provider: "example", modelId: "profile-one" } } });
  };
  const hook = renderHook(useAgentSession, { harness: "claude-code", harnessModel: { provider: "example", modelId: "profile-one" }, session: null, newSessionCwd: "/project", newSessionDraftKey: "new:claude-test", onSessionCreated: (session) => created.push(session) });
  t.after(() => { hook.unmount(); for (const source of sources) source.close(); Object.assign(globalThis, previous); });
  const connect = () => sources.at(-1).emit({ type: "connected", isStreaming: false, pendingExtensionUiIds: [] });
  return { hook, sources, requests, created, server, connect };
}

for (const switchAway of [false, true]) {
  test(`a first native prompt uses its own profile and survives navigation (${switchAway})`, async (t) => {
    const state = setup(t);
    const sending = state.hook.result.handleSend("hello native");
    await settle();
    assert.match(state.sources[0].url, /^\/api\/claude-code\/.+\/events$/);
    if (switchAway) state.hook.unmount();
    else state.connect();
    await sending;
    await settle();
    const command = state.requests.find((request) => request.command?.type === "prompt").command;
    assert.equal(command.model, "profile-one");
    assert.equal(command.provider, "example");
    assert.equal(state.created[0].harness, "claude-code");
    assert.equal(state.created[0].modelId, "profile-one");
    assert.equal(state.created[0].path, "/native/profile");
  });
}

test("native questions answer through the native route and a rejected answer stays visible", async (t) => {
  const state = setup(t);
  const sending = state.hook.result.handleSend("ask me");
  await settle(); state.connect(); await sending; await settle(); state.hook.flush();
  const source = state.sources.at(-1);
  source.emit({ type: "agent_start" });
  source.emit({ type: "extension_ui_request", id: "question", method: "editor", title: "Claude Code", prefill: "{}", questions: [{ question: "Pick", header: "Pick", options: [{ label: "A", description: "A" }], multiSelect: false }] });
  state.hook.flush();
  const question = state.hook.result.extensionDialog;
  assert.equal(question.id, "question");
  state.server.rejectAnswer = true;
  await state.hook.result.respondToExtensionUi(question, { value: "{}" });
  state.hook.flush();
  assert.equal(state.hook.result.extensionDialog.id, "question");
  state.server.rejectAnswer = false;
  await state.hook.result.respondToExtensionUi(question, { value: '{"Pick":"A"}' });
  state.hook.flush();
  assert.equal(state.hook.result.extensionDialog, null);
  const answers = state.requests.filter((request) => request.command?.type === "extension_ui_response");
  assert.equal(answers.at(-1).command.id, "question");
  assert.equal(answers.at(-1).command.value, '{"Pick":"A"}');
});

test("steering and follow-ups ride the native prompt route", async (t) => {
  const state = setup(t);
  const sending = state.hook.result.handleSend("first");
  await settle(); state.connect(); await sending; await settle(); state.hook.flush();
  state.sources.at(-1).emit({ type: "agent_start" });
  state.hook.flush();

  await state.hook.result.handleSteer("steer now");
  await state.hook.result.handleFollowUp("later");
  await settle();
  const queued = state.requests.filter((request) => request.command?.streamingBehavior);
  assert.deepEqual(
    queued.map((request) => [request.command.streamingBehavior, request.command.message]),
    [["steer", "steer now"], ["followUp", "later"]],
  );
  assert.equal(queued[0].command.cwd, "/project");
  assert.equal(queued[0].command.provider, "example");
  assert.equal(queued[0].command.model, "profile-one");
  assert.match(queued[0].command.promptId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  state.sources.at(-1).emit({ type: "queue_update", steering: ["steer now"], followUp: ["later"] });
  state.hook.flush();
  assert.deepEqual(state.hook.result.queuedMessages, { steering: ["steer now"], followUp: ["later"] });

  await state.hook.result.handleRecallQueue();
  await settle();
  assert.equal(state.requests.at(-1).command.type, "clear_queue");
  state.hook.flush();
  assert.deepEqual(state.hook.result.queuedMessages, { steering: [], followUp: [] });
});

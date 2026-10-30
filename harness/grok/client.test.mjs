import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const shim = fileURLToPath(new URL("../../hooks/__fixtures__/react-hook-shim.mjs", import.meta.url));
const { renderHook } = await import(shim);
const { useAgentSession } = await createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shim } }).import("../../hooks/useAgentSession.ts");
const settle = async (hook) => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  hook.flush();
};

function setup(t) {
  const previous = { fetch: globalThis.fetch, EventSource: globalThis.EventSource, document: globalThis.document, window: globalThis.window };
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  globalThis.window = new EventTarget();
  const sources = [], requests = [], restored = [], created = [], completions = [];
  const server = { running: false, history: [], queuedMessages: { steering: [], followUp: [] }, recalled: {}, failNext: false };
  globalThis.EventSource = class {
    readyState = 0;
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.readyState = 2; }
    emit(event) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(event) }); }
  };
  globalThis.fetch = async (url, options = {}) => {
    assert.match(url, /^\/api\/grok\//, "Grok must never send or reconcile through pi");
    const command = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, command });
    if (server.failNext) { server.failNext = false; throw new TypeError("Failed to fetch"); }
    if (command?.type === "prompt") {
      server.running = true;
      if (command.streamingBehavior) server.queuedMessages[command.streamingBehavior === "steer" ? "steering" : "followUp"].push(command.message);
      else server.history.push({ role: "user", content: command.message });
      return Response.json({ success: true, data: { sessionFile: "/native/chat_history.jsonl", queued: Boolean(command.streamingBehavior) } });
    }
    if (command?.type === "clear_queue") {
      server.queuedMessages = { steering: [], followUp: [] };
      return Response.json({ success: true, data: server.recalled });
    }
    if (command) return Response.json({ success: true, data: {} });
    if (url.includes("?state=1")) return Response.json({ running: server.running, state: { isStreaming: server.running, queuedMessages: server.queuedMessages } });
    return Response.json({ sessionId: url.split("/").at(-1).split("?")[0], filePath: "/native/chat_history.jsonl", tree: [], leafId: null, context: { messages: server.history, entryIds: [], oldestEntryId: null, hasMore: false, turnsBefore: 0, thinkingLevel: "off", model: { provider: "grok", modelId: "grok-test" } } });
  };
  const hook = renderHook(useAgentSession, {
    t: (key) => key,
    harness: "grok", harnessModel: { provider: "grok", modelId: "grok-test" }, session: null,
    newSessionCwd: "/project", newSessionDraftKey: "new:grok-test",
    chatInputRef: { current: { rekeyDraft() {}, restoreSubmission: (...args) => restored.push(args), prependText: (text) => restored.push([text]) } },
    onSessionCreated: (session) => created.push(session), onAgentEnd: (event) => completions.push(event),
  });
  t.after(() => { hook.unmount(); for (const source of sources) source.close(); Object.assign(globalThis, previous); });
  const emit = (event) => { sources.at(-1).emit(event); hook.flush(); };
  const start = async () => {
    const sending = hook.result.handleSend("first");
    emit({ type: "connected", isStreaming: true });
    await sending;
    await settle(hook);
  };
  return { hook, sources, requests, restored, created, completions, server, emit, start };
}

test("Grok sends, steers, queues and reconciles without touching pi or completing between turns", async (t) => {
  const state = setup(t);
  await state.start();
  assert.match(state.sources[0].url, /^\/api\/grok\/.+\/events\?model=grok-test$/);
  assert.equal(state.created[0].harness, "grok");
  assert.equal(state.hook.result.agentRunning, true);
  const images = [{ data: "aW1hZ2U=", mimeType: "image/png" }];
  await state.hook.result.handleSteer("now", images);
  await state.hook.result.handleFollowUp("later");
  await state.hook.result.handlePromptWithStreamingBehavior("/native-command", "followUp");
  await settle(state.hook);
  const queued = state.requests.filter((request) => request.command?.streamingBehavior).map((request) => request.command);
  assert.deepEqual(queued.map((command) => [command.streamingBehavior, command.message]), [["steer", "now"], ["followUp", "later"], ["followUp", "/native-command"]]);
  assert.equal(queued[0].cwd, "/project");
  assert.equal(queued[0].model, "grok-test");
  assert.deepEqual(queued[0].images, images);
  assert.equal(state.hook.result.messages.length, 1, "queued prompts must not create premature user bubbles");
  state.emit({ type: "queue_update", ...state.server.queuedMessages });
  assert.deepEqual(state.hook.result.queuedMessages, state.server.queuedMessages);
  state.emit({ type: "agent_start" });
  state.emit({ type: "message_end", message: { role: "user", content: "now" } });
  assert.equal(state.completions.length, 0);

  globalThis.window.dispatchEvent(new Event("online"));
  await settle(state.hook);
  assert.ok(state.requests.some((request) => request.url.endsWith("?state=1")));
  assert.equal(state.hook.result.agentRunning, true);
  assert.deepEqual(state.hook.result.queuedMessages, state.server.queuedMessages);
  state.server.running = false;
  state.server.queuedMessages = { steering: [], followUp: [] };
  globalThis.window.dispatchEvent(new Event("online"));
  await settle(state.hook);
  assert.equal(state.hook.result.agentRunning, false);
  assert.equal(state.completions.length, 1);
  assert.equal(state.requests.filter((request) => request.command?.type === "prompt").length, 4, "status recovery must not resend prompts");
});

test("Grok recall returns text and images, failed queued sends restore the draft, and Stop uses Grok", async (t) => {
  const state = setup(t);
  await state.start();
  const images = [{ data: "aW1hZ2U=", mimeType: "image/png" }];
  state.server.recalled = { steering: ["now"], followUp: ["later"], images };
  state.emit({ type: "queue_update", steering: ["now"], followUp: ["later"] });
  await state.hook.result.handleRecallQueue();
  await settle(state.hook);
  assert.deepEqual(state.hook.result.queuedMessages, { steering: [], followUp: [] });
  assert.deepEqual(state.restored.at(-1).slice(0, 2), ["now\n\nlater", images]);
  state.server.failNext = true;
  await state.hook.result.handleSteer("keep this", images);
  assert.deepEqual(state.restored.at(-1).slice(0, 2), ["keep this", images]);
  await state.hook.result.handleAbort();
  assert.equal(state.requests.at(-1).command.type, "abort");
});

test("the composer exposes Grok streaming controls", () => {
  const source = readFileSync(new URL("../../components/ChatWindow.tsx", import.meta.url), "utf8");
  const expression = /const supportsStreamingPrompts = (.+);/.exec(source)?.[1];
  assert.ok(expression);
  const supports = new Function("composerHarness", "foreignHarness", `return ${expression};`);
  for (const harness of ["pi", "claude-code", "dsh", "grok", "omp"]) assert.equal(supports(harness, harness !== "pi"), true);
  assert.equal(supports("unsupported", true), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const shim = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const { renderHook } = await import(shim);
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shim } });
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const settle = async (hook) => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); hook.flush(); };

for (const harness of ["pi", "claude-code", "dsh", "grok", "omp"]) {
  test(`${harness}: steer, follow-up, image recall, lost-send draft recovery and status stay on the correct runtime`, async (t) => {
    const previous = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window, EventSource: globalThis.EventSource };
    globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    globalThis.window = new EventTarget();
    const id = `${harness}-queue-ui`, endpoint = `/api/${harness === "pi" ? "agent" : harness}/${id}`;
    const requests = [], sources = [], restored = [], completions = [];
    let running = true, failNext = false;
    const images = [{ data: "eA==", mimeType: "image/png" }];
    let queuedMessages = { steering: ["now"], followUp: ["later"] };
    const state = () => ({ running, state: { isStreaming: running, isPromptRunning: false, queuedMessages } });
    const view = () => ({ sessionId: id, filePath: "/native.jsonl", tree: [], leafId: null, totalActiveMs: 0,
      context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, turnsBefore: 0, thinkingLevel: "off", model: { provider: "test", modelId: "model" } }, ...state() });
    globalThis.EventSource = class {
      readyState = 0;
      constructor(url) { this.url = url; sources.push(this); }
      close() { this.readyState = 2; }
      emit(event) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(event) }); }
    };
    globalThis.fetch = async (url, options = {}) => {
      const command = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, command });
      if (url.startsWith("/api/models")) { assert.ok(harness === "pi" || harness === "omp"); return Response.json({ models: {}, modelList: [] }); }
      if (harness === "pi" && url.startsWith(`/api/sessions/${id}`)) return Response.json(url.endsWith("/state") ? state() : view());
      assert.ok(url.startsWith(endpoint), `${harness} must not touch another harness: ${url}`);
      if (!command) return Response.json(url.includes("state=1") || url.includes("systemPrompt=0") ? state() : view());
      if (failNext && command.type === "prompt") { failNext = false; throw new TypeError("Network lost after dispatch"); }
      if (command.type === "clear_queue") return Response.json({ success: true, data: { ...queuedMessages, images } });
      return Response.json({ success: true, data: command.type === "get_tools" ? [] : {} });
    };
    const hook = renderHook(useAgentSession, {
      harness, session: { id, harness, cwd: "/project", path: "/native.jsonl", modelProvider: "test", modelId: "model" }, t: (key) => key,
      chatInputRef: { current: { restoreSubmission: (...args) => restored.push(args), prependText: (text) => restored.push([text]) } },
      onAgentEnd: (value) => completions.push(value),
    });
    t.after(() => { hook.unmount(); for (const source of sources) source.close(); Object.assign(globalThis, previous); });
    sources[0].emit({ type: "connected", isStreaming: true });
    await settle(hook);
    assert.equal(hook.result.agentRunning, true);
    await hook.result.handleSteer("now", images);
    await hook.result.handleFollowUp("later");
    const prompts = requests.filter(({ command }) => command?.type === "prompt");
    assert.deepEqual(prompts.map(({ command }) => [command.streamingBehavior, command.message]), [["steer", "now"], ["followUp", "later"]]);
    assert.ok(prompts.every(({ url }) => url === endpoint));
    assert.equal(prompts[0].command.images[0].data, images[0].data);
    sources[0].emit({ type: "queue_update", ...queuedMessages }); await settle(hook);
    assert.deepEqual(hook.result.queuedMessages, queuedMessages);
    await hook.result.handleRecallQueue(); await settle(hook);
    assert.deepEqual(restored.at(-1).slice(0, 2), ["now\n\nlater", images]);
    assert.deepEqual(hook.result.queuedMessages, { steering: [], followUp: [] });
    failNext = true;
    await hook.result.handleFollowUp("never lose this", images); await settle(hook);
    assert.deepEqual(restored.at(-1).slice(0, 2), ["never lose this", images]);
    assert.equal(requests.filter(({ command }) => command?.type === "prompt").length, 3, "never auto-resend an unconfirmed prompt");
    queuedMessages = { steering: [], followUp: [] }; running = false;
    globalThis.window.dispatchEvent(new Event("online")); await settle(hook);
    assert.equal(hook.result.agentRunning, false);
    assert.ok(requests.some(({ url }) => url === (harness === "pi" ? `${endpoint}?systemPrompt=0` : `${endpoint}?state=1`)));
    assert.equal(completions.length, 1);
  });
}

test("native transports reject malformed success responses instead of silently losing queue messages", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  for (const [file, method] of [["../lib/dsh-client.ts", "sendDshCommand"], ["../lib/grok-client.ts", "sendGrokCommand"], ["../lib/claude-code-client.ts", "sendClaudeCommand"], ["../harness/omp/client/api.ts", "sendOmpCommand"]]) {
    const client = await jiti.import(file);
    for (const response of [() => Response.json({}), () => Response.json(null), () => new Response("not JSON")]) {
      let count = 0;
      globalThis.fetch = async () => { count++; return response(); };
      await assert.rejects(client[method]("s", { type: "prompt", message: "keep this", streamingBehavior: "followUp" }), (error) => error instanceof TypeError && /unconfirmed/.test(error.message));
      assert.equal(count, 1);
    }
  }
});

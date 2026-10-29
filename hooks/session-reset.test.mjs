import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const shim = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shim } });
const { renderHook } = await import(shim);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };
const json = (body) => Response.json(body);
const model = { provider: "current", modelId: "chosen" };

function setup(harness, toolNames, offerCurrentModel = true) {
  const requests = [];
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  globalThis.window = Object.assign(new EventTarget(), { localStorage: { getItem: () => "full", setItem() {} } });
  globalThis.EventSource = class {
    readyState = 0;
    constructor() {
      queueMicrotask(() => {
        this.readyState = 1;
        this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) });
      });
    }
    close() { this.readyState = 2; }
  };
  globalThis.fetch = async (url, init = {}) => {
    const command = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, command });
    if (url.startsWith("/api/models")) return json({
      models: {}, modelList: [...(offerCurrentModel ? [{ provider: "current", id: "chosen" }] : []), { provider: "default", id: "other" }],
      defaultModel: { provider: "default", modelId: "other" },
      projectModelPreference: { provider: "default", modelId: "other" },
      defaultThinkingLevel: "high",
    });
    if (url === "/api/agent/new") return json({ sessionId: "fresh", model, thinkingLevel: "off" });
    if (command) return json({ success: true, data: command.type === "get_tools" || command.type === "get_commands" ? [] : null });
    if (url.includes("/lease")) return json({ running: false });
    const state = { model: { provider: model.provider, id: model.modelId }, thinkingLevel: "off", isStreaming: false, isPromptRunning: false };
    if (url.startsWith("/api/agent/") || url.includes("/state")) return json({ running: false, state });
    return json({
      sessionId: "original", filePath: "/project/original", tree: [], leafId: null, toolNames,
      context: { messages: [], entryIds: [], hasMore: false, oldestEntryId: null, thinkingLevel: "off", model },
      running: false, state,
    });
  };
  return { requests, session: { id: "original", cwd: "/project", path: "/project/original", harness, modelProvider: model.provider, modelId: model.modelId } };
}

test("an idle session reports its own model, off reasoning and exact tool selection, not browser defaults", async () => {
  for (const harness of ["pi", "claude-code", "dsh", "grok"]) {
    const { session } = setup(harness, ["read", "custom_tool"]);
    let config;
    const hook = renderHook(useAgentSession, {
      session, harness, newSessionCwd: null, newSessionDraftKey: null,
      onSessionConfigChange: (_id, choices) => { config = choices; },
    });
    try {
      assert.equal(config, null, "do not reset before the authoritative config loads");
      await settle();
      hook.flush();
      assert.deepEqual(config.model, model);
      if (harness === "pi") {
        assert.equal(config.thinkingLevel, "off");
        assert.deepEqual(config.toolNames, ["read", "custom_tool"]);
        assert.equal(config.toolPreset, "default");
      }
      hook.result.setAgentRunning(true);
      hook.flush();
      assert.equal(config, null, "a running session cannot be cleared accidentally");
    } finally { hook.unmount(); }
  }
});

test("the next prompt creates a different backend session with the inherited config", async () => {
  for (const [toolPreset, toolNames] of [["none", []], ["default", ["read", "custom_tool"]], ["configured", undefined]]) {
    const { requests } = setup("pi", undefined, false);
    const created = [];
    const hook = renderHook(useAgentSession, {
      session: null, harness: "pi", newSessionCwd: "/project", newSessionDraftKey: `new:${toolPreset}:/project`,
      initialNewSessionChoices: { model, preserveModel: true, thinkingLevel: "off", toolPreset, toolNames },
      onSessionCreated: (session) => created.push(session.id),
    });
    try {
      await settle();
      hook.flush();
      assert.deepEqual(hook.result.displayModel, model, "the folder's different default must not win");
      assert.equal(hook.result.thinkingLevel, "off");
      assert.equal(hook.result.toolPreset, toolPreset, "the browser's full preset must not win");
      await hook.result.handleSend("a fresh conversation");
      const creation = requests.find((request) => request.url === "/api/agent/new").command;
      assert.equal(creation.cwd, "/project");
      assert.equal(creation.provider, model.provider);
      assert.equal(creation.modelId, model.modelId);
      assert.equal(creation.thinkingLevel, "off");
      assert.deepEqual(creation.toolNames, toolNames);
      assert.deepEqual(created, ["fresh"]);
      assert.ok(requests.some(({ url, command }) => url === "/api/agent/fresh" && command?.type === "prompt"));
      assert.ok(!requests.some(({ url, command }) => url.includes("original") && command));
    } finally { hook.unmount(); }
  }
});

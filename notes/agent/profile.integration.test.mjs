import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(path.join(tmpdir(), "pi-web-notes-profile-"));
const agentDir = path.join(root, "agent");
const vault = path.join(root, "vault");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(root, "sessions");
process.env.CODING_AGENT_WEB_DATA = path.join(root, "data.db");
process.env.CODING_AGENT_WEB_NOTES_DIR = vault;
await mkdir(agentDir, { recursive: true });
await mkdir(path.join(vault, ".pi"), { recursive: true });
const settingsPath = path.join(agentDir, "settings.json");
const globalSettings = JSON.stringify({
  defaultProvider: "notes-test",
  defaultModel: "preferred",
  defaultThinkingLevel: "high",
  modelThinkingLevels: { "notes-test/preferred": "low" },
  defaultTools: ["bash", "write"],
  packages: ["/must-not-load-coding-packages"],
});
await writeFile(settingsPath, globalSettings);
await writeFile(path.join(vault, ".pi", "settings.json"), JSON.stringify({ defaultModel: "fallback" }));
await writeFile(path.join(agentDir, "auth.json"), "{}");
await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
  providers: {
    "notes-test": {
      baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "test-only",
      models: [{ id: "fallback" }, { id: "preferred", reasoning: true }],
    },
  },
}));
after(() => rm(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createNotesSession } = await jiti.import("./profile.ts");
const { sessionDigestPrompt } = await jiti.import("./digest.ts");
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { AssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore } = await import("@earendil-works/pi-ai");
// A hot reload may still hold the old notes provider, including its retired key.
globalThis.__piWebNotesModelRuntime = Promise.resolve({ refresh() { throw new Error("Do not reuse the retired notes runtime"); } });

test("a board-only session receives drawing skill bodies without a file reader", async (t) => {
  const { session } = await createNotesSession({
    systemPrompt: sessionDigestPrompt("方案.excalidraw", "画出最终方案"),
    skills: ["excalidraw-diagram", "whiteboard-drawing"],
    tools: ["notes_board"],
    onlyBoard: "方案.excalidraw",
  });
  t.after(() => session.dispose());
  assert.deepEqual(session.getActiveToolNames(), ["notes_board"]);
  for (const name of ["excalidraw-diagram", "whiteboard-drawing"]) {
    const body = await readFile(path.join(process.cwd(), "notes", "skills", name, "SKILL.md"), "utf8");
    assert.ok(session.systemPrompt.includes(body), `${name} must be readable in the prompt itself`);
  }
  assert.doesNotMatch(session.systemPrompt, /name: note-writing|<available_skills>/);
});

test("notes inherits global model defaults in memory, not vault or coding resource settings", async (t) => {
  const { session, modelLabel } = await createNotesSession({ tools: [], skills: [] });
  t.after(() => session.dispose());
  assert.equal(session.model?.provider, "notes-test");
  assert.equal(session.model?.id, "preferred");
  assert.equal(modelLabel, "notes-test/preferred");
  assert.equal(session.thinkingLevel, "low");
  assert.deepEqual(session.getActiveToolNames(), []);
  assert.doesNotMatch(session.systemPrompt, /name: (whiteboard|excalidraw)-/);
  assert.equal(session.settingsManager.getGlobalSettings().packages, undefined);
  assert.equal(session.settingsManager.getGlobalSettings().defaultTools, undefined);
  session.settingsManager.setDefaultModel("memory-only");
  await session.settingsManager.flush();
  assert.equal(await readFile(settingsPath, "utf8"), globalSettings);
});

test("digest inherits a live model and its provider auth, but keeps the independent pi agent and skills", async (t) => {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
  const requests = [];
  const target = "source-board.excalidraw";
  const { createItem, readItem } = await jiti.import("../files.ts");
  await createItem("", target, "board");
  runtime.registerProvider("source-extension", {
    api: "notes-test-stream", apiKey: "source-secret", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "selected", name: "Selected", input: ["text"], reasoning: false, contextWindow: 200000, maxTokens: 12000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      requests.push({ model, context, options });
      const drawing = requests.length === 1;
      const message = { role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason: drawing ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: drawing ? [{ type: "toolCall", id: "draw-1", name: "notes_board", arguments: { path: target, action: "draw", elements: [{ type: "text", x: 0, y: 0, label: "来源模型" }] } }] : [{ type: "text", text: "已写入" }] };
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); });
      return stream;
    },
  });
  const sourceModel = runtime.getModel("source-extension", "selected");
  const sourceMessages = [{ role: "user", content: "Original conversation stays untouched" }];
  const source = { model: sourceModel, modelRuntime: runtime, messages: sourceMessages, systemPrompt: "CODING_INSTRUCTIONS_MUST_NOT_LEAK" };
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map([["source-live", { isAlive: () => true, inner: source }]]);
  t.after(() => { globalThis.__piSessions = previous; });
  // The background profile uses exactly the same factory as the button; only its model source differs.
  const { session, modelLabel } = await createNotesSession({ sourceSessionId: "source-live", systemPrompt: sessionDigestPrompt(target, "画出结论"), skills: ["excalidraw-diagram", "whiteboard-drawing"], tools: ["notes_board"], onlyBoard: target });
  t.after(() => session.dispose());
  assert.equal(session.modelRuntime, runtime);
  assert.equal(session.model?.id, "selected");
  assert.equal(session.model?.contextWindow, 200000);
  assert.equal(modelLabel, "source-extension/selected");
  assert.notEqual(session.sessionId, "source-live");
  assert.equal(session.messages.length, 0);
  assert.deepEqual(session.getActiveToolNames(), ["notes_board"]);
  assert.match(session.systemPrompt, /name: excalidraw-diagram/);
  assert.match(session.systemPrompt, /name: whiteboard-drawing/);
  assert.doesNotMatch(session.systemPrompt, /CODING_INSTRUCTIONS_MUST_NOT_LEAK|name: note-writing/);
  await session.prompt("画出结论");
  assert.match((await readItem(target)).content, /来源模型/);
  assert.equal(requests.length, 2, "pi must execute the board tool and ask the same model for its final reply");
  assert.ok(requests.every((request) => request.options.apiKey === "source-secret"));
  assert.deepEqual(sourceMessages, [{ role: "user", content: "Original conversation stays untouched" }]);
  assert.equal(await readFile(settingsPath, "utf8"), globalSettings);
  const sessionDir = path.join(agentDir, "sessions", "source");
  const transcriptFile = path.join(sessionDir, "source-live.jsonl");
  const transcript = [
    { type: "session", version: 3, id: "source-live", cwd: root, timestamp: new Date().toISOString() },
    { type: "message", id: "u1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "把来源模型的结论画到板上" } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await mkdir(sessionDir, { recursive: true });
  await writeFile(transcriptFile, transcript);
  const { invalidateSessionListCache } = await jiti.import("../../lib/session-reader.ts");
  invalidateSessionListCache();
  requests.length = 0;
  const { digestSession } = await jiti.import("./digest.ts");
  const result = await digestSession("source-live", { boardPath: target, focus: "画出结论" });
  assert.equal(result.board, target);
  assert.equal(requests.length, 2, "the actual digest must pass its source session to the independent pi agent");
  assert.ok(requests.every((request) => request.options.apiKey === "source-secret"));
  assert.equal(await readFile(transcriptFile, "utf8"), transcript, "digest must not append to the source conversation");
});

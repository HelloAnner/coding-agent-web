import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { createJiti } from "jiti";

const root = await realpath(await mkdtemp(path.join(tmpdir(), "notes-model-source-")));
const agentDir = path.join(root, "pi");
const project = path.join(root, "project");
process.env.CODING_AGENT_WEB_DATA = path.join(root, "data.db");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(agentDir, "sessions");
process.env.DSH_HOME = path.join(root, "dsh");
process.env.DSH_DS_TOML = path.join(root, "ds.toml");
await mkdir(agentDir, { recursive: true });
await mkdir(project, { recursive: true });
await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "pi-route", defaultModel: "default" }));
await writeFile(path.join(agentDir, "auth.json"), "{}");
await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "pi-route": { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "pi-secret", models: [{ id: "default" }, { id: "saved" }] } } }));
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { upsertCatalogSession, closeCatalogDb } = await jiti.import("../../lib/catalog-db.ts");
const { codingSessionModel } = await jiti.import("./model.ts");
const { invalidateSessionListCache } = await jiti.import("../../lib/session-reader.ts");
after(async () => { closeCatalogDb(); await rm(root, { recursive: true, force: true }); });

async function piSession(id, model) {
  const directory = path.join(agentDir, "sessions", "project");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${id}.jsonl`);
  const timestamp = new Date().toISOString();
  await writeFile(file, [
    { type: "session", version: 3, id, cwd: project, timestamp },
    { type: "model_change", id: "model", parentId: null, timestamp, provider: "pi-route", modelId: model },
    { type: "message", id: "user", parentId: "model", timestamp, message: { role: "user", content: "Draw this conversation" } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  upsertCatalogSession({ id, harness: "pi", cwd: project, provider: "stale-index", model: "wrong", sessionPath: file });
  invalidateSessionListCache();
  return file;
}

test("an idle pi source uses its saved model rather than the index or defaults, without writing history", async () => {
  const file = await piSession("saved-source", "saved");
  const before = await readFile(file, "utf8");
  const { model, runtime } = await codingSessionModel("saved-source");
  assert.equal(model.provider, "pi-route");
  assert.equal(model.id, "saved");
  assert.equal((await runtime.getAuth(model)).auth.apiKey, "pi-secret");
  assert.equal(await readFile(file, "utf8"), before);
});

test("a missing or unavailable source never falls back to the default model", async () => {
  await assert.rejects(() => codingSessionModel("missing-source"), /找不到来源对话/);
  await piSession("removed-model", "not-configured");
  await assert.rejects(() => codingSessionModel("removed-model"), /来源模型不可用/);
});

test("OMP reuses the same pi model configuration without opening an OMP agent", async () => {
  upsertCatalogSession({ id: "omp-source", harness: "omp", cwd: project, provider: "pi-route", model: "saved", sessionPath: path.join(root, "omp.jsonl"), profilePath: path.join(root, "omp") });
  const { model, runtime } = await codingSessionModel("omp-source");
  assert.equal(model.id, "saved");
  assert.equal((await runtime.getAuth(model)).auth.apiKey, "pi-secret");
});

const claudeId = "11111111-1111-4111-8111-111111111111";
const claudeDir = path.join(root, "claude");
async function claudeProfile(env) {
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(root, "claude-code.json"), JSON.stringify({ profiles: [{ id: "gateway", provider: "custom", model: "actual-model", configDir: claudeDir, env }] }));
  upsertCatalogSession({ id: claudeId, harness: "claude-code", cwd: project, provider: "custom", model: "gateway", profilePath: claudeDir });
}

test("Claude profile identity resolves the actual API model and private bearer auth, not pi credentials", async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ headers: request.headers, body: JSON.parse(body) });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = [
      { type: "message_start", message: { id: "test", type: "message", role: "assistant", model: "actual-model", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/anthropic`;
  process.env.NOTES_TEST_CLAUDE_TOKEN = "source$!token";
  try {
    await claudeProfile({ ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: "env:NOTES_TEST_CLAUDE_TOKEN", ANTHROPIC_CUSTOM_HEADERS: "X-Source: literal$header" });
    const { model, runtime } = await codingSessionModel(claudeId);
    assert.equal(model.id, "actual-model", "the catalog stores a profile id, not a model name");
    assert.equal(model.baseUrl, baseUrl);
    assert.equal(model.api, "anthropic-messages");
    const auth = await runtime.getAuth(model);
    assert.equal(auth.auth.headers.Authorization, "Bearer source$!token");
    assert.equal(auth.auth.headers["X-Source"], "literal$header");
    assert.equal(auth.auth.apiKey, "");
    const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] }, { maxTokens: 16 });
    assert.equal(result.stopReason, "stop");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.model, "actual-model");
    assert.equal(requests[0].headers.authorization, "Bearer source$!token");
    assert.equal(requests[0].headers["x-source"], "literal$header");
    assert.equal(await readFile(path.join(agentDir, "auth.json"), "utf8"), "{}");
  } finally { delete process.env.NOTES_TEST_CLAUDE_TOKEN; }
});

test("nonportable native authentication is refused rather than replaced with pi's key", async () => {
  await claudeProfile({});
  await assert.rejects(() => codingSessionModel(claudeId), /原生登录或 apiKeyHelper/);
  upsertCatalogSession({ id: "grok-source", harness: "grok", cwd: project, provider: "grok", model: "native" });
  await assert.rejects(() => codingSessionModel("grok-source"), /原生模型认证暂不能/);
});

test("dsh Notes borrows native gateway metadata and explicit credentials, never legacy TUI configuration", async () => {
  process.env.NOTES_TEST_GATEWAY_KEY = "source$!key";
  const native = {
    call: async (endpoint) => endpoint === "settings/describe" ? { namespaces: [{ ns: "llm-pi-ai", value: { providers: { gateway: {
      api: "openai-responses", baseURL: "http://127.0.0.1:1/responses", apiKeyEnv: "NOTES_TEST_GATEWAY_KEY",
      headers: { "X-Source": "literal$header" }, compat: { supportsMaxOutputTokens: false },
      models: [{ id: "actual-model", contextWindow: 90000, maxTokens: 12000, reasoningEfforts: false }],
    } } } }] } : { NOTES_TEST_GATEWAY_KEY: { configured: true, source: "env" } },
  };
  globalThis[Symbol.for("coding-agent-web.dshWebHost")] = native;
  upsertCatalogSession({ id: "dsh-source", harness: "dsh", cwd: project, provider: "gateway", model: "actual-model" });
  const { model, runtime } = await codingSessionModel("dsh-source");
  assert.equal(model.api, "openai-responses");
  assert.equal(model.baseUrl, "http://127.0.0.1:1/responses");
  assert.equal(model.contextWindow, 90000);
  assert.equal(model.maxTokens, 12000);
  assert.equal(model.compat.supportsMaxOutputTokens, false);
  const auth = await runtime.getAuth(model);
  assert.equal(auth.auth.apiKey, "source$!key");
  assert.equal(auth.auth.headers["X-Source"], "literal$header");
  native.call = async () => { throw new Error("secret-token"); };
  await assert.rejects(() => codingSessionModel("dsh-source"), (error) => /无法安全读取/.test(error.message) && !error.message.includes("secret-token"));
  delete globalThis[Symbol.for("coding-agent-web.dshWebHost")];
  delete process.env.NOTES_TEST_GATEWAY_KEY;
});

test("notes settings remove only model configuration, retaining skills, whiteboard options and the independent panel", async () => {
  const { getNotesSettings, saveNotesSettings } = await jiti.import("./index.ts");
  const state = await (await getNotesSettings()).json();
  assert.deepEqual(Object.keys(state).sort(), ["fonts", "settings", "skills"]);
  assert.deepEqual(Object.keys(state.settings), ["board"]);
  assert.ok(state.skills.some((skill) => skill.name === "whiteboard-drawing"));
  const history = [{ id: "keep", role: "user", text: "Keep the standalone notes conversation" }];
  globalThis.__piWebNotesHistory = history;
  const saved = await (await saveNotesSettings(new Request("http://localhost/api/notes/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: { model: "ignored", apiKey: "never-save" }, board: { fontSize: 26 } }),
  }))).json();
  assert.equal(saved.settings.board.fontSize, 26);
  assert.equal(globalThis.__piWebNotesHistory, history, "saving board preferences must not clear the notes panel");
  assert.doesNotMatch(JSON.stringify(saved), /never-save|apiKey|effective/);
  const ui = await readFile(new URL("../ui/NotesSettingsDialog.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(ui, /API Key|baseUrl|draft\.agent|Agent 模型/);
  assert.match(ui, /id: "board"/);
  assert.match(ui, /id: "skills"/);
  assert.match(await readFile(new URL("../ui/NotesApp.tsx", import.meta.url), "utf8"), /<NotesAgentPanel/);
});

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const previous = { ...process.env };
const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-web-route-")));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.CODING_AGENT_WEB_DATA = join(root, "web", "data.db");
process.env.PI_WEB_CLAUDE_BIN = join(root, "must-not-start");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const route = await jiti.import("./[id]/route.ts");
const eventsRoute = await jiti.import("./[id]/events/route.ts");
const modelsRoute = await jiti.import("../harnesses/[id]/models/route.ts");
const catalogRoute = await jiti.import("../catalog/sessions/route.ts");
const config = await jiti.import("../../../harness/claude-code/index.ts");
const runtime = await jiti.import("../../../harness/claude-code/runtime.ts");
const db = await jiti.import("../../../lib/catalog-db.ts");
const { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed } = await jiti.import("../../../lib/file-access.ts");
allowFileRoot(root);
after(() => {
  runtime.stopClaudeRuns(); db.closeCatalogDb();
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
});
const context = (id) => ({ params: Promise.resolve({ id }) });
const request = (id, body) => new Request(`http://localhost/api/claude-code/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const p = { id: "model-one", name: "One", provider: "example", model: "actual-model", configDir: join(root, "one"), env: { ANTHROPIC_AUTH_TOKEN: "never-return-this-key" } };
const p2 = { ...p, id: "model-two", name: "Two", configDir: join(root, "two") };

test("models endpoint creates the project-owned file then returns safe profile metadata", async () => {
  assert.equal(existsSync(config.claudeConfigFile()), false);
  const response = await modelsRoute.GET(new Request("http://localhost/api/harnesses/claude-code/models"), context("claude-code"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).models[0].model, "default");
  assert.equal(config.claudeConfigFile(), join(root, "web", "claude-code.json"));
  config.writeClaudeJson(config.claudeConfigFile(), { profiles: [p, p2] });
  const configured = await modelsRoute.GET(new Request("http://localhost/api/harnesses/claude-code/models"), context("claude-code"));
  const body = await configured.json();
  assert.equal(body.models.length, 2);
  assert.doesNotMatch(JSON.stringify(body), /never-return-this-key|ANTHROPIC_AUTH_TOKEN/);
  assert.equal(existsSync(p.configDir), false);
});

test("native sessions require validated identity, attachments and explicit workspace trust", async () => {
  assert.equal((await route.POST(request("bad-id", { type: "prompt" }), context("bad-id"))).status, 400);
  const id = randomUUID();
  const prompt = { type: "prompt", cwd: root, provider: p.provider, model: p.id, message: "hello" };
  const response = await route.POST(request(id, prompt), context(id));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).requiresTrust, true);
  assert.equal(existsSync(p.configDir), false);
  const invalid = await route.POST(request(id, { ...prompt, images: [{ data: "not base64!", mimeType: "image/png" }] }), context(id));
  assert.equal(invalid.status, 400);
  const stale = await route.POST(request(id, { type: "extension_ui_response", id: "not-pending", confirmed: true }), context(id));
  assert.equal(stale.status, 400);
  assert.match((await stale.json()).error, /no longer pending/);
  assert.equal(runtime.getClaudeRun(id).child, null);
});

test("a catalog-only Claude project stays authorized after in-memory roots are lost", async () => {
  const project = join(root, "claude-only-project");
  const outside = join(root, "not-selected");
  mkdirSync(project); mkdirSync(outside);
  db.upsertCatalogSession({ id: randomUUID(), cwd: project, harness: "claude-code", provider: p.provider, model: p.id, sessionPath: p.configDir });
  const previousRoots = globalThis.__piAdditionalAllowedRoots;
  const previousCache = globalThis.__piAllowedRootsCache;
  globalThis.__piAdditionalAllowedRoots = new Set();
  delete globalThis.__piAllowedRootsCache;
  try {
    const roots = await getAllowedFileRoots();
    assert.equal(isExistingFilePathAllowed(project, roots), true);
    assert.equal(isExistingFilePathAllowed(outside, roots), false);
  } finally { globalThis.__piAdditionalAllowedRoots = previousRoots; globalThis.__piAllowedRootsCache = previousCache; }
});

test("history and profile selection come from the pinned catalog row, not browser paths", async () => {
  const id = randomUUID();
  db.upsertCatalogSession({ id, cwd: root, harness: "claude-code", provider: p.provider, model: p.id, sessionPath: p.configDir });
  const folder = join(p.configDir, "projects", "native-project-name");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.jsonl`), [
    { type: "user", uuid: "u", parentUuid: null, message: { content: "hello" } },
    { type: "assistant", uuid: "a", parentUuid: "u", message: { id: "answer", model: "actual-model", content: [{ type: "text", text: "done" }] } },
    { type: "cost-state", totalCostUSD: 1, modelUsage: { "actual-model": { inputTokens: 10, outputTokens: 5 } } },
    { type: "cost-state", totalCostUSD: 1.25, modelUsage: { "actual-model": { inputTokens: 20, outputTokens: 10 } } },
  ].map(JSON.stringify).join("\n"));
  const response = await route.GET(new Request(`http://localhost/api/claude-code/${id}?path=/etc/passwd&cwd=/elsewhere`), context(id));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.context.messages.length, 2);
  assert.equal(body.stats.cost, 1.25);
  assert.equal(body.stats.tokens.total, 30);
  assert.deepEqual(body.context.model, { provider: p.provider, modelId: p.id });
  assert.doesNotMatch(JSON.stringify(body), /never-return-this-key/);
  const changed = await route.POST(request(id, { type: "prompt", cwd: root, provider: p2.provider, model: p2.id, message: "switch" }), context(id));
  assert.equal(changed.status, 409);
  assert.equal(db.readCatalogSession(id).model, p.id);
  config.writeClaudeJson(config.claudeConfigFile(), { profiles: [{ ...p, enabled: false }, p2] });
  assert.equal((await route.GET(new Request(`http://localhost/api/claude-code/${id}`), context(id))).status, 200, "disabled profiles keep readable history");
  const disabled = await route.POST(request(id, { type: "prompt", cwd: root, provider: p.provider, model: p.id, message: "no fallback" }), context(id));
  assert.equal(disabled.status, 400);
  config.writeClaudeJson(config.claudeConfigFile(), { profiles: [p, p2] });
});

test("SSE and catalog running states do not need to open any coding process", async () => {
  const id = randomUUID();
  const controller = new AbortController();
  controller.abort();
  const empty = await eventsRoute.GET(new Request(`http://localhost/api/claude-code/${id}/events`, { signal: controller.signal }), context(id));
  assert.equal(empty.status, 204);
  const run = runtime.getClaudeRun(id);
  run.isStreaming = true;
  run.inputs.set("waiting", { request: {}, ui: { type: "extension_ui_request", method: "confirm", id: "waiting", title: "Test", message: "Test" } });
  try {
    const state = await route.GET(new Request(`http://localhost/api/claude-code/${id}?state=1`), context(id));
    assert.equal((await state.json()).state.isStreaming, true);
    const listing = await catalogRoute.GET();
    const body = await listing.json();
    assert.ok(body.runningSessionIds.includes(id));
    assert.ok(body.awaitingInputSessionIds.includes(id));
    assert.equal(run.child, null);
  } finally { run.inputs.clear(); run.isStreaming = false; }
});

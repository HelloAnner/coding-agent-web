import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const config = await jiti.import("./index.ts");
const { ClaudeEventMapper } = await jiti.import("./events.ts");
const { parseClaudeTranscript, readClaudeTranscript } = await jiti.import("./transcript.ts");
const runtime = await jiti.import("./runtime.ts");
const titleModule = await jiti.import("./title.ts");
const db = await jiti.import("../../lib/catalog-db.ts");

function setup(t) {
  const previous = { ...process.env };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-web-test-")));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.CODING_AGENT_WEB_DATA = join(root, "web", "data.db");
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(async () => {
    runtime.stopClaudeRuns();
    await new Promise((resolve) => setTimeout(resolve, 50));
    db.closeCatalogDb();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  return root;
}

function writeProfiles(profiles) { config.writeClaudeJson(config.claudeConfigFile(), { profiles }); }
function profile(root, id = "test") { return { id, name: id, provider: "test", model: "claude-sonnet-4-5", configDir: join(root, id), env: {}, permissionMode: "manual" }; }

function waitFor(run, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error("Timed out waiting for a native CLI event")); }, 30_000);
    const stop = run.onEvent((event) => { if (predicate(event)) { clearTimeout(timer); stop(); resolve(event); } });
  });
}

test("auto creates only its own credential-free config beside the selected database", (t) => {
  const root = setup(t);
  const profiles = config.readClaudeProfiles();
  assert.equal(config.claudeConfigFile(), join(root, "web", "claude-code.json"));
  assert.equal(profiles[0].id, "default");
  assert.equal(profiles[0].permissionMode, "bypassPermissions");
  assert.equal(profiles[0].configDir, join(root, ".claude"));
  assert.equal(existsSync(join(root, ".claude")), false);
  if (process.platform !== "win32") assert.equal(statSync(config.claudeConfigFile()).mode & 0o777, 0o600);
  assert.equal(config.claudeProfileSlug("codex:gpt-6.1-sol"), "codex-gpt-6.1-sol");
  assert.equal(config.claudeProfileSlug("x".repeat(80)), "x".repeat(55) + "-9a163175");
});

test("model enumeration does not create profiles or expose env and rejects collisions", (t) => {
  const root = setup(t);
  const p = { ...profile(root), env: { ANTHROPIC_AUTH_TOKEN: "do-not-return-this-token" } };
  writeProfiles([p, { ...profile(root, "disabled"), enabled: false }]);
  const list = config.claudeCodeHarness.readModels();
  assert.equal(list.models.length, 2);
  assert.equal(list.models[0].model, p.id);
  assert.equal(list.models[1].enabled, false);
  assert.equal(JSON.stringify(list).includes("do-not-return-this-token"), false);
  assert.equal(existsSync(p.configDir), false);
  writeProfiles([p, { ...p, id: "another" }]);
  assert.throws(() => config.readClaudeProfiles(), /separate configDir/);
  writeFileSync(config.claudeConfigFile(), '{"env":"secret-token-value" invalid');
  assert.throws(() => config.readClaudeProfiles(), (error) => !error.message.includes("secret-token-value") && /Edit/.test(error.message));
});

test("profiles preserve native state, isolate routing and share only native capabilities", (t) => {
  const root = setup(t);
  const defaultDir = join(root, ".claude");
  mkdirSync(join(defaultDir, "skills"), { recursive: true });
  config.writeClaudeJson(join(root, ".claude.json"), { hasCompletedOnboarding: true, account: "do-not-copy", projects: { "/other": {} }, mcpServers: { example: { type: "http", url: "https://example.invalid/mcp" } } });
  const p = profile(root);
  p.env = { ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_AUTH_TOKEN: "env:CLAUDE_WEB_TEST_TOKEN" };
  process.env.CLAUDE_WEB_TEST_TOKEN = "local-test-token";
  process.env.ANTHROPIC_MODEL = "wrong-inherited-model";
  process.env.CLAUDE_CONFIG_DIR = "/wrong-profile";
  config.prepareClaudeProfile(p);
  const metadata = JSON.parse(readFileSync(join(p.configDir, ".claude.json"), "utf8"));
  assert.equal(metadata.hasCompletedOnboarding, true);
  assert.equal(metadata.account, undefined);
  assert.equal(metadata.projects, undefined);
  assert.ok(metadata.mcpServers.example);
  assert.equal(realpathSync(join(p.configDir, "skills")), join(defaultDir, "skills"));
  const env = config.claudeProcessEnv(p);
  assert.equal(env.ANTHROPIC_MODEL, p.model);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, p.model);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, p.model);
  assert.equal(env.CLAUDE_CONFIG_DIR, p.configDir);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "local-test-token");
  assert.equal(process.env.ANTHROPIC_MODEL, "wrong-inherited-model");
  assert.equal(config.claudeProjectTrusted(p, root), false);
  config.trustClaudeProject(p, root);
  assert.equal(config.claudeProjectTrusted(p, root), true);
  const local = { ...profile(root, "local"), model: "", configDir: defaultDir, env: {} };
  config.writeClaudeJson(join(defaultDir, "settings.json"), { env: { ANTHROPIC_BASE_URL: "http://stale.invalid" }, enabledPlugins: { keep: true } });
  config.prepareClaudeProfile(local);
  const settings = JSON.parse(readFileSync(join(defaultDir, "settings.json"), "utf8"));
  assert.deepEqual(settings.env, {});
  assert.deepEqual(settings.enabledPlugins, { keep: true });
  assert.equal(config.claudeProcessEnv(local).CLAUDE_CONFIG_DIR, undefined);
});

test("native settings links and invalid JSON are not replaced or discarded", { skip: process.platform === "win32" }, (t) => {
  const root = setup(t);
  const p = profile(root);
  mkdirSync(p.configDir);
  const target = join(root, "shared-settings.json");
  config.writeClaudeJson(target, { keep: "native-value", env: { ANTHROPIC_BASE_URL: "old" } });
  const link = join(p.configDir, "settings.json");
  symlinkSync(target, link);
  config.prepareClaudeProfile(p);
  assert.equal(realpathSync(link), target);
  assert.equal(JSON.parse(readFileSync(target, "utf8")).keep, "native-value");
  writeFileSync(target, "[]");
  assert.throws(() => config.prepareClaudeProfile(p), /Invalid Claude Code JSON/);
  assert.equal(readFileSync(target, "utf8"), "[]");
});

test("a new profile under a symlinked parent keeps its identity after creation", (t) => {
  const root = setup(t);
  const real = join(root, "real-profiles");
  mkdirSync(real);
  symlinkSync(real, join(root, "linked-profiles"), process.platform === "win32" ? "junction" : undefined);
  writeProfiles([{ ...profile(root), configDir: join(root, "linked-profiles", "new-profile") }]);
  const before = config.readClaudeProfiles()[0];
  assert.equal(before.configDir, join(real, "new-profile"));
  config.prepareClaudeProfile(before);
  assert.equal(config.readClaudeProfiles()[0].configDir, before.configDir);
});

test("native history follows the active branch and groups API content blocks", () => {
  const r = (uuid, parentUuid, type, message, extra = {}) => ({ uuid, parentUuid, type, message, ...extra });
  const records = [
    r("u", null, "user", { content: "hi" }),
    r("old", "u", "assistant", { id: "old", model: "m", content: [{ type: "text", text: "abandoned" }] }),
    r("attachment", "u", "attachment", { internal: "not-a-message" }),
    r("a", "attachment", "assistant", { id: "answer", model: "m", content: [{ type: "text", text: "working" }] }, { apiBlockIndex: 0 }),
    r("b", "a", "assistant", { id: "answer", model: "m", content: [{ type: "tool_use", id: "call", name: "Bash", input: { command: "pwd" } }] }, { apiBlockIndex: 1 }),
    r("c", "b", "user", { content: [{ type: "tool_result", tool_use_id: "call", content: "ok", is_error: false }] }),
    { type: "api-request-blob", blob: "never-render" },
  ];
  const messages = parseClaudeTranscript(records.map(JSON.stringify).join("\n") + '\n{"partial":');
  assert.equal(messages.length, 3);
  assert.equal(messages[1].content.length, 2);
  assert.equal(messages[1].nativeId, "answer");
  assert.equal(messages[2].role, "toolResult");
  assert.equal(messages[2].toolName, "Bash");
  assert.doesNotMatch(JSON.stringify(messages), /abandoned|never-render/);
});

test("compaction retains its logical history and real user XML is not hidden", () => {
  const messages = parseClaudeTranscript([
    { type: "user", uuid: "u", parentUuid: null, message: { content: "<system-reminder>literal user input</system-reminder>" } },
    { type: "system", uuid: "boundary", parentUuid: null, logicalParentUuid: "u", subtype: "compact_boundary" },
    { type: "user", uuid: "summary", parentUuid: "boundary", isMeta: true, isCompactSummary: true, message: { content: "Native compact summary" } },
    { type: "assistant", uuid: "next", parentUuid: "summary", message: { id: "next", content: [{ type: "text", text: "continue" }] } },
  ].map(JSON.stringify).join("\n"));
  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[1].customType, "compaction");
  assert.equal(messages[2].role, "assistant");
});

test("partial and complete native messages do not duplicate text; tools retain ids", () => {
  const events = [];
  const mapper = new ClaudeEventMapper((event) => events.push(event));
  const stream = (event) => mapper.push({ type: "stream_event", event });
  stream({ type: "message_start", message: { id: "a", model: "m", usage: { input_tokens: 2 } } });
  stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } });
  stream({ type: "content_block_stop", index: 0 });
  stream({ type: "message_stop" });
  mapper.push({ type: "assistant", message: { id: "a", model: "m", content: [{ type: "text", text: "hello" }] } });
  mapper.finish();
  const final = events.filter((event) => event.type === "message_end").at(-1).message;
  assert.deepEqual(final.content, [{ type: "text", text: "hello" }]);
  assert.equal(final.nativeId, "a");
  mapper.push({ type: "assistant", message: { id: "b", model: "m", content: [{ type: "tool_use", id: "call", name: "Read", input: { file_path: "x" } }] } });
  mapper.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call", content: "x", is_error: true }] } });
  assert.equal(events.find((event) => event.type === "tool_execution_end").isError, true);
  assert.equal(events.at(-1).message.toolCallId, "call");
});

test("catalog updates cannot move a Claude conversation to another profile", (t) => {
  const root = setup(t);
  const input = { id: randomUUID(), cwd: root, harness: "claude-code", provider: "test", model: "one", sessionPath: join(root, "one") };
  db.upsertCatalogSession(input);
  db.upsertCatalogSession({ ...input, title: "updated" });
  assert.throws(() => db.updateCatalogSession(input.id, { model: "two" }), /keeps its profile/);
  assert.throws(() => db.upsertCatalogSession({ ...input, sessionPath: join(root, "two") }), /keeps its profile/);
  assert.equal(db.readCatalogSession(input.id).model, "one");
});

test("native /model cannot bypass a Claude profile's fixed model", async (t) => {
  const root = setup(t);
  const p = profile(root);
  writeProfiles([p]);
  process.env.PI_WEB_CLAUDE_BIN = join(root, "not-installed");
  for (const text of ["/model", "/model another-model", " \n/model\tanother-model", "/MODEL another-model"]) {
    const id = randomUUID();
    await assert.rejects(runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text }), /model is fixed by its profile/);
    assert.equal(db.readCatalogSession(id), null);
    assert.equal(runtime.getClaudeRun(id).child, null);
    assert.equal(runtime.claudeState(id).running, false);
  }
  await assert.rejects(runtime.sendClaudePrompt({ id: randomUUID(), cwd: root, profileId: p.id, text: "/model-notes" }), /could not start/);
});

test("missing CLI fails once without losing or inventing a native session", async (t) => {
  const root = setup(t);
  const p = profile(root);
  writeProfiles([p]);
  process.env.PI_WEB_CLAUDE_BIN = join(root, "not-installed");
  const id = randomUUID();
  const events = [];
  const stop = runtime.getClaudeRun(id).onEvent((event) => events.push(event));
  t.after(stop);
  await assert.rejects(runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "hello" }), /could not start/);
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
  assert.equal(runtime.claudeState(id).running, false);
  assert.equal(db.readCatalogSession(id), null);
});

test("steer interrupts the running turn and follow-ups drain in order", { skip: process.platform === "win32" }, async (t) => {
  const root = setup(t);
  const p = profile(root);
  writeProfiles([p]);
  const log = join(root, "protocol.log");
  const binary = join(root, "queue-claude.mjs");
  writeFileSync(binary, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(log)};
const send = (r) => process.stdout.write(JSON.stringify(r)+'\\n');
let first = true;
createInterface({input:process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  if (r.type === 'control_request') {
    send({type:'control_response',response:{subtype:'success',request_id:r.request_id,response:{}}});
    if (r.request.subtype === 'interrupt') {
      appendFileSync(log, 'interrupt\\n');
      setTimeout(() => send({type:'result',subtype:'error_during_execution',is_error:true,result:'interrupted'}), 10);
    }
    return;
  }
  if (r.type !== 'user') return;
  const text = r.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  appendFileSync(log, 'user:' + text + '\\n');
  const delay = first ? 2000 : 30;
  first = false;
  setTimeout(() => send({type:'result',subtype:'success',is_error:false,result:'done'}), delay);
});
`, { mode: 0o700 });
  process.env.PI_WEB_CLAUDE_BIN = binary;
  const id = randomUUID();
  const run = runtime.getClaudeRun(id);
  const events = [];
  t.after(run.onEvent((event) => events.push(event)));
  const settled = waitFor(run, (event) => event.type === "agent_settled");

  await runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "first", promptId: randomUUID() });
  const steer = await runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "steer now", promptId: randomUUID(), streamingBehavior: "steer" });
  const follow = await runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "then this", promptId: randomUUID(), streamingBehavior: "followUp" });
  assert.equal(steer.queued, true);
  assert.equal(follow.queued, true);
  assert.deepEqual(run.queuedMessages(), { steering: ["steer now"], followUp: ["then this"] });
  assert.equal(runtime.claudeState(id).state.queuedMessages.steering[0], "steer now");
  await assert.rejects(
    runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "no behavior" }),
    /already answering/,
  );

  await settled;
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    "user:first",
    "interrupt",
    "user:steer now",
    "user:then this",
  ]);
  // One run from the browser's point of view: no completed-run flash between
  // the queued turns, and the stop button never turns into a finished run.
  assert.equal(events.filter((event) => event.type === "agent_end").length, 1);
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
  assert.equal(events.filter((event) => event.type === "agent_start").length, 3);
  assert.equal(events.filter((event) => event.type === "prompt_error").length, 0);
  assert.deepEqual(run.queuedMessages(), { steering: [], followUp: [] });
  // Delivered queued prompts surface as user messages when their turn starts.
  const delivered = events.filter((event) => event.type === "message_end" && event.message.role === "user").map((event) => event.message.content);
  assert.deepEqual(delivered, ["steer now", "then this"]);
});

test("recalling or stopping clears queued prompts before they are sent", { skip: process.platform === "win32" }, async (t) => {
  const root = setup(t);
  const p = profile(root);
  writeProfiles([p]);
  const log = join(root, "recall.log");
  const binary = join(root, "recall-claude.mjs");
  writeFileSync(binary, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(log)};
const send = (r) => process.stdout.write(JSON.stringify(r)+'\\n');
let first = true;
createInterface({input:process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  if (r.type === 'control_request') {
    send({type:'control_response',response:{subtype:'success',request_id:r.request_id,response:{}}});
    if (r.request.subtype === 'interrupt') appendFileSync(log, 'interrupt\\n');
    return;
  }
  if (r.type !== 'user') return;
  const text = r.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  appendFileSync(log, 'user:' + text + '\\n');
  const delay = first ? 500 : 20;
  first = false;
  setTimeout(() => send({type:'result',subtype:'success',is_error:false,result:'done'}), delay);
});
`, { mode: 0o700 });
  process.env.PI_WEB_CLAUDE_BIN = binary;
  const id = randomUUID();
  const run = runtime.getClaudeRun(id);
  t.after(run.onEvent(() => {}));
  await runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "first" });
  await runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "recalled", streamingBehavior: "followUp" });
  assert.deepEqual(run.clearQueue(), { steering: [], followUp: ["recalled"] });
  assert.deepEqual(run.queuedMessages(), { steering: [], followUp: [] });
  await runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "stopped too", streamingBehavior: "followUp" });
  assert.equal(run.abort(), true);
  await waitFor(run, (event) => event.type === "agent_settled");
  assert.deepEqual(run.queuedMessages(), { steering: [], followUp: [] });
  assert.equal(readFileSync(log, "utf8").trim().split("\n").filter((line) => line.startsWith("user:")).join(","), "user:first");
});

test("titles run one throwaway headless session and remove its transcript", { skip: process.platform === "win32" }, async (t) => {
  const root = setup(t);
  const p = profile(root);
  writeProfiles([p]);
  const idFile = join(root, "title-session-id");
  const argsFile = join(root, "title-args.json");
  const binary = join(root, "title-claude.mjs");
  writeFileSync(binary, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const id = args[args.indexOf('--session-id') + 1];
writeFileSync(${JSON.stringify(idFile)}, id);
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const dir = path.join(${JSON.stringify(p.configDir)}, 'projects', '-tmp');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, id + '.jsonl'), '');
process.stdout.write('修复标题生成\\n');
`, { mode: 0o700 });
  process.env.PI_WEB_CLAUDE_BIN = binary;
  const generated = await titleModule.generateClaudeTitle({ cwd: root, profileId: p.id, provider: p.provider, prompt: "name this session" });
  assert.equal(generated.trim(), "修复标题生成");
  const args = JSON.parse(readFileSync(argsFile, "utf8"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--output-format") + 1], "text");
  assert.equal(args[args.indexOf("--model") + 1], p.model);
  const id = readFileSync(idFile, "utf8");
  assert.equal(existsSync(join(p.configDir, "projects", "-tmp", `${id}.jsonl`)), false);
});

test("stopping during CLI initialization never sends the queued prompt", { skip: process.platform === "win32" }, async (t) => {
  const root = setup(t);
  const p = profile(root);
  writeProfiles([p]);
  const marker = join(root, "unexpected-prompt");
  const binary = join(root, "delayed-claude.mjs");
  writeFileSync(binary, `#!/usr/bin/env node\nimport { createInterface } from 'node:readline';\nimport { writeFileSync } from 'node:fs';\nconst send = (r) => process.stdout.write(JSON.stringify(r)+'\\n');\ncreateInterface({input:process.stdin}).on('line', line => {\n const r=JSON.parse(line);\n if(r.type==='user') writeFileSync(${JSON.stringify(marker)}, 'sent');\n if(r.type==='control_request') {\n  const reply=()=>send({type:'control_response',response:{subtype:'success',request_id:r.request_id,response:{}}});\n  if(r.request.subtype==='initialize') setTimeout(reply,80);else reply();\n }\n});\n`, { mode: 0o700 });
  process.env.PI_WEB_CLAUDE_BIN = binary;
  const id = randomUUID();
  const run = runtime.getClaudeRun(id);
  const events = [];
  t.after(run.onEvent((event) => events.push(event)));
  const sending = runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "must not be sent" });
  assert.equal(run.abort(), true);
  await assert.rejects(sending, /stopped before sending/);
  assert.equal(existsSync(marker), false);
  assert.equal(db.readCatalogSession(id), null);
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
});

// Opt in: this runs the installed, unmodified CLI against a local fake gateway.
// No real model requests, user profiles or SDKs are involved.
test("installed Claude CLI codes, asks, resumes and stops through its native protocol", { skip: !process.env.CLAUDE_CODE_TEST_BIN, timeout: 90_000 }, async (t) => {
  const binary = process.env.CLAUDE_CODE_TEST_BIN;
  const root = setup(t);
  let calls = 0;
  let lastMessages = [];
  let hold = false;
  let held;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.url?.includes("count_tokens")) { response.setHeader("content-type", "application/json"); response.end('{"input_tokens":20}'); return; }
    if (!request.url?.includes("/messages")) { response.end("{}"); return; }
    const body = JSON.parse(raw);
    lastMessages = body.messages;
    ++calls;
    if (hold) { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); held?.(); return; }
    const block = calls === 1 ? { type: "tool_use", id: "native-bash", name: "Bash", input: { command: "printf native-cli-ok > protocol.txt", description: "Write a temporary protocol check" } }
      : calls === 2 ? { type: "tool_use", id: "native-ask", name: "AskUserQuestion", input: { questions: [{ question: "Which option?", header: "Protocol", options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }], multiSelect: false }] } }
      : calls === 3 ? { type: "tool_use", id: "native-read", name: "Read", input: { file_path: join(root, "protocol.txt") } }
      : calls === 4 ? { type: "tool_use", id: "native-edit", name: "Edit", input: { file_path: join(root, "protocol.txt"), old_string: "native-cli-ok", new_string: "native-cli-edited" } }
      : { type: "text", text: `native-cli-done-${calls}` };
    const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message: { id: `message-${calls}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    event("content_block_start", { index: 0, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } });
    event("message_stop", {});
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const p = profile(root);
  p.env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_AUTH_TOKEN: "local-protocol-test", API_TIMEOUT_MS: "15000", DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  writeProfiles([p]);
  process.env.PI_WEB_CLAUDE_BIN = binary;
  const id = randomUUID();
  const run = runtime.getClaudeRun(id);
  const events = [];
  const callbackErrors = [];
  const stop = run.onEvent((event) => {
    events.push(event);
    try {
    if (event.type === "extension_ui_request" && event.method === "confirm") run.respond(event.id, { confirmed: true });
    if (event.type === "extension_ui_request" && event.questions) {
      assert.ok(runtime.claudeAwaitingInputIds().includes(id));
      assert.throws(() => run.respond(event.id, { value: "{}" }), /every question/);
      run.respond(event.id, { value: JSON.stringify({ "Which option?": "A" }) });
      assert.throws(() => run.respond(event.id, { confirmed: true }), /no longer pending/);
    }
    } catch (error) { callbackErrors.push(error); }
  });
  t.after(stop);
  const settled = waitFor(run, (event) => event.type === "agent_settled");
  const promptId = randomUUID();
  await runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "Run native tools", promptId });
  await assert.rejects(runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "overlap" }), /already answering/);
  assert.ok(runtime.claudeRunningIds().includes(id));
  await settled;
  assert.equal(readFileSync(join(root, "protocol.txt"), "utf8"), "native-cli-edited");
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
  assert.equal(events.filter((event) => event.type === "prompt_error").length, 0);
  const history = readClaudeTranscript(p.configDir, id);
  assert.ok(history.path);
  assert.equal(history.messages.find((message) => message.role === "user").nativeId, promptId);
  assert.equal(history.messages.filter((message) => message.role === "assistant").at(-1).content[0].text, "native-cli-done-5");
  const editDiff = history.messages.find((message) => message.role === "toolResult" && message.toolCallId === "native-edit").details.diff;
  assert.match(editDiff, /^-native-cli-ok$/m);
  assert.match(editDiff, /^\+native-cli-edited$/m);
  const child = run.child;
  const second = waitFor(run, (event) => event.type === "agent_settled");
  await runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "Second turn" });
  await second;
  assert.equal(run.child, child);
  assert.match(JSON.stringify(lastMessages), /Run native tools/);
  const closed = new Promise((resolve) => child.once("close", resolve));
  run.close();
  await closed;
  const resumed = waitFor(run, (event) => event.type === "agent_settled");
  await runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "Resume after restart" });
  await resumed;
  assert.match(JSON.stringify(lastMessages), /Second turn/);
  assert.equal(db.readCatalogSession(id).sessionPath, p.configDir);
  assert.deepEqual(callbackErrors, []);
  assert.ok(events.some((event) => event.type === "extension_ui_request" && event.questions));
  hold = true;
  const requestHeld = new Promise((resolve) => { held = resolve; });
  const stopped = waitFor(run, (event) => event.type === "agent_settled");
  await runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "Wait until stopped" });
  await requestHeld;
  assert.equal(run.abort(), true);
  assert.equal((await stopped).aborted, true);
  hold = false;
  const afterStop = waitFor(run, (event) => event.type === "agent_settled");
  await runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "Continue after stop" });
  await afterStop;
  assert.equal(events.filter((event) => event.type === "prompt_error").length, 0);
  // Steering is an interrupt plus the next native turn: the held response ends
  // with an error subtype, but the queued user message must survive and run.
  hold = true;
  const steerHeld = new Promise((resolve) => { held = resolve; });
  const steered = waitFor(run, (event) => event.type === "agent_settled");
  await runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "Wait for steering" });
  await steerHeld;
  hold = false;
  const queued = await runtime.sendClaudePrompt({ id, cwd: root, profileId: p.id, text: "steer mid-run", promptId: randomUUID(), streamingBehavior: "steer" });
  assert.equal(queued.queued, true);
  await steered;
  assert.match(JSON.stringify(lastMessages), /steer mid-run/);
  assert.equal(events.filter((event) => event.type === "prompt_error").length, 0);
  assert.equal(run.queuedMessages().steering.length, 0);
  // Naming runs the same CLI with tools off and cleans up its own transcript.
  const generated = await titleModule.generateClaudeTitle({ cwd: root, profileId: p.id, provider: p.provider, prompt: "name this session" });
  assert.match(generated.trim(), /^native-cli-done-\d+$/);
  run.close();
});

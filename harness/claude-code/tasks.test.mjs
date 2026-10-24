import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ClaudeTasks } = await jiti.import("./tasks.ts");
const transcript = await jiti.import("./transcript.ts");
const config = await jiti.import("./index.ts");
const runtime = await jiti.import("./runtime.ts");
const { ClaudeEventMapper } = await jiti.import("./events.ts");
const api = await jiti.import("./task-api.ts");
const db = await jiti.import("../../lib/catalog-db.ts");
const system = (subtype, fields) => ({ type: "system", subtype, ...fields });
const call = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const context = (id) => ({ params: Promise.resolve({ id }) });
const get = (id, query = "") => api.GET(new Request(`http://localhost/api/claude-code/${id}/tasks${query}`), context(id));
const post = (id, body) => api.POST(new Request(`http://localhost/api/claude-code/${id}/tasks`, { method: "POST", body: JSON.stringify(body) }), context(id));

function setup(t) {
  const previous = { ...process.env };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-web-tasks-")));
  process.env.HOME = root; process.env.USERPROFILE = root;
  process.env.CODING_AGENT_WEB_DATA = join(root, "web", "data.db");
  process.env.PI_WEB_CLAUDE_BIN = join(root, "must-not-start");
  const profile = { id: "profile-one", provider: "example", name: "One", model: "native-model", configDir: join(root, "profile") };
  config.writeClaudeJson(config.claudeConfigFile(), { profiles: [profile] });
  const id = randomUUID();
  db.upsertCatalogSession({ id, cwd: root, harness: "claude-code", provider: profile.provider, model: profile.id, sessionPath: profile.configDir });
  const project = join(profile.configDir, "projects", "encoded-project");
  mkdirSync(project, { recursive: true });
  const file = join(project, `${id}.jsonl`);
  writeFileSync(file, "");
  t.after(async () => {
    const run = runtime.findClaudeRun(id);
    const child = run?.child;
    if (child?.pid) {
      run.close();
      await new Promise((resolve) => { const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 6000); child.once("close", () => { clearTimeout(timer); resolve(); }); });
    }
    if (run) { run.child = null; run.isStreaming = false; run.inputs.clear(); run.tasks.disconnect(); }
    runtime.stopClaudeRuns(); db.closeCatalogDb();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  return { root, profile, id, project, file };
}

test("native task levels, foreground flags, Monitor identity and terminal patches stay distinct", () => {
  const tasks = new ClaudeTasks();
  tasks.observe(call("monitor-call", "Monitor", { description: "Watch deployment", command: "watch-command" }));
  tasks.observe(system("background_tasks_changed", { tasks: [{ task_id: "b-monitor", run_id: "001", task_type: "local_bash", description: "Watch deployment", ambient: true }] }));
  tasks.observe(system("task_started", { task_id: "b-monitor", run_id: "001", task_type: "local_bash", tool_use_id: "monitor-call", is_backgrounded: true }));
  assert.equal(tasks.rows.get("b-monitor").type, "monitor", "Monitor can use the native local_bash discriminant");
  assert.equal(tasks.rows.get("b-monitor").command, "watch-command");
  assert.equal(tasks.hasActivity, false, "ambient watches are live but not foreground activity");
  assert.equal(tasks.backgroundIds.size, 1);
  tasks.observe(system("task_started", { task_id: "b-front", run_id: "001", task_type: "local_bash", is_backgrounded: false }));
  assert.equal(tasks.backgroundIds.has("b-front"), false);
  tasks.observe(system("background_tasks_changed", { tasks: [] }));
  assert.equal(tasks.backgroundIds.size, 0, "a missing edge cannot wedge the activity indicator");
  assert.equal(tasks.rows.get("b-monitor").status, "unknown", "absence is not a fabricated completion");
  tasks.observe(system("task_progress", { task_id: "b-monitor", run_id: "001", description: "Late progress" }));
  assert.equal(tasks.rows.get("b-monitor").status, "unknown", "an old edge cannot override the authoritative background set");
  tasks.observe(system("task_updated", { task_id: "b-front", run_id: "001", patch: { status: "killed" } }));
  assert.equal(tasks.rows.get("b-front").status, "stopped", "stop need not emit task_notification");
  tasks.observe(system("task_updated", { task_id: "b-front", run_id: "001", patch: { status: "running" } }));
  assert.equal(tasks.rows.get("b-front").status, "stopped");
});

test("task generations reject late bookends and keep native subagent parent/progress data", () => {
  const tasks = new ClaudeTasks();
  tasks.observe(system("task_started", { task_id: "a-parent", run_id: "001", task_type: "local_agent", tool_use_id: "old-call", is_backgrounded: true }));
  tasks.observe(system("task_started", { task_id: "b-child", run_id: "001", task_type: "local_bash", parent_task_id: "a-parent", is_backgrounded: true }));
  tasks.observe(system("task_notification", { task_id: "a-parent", run_id: "001", status: "completed", summary: "First run" }));
  tasks.observe(system("task_started", { task_id: "a-parent", run_id: "002", task_type: "local_agent", tool_use_id: "new-call", is_backgrounded: true }));
  tasks.observe(system("task_progress", { task_id: "a-parent", run_id: "002", subagent_type: "Explore", last_tool_name: "Read", usage: { total_tokens: 100, tool_uses: 2, duration_ms: 700 }, summary: "Reading source" }));
  tasks.observe(system("task_notification", { task_id: "a-parent", run_id: "001", status: "stopped" }));
  tasks.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "old-call", content: "late completion" }] }, tool_use_result: { agentId: "a-parent", status: "completed" } });
  assert.equal(tasks.rows.get("a-parent").toolUseId, "new-call");
  assert.equal(tasks.rows.get("a-parent").status, "running");
  assert.equal(tasks.rows.get("a-parent").runId, "002");
  assert.deepEqual(tasks.rows.get("a-parent").usage, { totalTokens: 100, toolUses: 2, durationMs: 700 });
  assert.equal(tasks.rows.get("b-child").parentTaskId, "a-parent");
  assert.equal(tasks.hasActivity, true);
  tasks.observe(system("task_notification", { task_id: "a-legacy", status: "completed" }));
  tasks.observe(system("task_started", { task_id: "a-legacy", run_id: "003", task_type: "local_agent", is_backgrounded: true }));
  assert.equal(tasks.rows.get("a-legacy").status, "running", "a resumed task can gain run ids after a CLI upgrade");
  tasks.disconnect();
  assert.equal(tasks.hasActivity, false);
  assert.equal(tasks.rows.get("a-parent").status, "unknown");
});

test("native log recovery uses structured tool results and trusted notifications, not user XML", () => {
  const tasks = new ClaudeTasks();
  const notification = "<task-notification><task-id>b-watch</task-id><status>killed</status><summary>Stopped by user</summary></task-notification>";
  tasks.restore([
    call("watch-call", "Monitor", { command: "monitor-command", description: "Watch" }),
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "watch-call", content: "launched" }] }, toolUseResult: { taskId: "b-watch" } },
    { type: "user", message: { content: notification } },
  ]);
  assert.equal(tasks.rows.get("b-watch").status, "unknown");
  tasks.restore([
    call("watch-call", "Monitor", { command: "monitor-command", description: "Watch" }),
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "watch-call", content: "launched" }] }, toolUseResult: { taskId: "b-watch" } },
    { type: "attachment", attachment: { type: "queued_command", commandMode: "task-notification", prompt: notification } },
  ]);
  assert.equal(tasks.rows.get("b-watch").status, "stopped");
  assert.equal(tasks.rows.get("b-watch").type, "monitor");
  const names = new Map();
  assert.equal(transcript.claudeRecordMessages({ type: "user", message: { content: notification } }, names).length, 1);
  assert.equal(transcript.claudeRecordMessages({ type: "user", origin: { kind: "task-notification" }, message: { content: notification } }, names).length, 0);
});

test("task API scopes native subagent history and restores offline metadata without starting a CLI", async (t) => {
  const { id, profile, project, file } = setup(t);
  const records = [call("agent-call", "Agent", { description: "Review source", prompt: "Review only this project" }),
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "agent-call", content: "started" }] }, toolUseResult: { agentId: "a-owned", status: "async_launched", description: "Review source" } }];
  writeFileSync(file, records.map(JSON.stringify).join("\n"));
  const folder = join(project, id, "subagents"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "agent-a-owned.jsonl"), [
    { type: "user", uuid: "u", parentUuid: null, isSidechain: true, message: { content: "Review only this project" } },
    { type: "assistant", uuid: "a", parentUuid: "u", isSidechain: true, message: { id: "agent-message", content: [{ type: "thinking", thinking: "Inspecting" }, { type: "text", text: "Scoped agent result" }] } },
  ].map(JSON.stringify).join("\n"));
  const listing = await get(id, "?path=/etc/passwd&profile=other");
  assert.equal(listing.status, 200);
  const body = await listing.json();
  assert.equal(body.connected, false);
  assert.equal(body.tasks[0].type, "subagent");
  assert.equal(body.tasks[0].status, "unknown");
  const detail = await (await get(id, "?task=a-owned")).json();
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[1].content[1].text, "Scoped agent result");
  assert.equal((await get(id, "?task=a-other-profile")).status, 404);
  assert.equal((await get(id, "?task=../../etc/passwd")).status, 400);
  assert.equal((await get("not-a-uuid")).status, 400);
  assert.equal(runtime.findClaudeRun(id), undefined);
  config.writeClaudeJson(config.claudeConfigFile(), { profiles: [{ ...profile, enabled: false }] });
  assert.equal((await get(id, "?task=a-owned")).status, 200);
  assert.equal((await post(id, { action: "stop", taskId: "a-owned" })).status, 409);
  if (process.platform !== "win32") {
    const outside = join(project, "private-agent.jsonl"); writeFileSync(outside, readFileSync(join(folder, "agent-a-owned.jsonl")));
    symlinkSync(outside, join(folder, "agent-a-escape.jsonl"));
    assert.throws(() => transcript.readClaudeSubagentTranscript(profile.configDir, id, "a-escape"), /escapes/);
    symlinkSync(join(folder, "agent-a-owned.jsonl"), join(folder, "agent-a-alias.jsonl"));
    assert.throws(() => transcript.readClaudeSubagentTranscript(profile.configDir, id, "a-alias"), /does not match/);
    const alias = randomUUID(); symlinkSync(file, join(project, `${alias}.jsonl`));
    assert.throws(() => transcript.claudeTranscriptFile(profile.configDir, alias), /does not match/);
  }
});

test("task controls use native requests with session/run validation and never invent completion", async (t) => {
  const { id, profile } = setup(t);
  const run = runtime.getClaudeRun(id);
  run.profile = profile;
  run.child = { stdin: { writable: true, end() {} }, kill() {} };
  run.secrets = ["private-task-token"];
  run.tasks.observe(call("shell-call", "Bash", { command: "printf private-task-token", description: "Long command" }));
  run.tasks.observe(system("task_started", { task_id: "b-owned", run_id: "002", task_type: "local_bash", tool_use_id: "shell-call", is_backgrounded: false }));
  const requests = [];
  let backgrounded = false;
  run.request = async (request) => { requests.push(request); return request.subtype === "get_task_output" ? { output: "<script>plain text</script> private-task-token", total_bytes: 45, truncated: false } : { backgrounded }; };
  const output = await (await get(id, "?task=b-owned&run=002")).json();
  assert.equal(output.output, "<script>plain text</script> [redacted]");
  assert.doesNotMatch(JSON.stringify(await (await get(id)).json()), /private-task-token/);
  assert.equal((await post(id, { action: "stop", taskId: "b-elsewhere", runId: "002" })).status, 404);
  assert.equal((await post(id, { action: "stop", taskId: "b-owned", runId: "001" })).status, 409);
  assert.equal((await post(id, { action: "background", taskId: "b-owned", runId: "002" })).status, 409);
  backgrounded = true;
  assert.equal((await post(id, { action: "background", taskId: "b-owned", runId: "002" })).status, 200);
  assert.equal((await post(id, { action: "stop", taskId: "b-owned", runId: "002" })).status, 200);
  assert.equal(run.tasks.rows.get("b-owned").status, "running", "native events acknowledge completion, not HTTP success");
  assert.deepEqual(requests.at(-1), { subtype: "stop_task", task_id: "b-owned" });
  assert.deepEqual(requests.at(-2), { subtype: "background_tasks", tool_use_id: "shell-call" });
  run.tasks.observe(system("task_updated", { task_id: "b-owned", run_id: "002", patch: { status: "killed" } }));
  assert.equal((await post(id, { action: "stop", taskId: "b-owned", runId: "002" })).status, 409);
  run.tasks.observe(system("task_started", { task_id: "b-owned", run_id: "003", task_type: "local_bash", tool_use_id: "shell-call", is_backgrounded: false }));
  const requested = Promise.withResolvers(), outputReady = Promise.withResolvers();
  run.request = () => { requested.resolve(); return outputReady.promise; };
  const reading = get(id, "?task=b-owned&run=003");
  await requested.promise;
  run.tasks.observe(system("task_started", { task_id: "b-owned", run_id: "004", task_type: "local_bash", tool_use_id: "shell-call", is_backgrounded: false }));
  outputReady.resolve({ output: "previous-run-output" });
  assert.equal((await reading).status, 409);
  run.request = async () => ({});
  const unsupported = await get(id, "?task=b-owned&run=004");
  assert.equal(unsupported.status, 400);
  assert.match((await unsupported.json()).error, /did not return task output/);
  const malformed = await api.POST(new Request(`http://localhost/api/claude-code/${id}/tasks`, { method: "POST", body: '{"secret-json-input"' }), context(id));
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(JSON.stringify(await malformed.json()), /secret-json-input/);
});

test("background work does not lock the composer or lose approvals when a foreground turn settles", (t) => {
  const { id } = setup(t);
  const run = runtime.getClaudeRun(id);
  run.receive(system("background_tasks_changed", { tasks: [{ task_id: "b-watch", task_type: "local_bash", ambient: true }] }));
  assert.equal(runtime.claudeState(id).running, false);
  run.receive(system("background_tasks_changed", { tasks: [{ task_id: "a-worker", task_type: "local_agent", description: "Review project" }] }));
  assert.equal(runtime.claudeState(id).running, true);
  assert.equal(runtime.claudeState(id).state.isStreaming, false);
  assert.equal(run.abort(), false, "Stop only interrupts a foreground turn; tasks have their own controls");
  run.isStreaming = true;
  run.receive({ type: "control_request", request_id: "worker-permission", request: { subtype: "can_use_tool", tool_name: "Bash", agent_id: "a-worker", input: { command: "printf guard" } } });
  assert.match(run.inputs.get("worker-permission").ui.title, /Review project.*Bash/);
  run.settle();
  assert.equal(run.inputs.has("worker-permission"), true);
  assert.ok(runtime.claudeAwaitingInputIds().includes(id));
  run.receive({ type: "control_cancel_request", request_id: "worker-permission" });
  assert.equal(run.inputs.size, 0);
  const events = [];
  const mapper = new ClaudeEventMapper((event) => events.push(event));
  mapper.push(call("agent-tool", "Agent", { description: "Background worker" }));
  mapper.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: "launched" }] } });
  mapper.push({ type: "assistant", parent_tool_use_id: "agent-tool", message: { content: [{ type: "text", text: "Worker progress" }] } });
  assert.equal(events.filter((event) => event.type === "tool_execution_update").length, 0, "async work does not resurrect the ended launch tool");
});

test("native conversation switches cannot move tasks or messages under the old indexed UUID", async (t) => {
  const { id, root, profile } = setup(t);
  for (const text of ["/clear", "/reset", "/new", "/resume another-session", "/fork"]) {
    await assert.rejects(runtime.sendClaudePrompt({ id, cwd: root, profileId: profile.id, text }), /keeps its native UUID/);
  }
  const run = runtime.getClaudeRun(id);
  const errors = [];
  t.after(run.onEvent((event) => { if (event.type === "prompt_error") errors.push(event.errorMessage); }));
  run.isStreaming = true;
  run.receive(system("task_started", { session_id: randomUUID(), task_id: "b-foreign-session", task_type: "local_bash" }));
  assert.equal(run.tasks.rows.size, 0);
  assert.equal(run.isStreaming, false);
  assert.match(errors[0], /changed its native session identity/);
  assert.equal(db.readCatalogSession(id).model, profile.id);
  assert.equal(run.child, null);
});

// Uses the original installed CLI and a local fake gateway, never a real model or user profile.
test("installed CLI backgrounds shells, watches Monitor output and exposes/stops native subagents", { skip: !process.env.CLAUDE_CODE_TEST_BIN, timeout: 90_000 }, async (t) => {
  const { root, profile, id, file } = setup(t);
  unlinkSync(file);
  process.env.PI_WEB_CLAUDE_BIN = process.env.CLAUDE_CODE_TEST_BIN;
  let mainCalls = 0, childCalls = 0, hold = false, held;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    if (req.url.includes("count_tokens")) { res.end('{"input_tokens":20}'); return; }
    if (!req.url.includes("/messages")) { res.end("{}"); return; }
    const body = JSON.parse(raw);
    const userText = body.messages.filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")).join("\n");
    const child = userText.includes("native-child-probe");
    if (!child && hold && userText.includes("native-parent-hold")) { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); held?.(); return; }
    let block;
    if (child) block = ++childCalls === 1 ? { type: "tool_use", id: "child-shell", name: "Bash", input: { command: "printf child-live; sleep 20", description: "Temporary child shell" } } : { type: "text", text: "child-finished" };
    else block = ++mainCalls === 1 ? { type: "tool_use", id: "root-shell", name: "Bash", input: { command: "printf shell-live; sleep 20", description: "Temporary foreground shell", run_in_background: false } }
      : mainCalls === 2 ? { type: "tool_use", id: "root-monitor", name: "Monitor", input: { command: 'printf "monitor-live\\n"; sleep 20', description: "Temporary monitor", timeout_ms: 30_000 } }
      : mainCalls === 3 ? { type: "tool_use", id: "root-agent", name: "Agent", input: { prompt: "native-child-probe", description: "Temporary subagent", subagent_type: "general-purpose", run_in_background: true } }
      : { type: "text", text: "parent-finished" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message: { id: randomUUID(), type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    event("content_block_start", { index: 0, content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) } : { type: "text_delta", text: block.text } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
    event("message_stop", {}); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  config.writeClaudeJson(config.claudeConfigFile(), { profiles: [{ ...profile, model: "claude-sonnet-4-5", permissionMode: "manual", env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_AUTH_TOKEN: "local-native-task-test", DISABLE_NONESSENTIAL_TRAFFIC: "1", API_TIMEOUT_MS: "15000" } }] });
  // The empty catalog row in this fixture is new: the first real send must create the native UUID.
  db.deleteCatalogSession(id);
  const run = runtime.getClaudeRun(id);
  const errors = [];
  t.after(run.onEvent((event) => {
    if (event.type === "extension_ui_request" && event.method === "confirm") run.respond(event.id, { confirmed: true });
    if (event.type === "prompt_error") errors.push(event.errorMessage);
  }));
  const until = async (predicate) => {
    const start = Date.now();
    while (!predicate()) { if (Date.now() - start > 25_000) throw new Error("Timed out waiting for native task state"); await new Promise((resolve) => setTimeout(resolve, 25)); }
  };
  await runtime.sendClaudePrompt({ id, cwd: root, profileId: profile.id, text: "native-root-probe" });
  await until(() => [...run.tasks.rows.values()].some((task) => task.toolUseId === "root-shell"));
  const shell = [...run.tasks.rows.values()].find((task) => task.toolUseId === "root-shell");
  assert.equal(shell.background, false);
  assert.equal((await post(id, { action: "background", taskId: shell.id, runId: shell.runId })).status, 200);
  await until(() => [...run.tasks.rows.values()].some((task) => task.type === "subagent") && !run.isStreaming);
  const agent = [...run.tasks.rows.values()].find((task) => task.type === "subagent");
  const monitor = [...run.tasks.rows.values()].find((task) => task.type === "monitor");
  assert.ok(monitor);
  assert.equal(run.tasks.rows.get(shell.id).background, true);
  await until(() => [...run.tasks.rows.values()].some((task) => task.parentTaskId === agent.id));
  const live = await (await get(id)).json();
  assert.equal(live.connected, true);
  assert.ok(live.tasks.some((task) => task.type === "monitor"));
  assert.ok(live.tasks.some((task) => task.parentTaskId === agent.id));
  assert.match((await (await get(id, `?task=${shell.id}`)).json()).output, /shell-live/);
  assert.match((await (await get(id, `?task=${monitor.id}`)).json()).output, /monitor-live/);
  const agentDetail = await (await get(id, `?task=${agent.id}`)).json();
  assert.ok(agentDetail.messages.some((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall" && block.toolName === "Bash")));
  await until(() => !run.isStreaming);
  hold = true;
  const requestHeld = new Promise((resolve) => { held = resolve; });
  await runtime.sendClaudePrompt({ id, cwd: root, profileId: profile.id, text: "native-parent-hold" });
  await requestHeld;
  assert.equal(run.abort(), true);
  await until(() => !run.isStreaming);
  hold = false;
  assert.equal(run.tasks.rows.get(agent.id).status, "running", "interrupt spares the background agent when per-task stop is available");
  for (const task of [shell, monitor, agent]) {
    const current = run.tasks.rows.get(task.id);
    if (!["running", "paused", "pending"].includes(current.status)) continue;
    const response = await post(id, { action: "stop", taskId: current.id, runId: current.runId });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  }
  await until(() => run.backgroundTasks.size === 0 && !run.isStreaming);
  assert.equal(run.tasks.rows.get(agent.id).status, "stopped");
  assert.deepEqual(errors, []);
  const child = run.child;
  const closed = new Promise((resolve) => child.once("close", resolve));
  run.close(); await closed;
  const offline = await (await get(id)).json();
  assert.equal(offline.connected, false);
  assert.ok(offline.tasks.some((task) => task.id === agent.id && task.status !== "running"));
  assert.ok((await (await get(id, `?task=${agent.id}`)).json()).messages.length > 0);
});

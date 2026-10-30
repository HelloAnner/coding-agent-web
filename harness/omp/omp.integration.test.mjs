import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, alias: { "@": process.cwd() } });
let available = false;
try { available = execFileSync(process.env.PI_WEB_OMP_BIN || "omp", ["--version"], { encoding: "utf8" }).trim() === "omp/18.3.0"; } catch {}

test("native OMP uses Pi configuration for two turns, full tool permissions, model changes, abort, and exact resume", { skip: !available, timeout: 90000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "web-omp-integration-")));
  const pi = join(root, "pi");
  const cwd = join(root, "project");
  await mkdir(pi); await mkdir(cwd);
  const env = { ...process.env };
  Object.assign(process.env, { HOME: root, PI_CODING_AGENT_DIR: pi, PI_WEB_OMP_AGENT_DIR: join(root, "omp"), CODING_AGENT_WEB_DATA: join(root, "web", "data.db"), OMP_TEST_KEY: "fake-aligned-key", OMP_TEST_HEADER: "fake-aligned-header" });
  const requests = [];
  let mode = "text";
  let held;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ headers: req.headers, body });
    if (mode === "error") { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "rejected fake-aligned-key fake-aligned-header" } })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (mode === "hang") { res.write(": waiting\n\n"); held?.(); return; }
    const tool = ["tool", "ask"].includes(mode) && !body.messages.slice(body.messages.findLastIndex((message) => message.role === "user") + 1).some((message) => message.role === "tool");
    const delta = tool ? { tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: mode === "ask"
      ? { name: "ask", arguments: JSON.stringify({ questions: [{ id: "color", question: "Pick a color", options: [{ label: "Blue", description: "The blue option" }, { label: "Red" }] }] }) }
      : { name: "bash", arguments: JSON.stringify({ command: "printf approved-tool" }) } }] }
      : { content: body.messages.some((message) => JSON.stringify(message).includes("omp-check-42")) ? "remembered omp-check-42" : "aligned-response" };
    for (const chunk of [
      { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
    ]) res.write(`data: ${JSON.stringify({ id: randomUUID(), object: "chat.completion.chunk", model: body.model, ...chunk })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await writeFile(join(pi, "models.json"), JSON.stringify({ providers: { aligned: {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "$OMP_TEST_KEY", headers: { "X-Aligned": "$OMP_TEST_HEADER" },
    models: ["custom", "other"].map((id) => ({ id, name: id, reasoning: true, contextWindow: 262144, maxTokens: 512, samplingParams: { top_p: 0.73 }, compat: { maxTokensField: "max_tokens", supportsStore: false, supportsDeveloperRole: false } })),
  } } }));
  await writeFile(join(pi, "settings.json"), JSON.stringify({ enabledModels: ["aligned/*"], defaultThinkingLevel: "medium" }));
  const runtime = await jiti.import("./runtime.ts");
  const { allowFileRoot } = await jiti.import("../../lib/file-access.ts");
  const { POST: handleOmpCommand } = await jiti.import("./api.ts");
  const { guardOmpCatalogWrite } = await jiti.import("./catalog.ts");
  const { closeCatalogDb, readCatalogSession, updateCatalogSession, upsertCatalogSession } = await jiti.import("../../lib/catalog-db.ts");
  const id = `omp-${randomUUID()}`;
  let run = runtime.getOmpRun(id);
  const input = { id, cwd, provider: "aligned", modelId: "custom" };
  const wait = (action, predicate = (event) => event.type === "agent_settled") => new Promise((resolve, reject) => {
    const seen = [];
    const timer = setTimeout(() => { off(); reject(new Error(`OMP test event timed out: ${seen.join(", ")}`)); }, 20000);
    const off = run.onEvent((event) => {
      seen.push(`${event.type}:${event.method ?? event.toolName ?? event.errorMessage ?? ""}`);
      if (predicate(event)) { clearTimeout(timer); off(); resolve(event); }
      else if (event.type === "agent_settled") {
        clearTimeout(timer); off(); reject(new Error(`OMP settled without the expected event: ${seen.join(", ")}; available tools: ${requests.at(-1)?.body.tools?.map((tool) => tool.function.name)}`));
      }
    });
    Promise.resolve().then(action).catch((error) => { clearTimeout(timer); off(); reject(error); });
  });
  try {
    allowFileRoot(cwd);
    assert.throws(() => guardOmpCatalogWrite(id, { harness: "omp", cwd }), /native OMP endpoint/);
    const creating = run.ensure(input);
    await assert.rejects(run.ensure(input), /already working/);
    await creating;
    const first = readCatalogSession(id);
    assert.ok(first.sessionPath.endsWith(".jsonl"));
    assert.equal(first.harness, "omp");
    assert.equal(run.state().state.thinkingLevel, "medium");
    const oversized = await handleOmpCommand(new Request(`http://localhost/api/omp/${id}`, { method: "POST", body: JSON.stringify({ type: "prompt", cwd, message: "\\".repeat(600000) }) }), { params: Promise.resolve({ id }) });
    assert.equal(oversized.status, 413, "validate physical JSON frame bytes before sending to OMP");
    await assert.rejects(run.prompt({ ...input, message: "image", images: [{ data: "eA==", mimeType: "image/png" }] }), /does not support image/);
    assert.throws(() => guardOmpCatalogWrite(id, { model: "other" }), /confirmed by the native/);
    assert.throws(() => updateCatalogSession(id, { cwd: root }), /native identity/);
    assert.throws(() => updateCatalogSession(id, { sessionPath: "" }), /native identity/);
    assert.throws(() => upsertCatalogSession({ id, cwd, harness: "omp", model: "other" }), /confirmed model/);
    await wait(() => run.prompt({ ...input, message: "omp-check-42" }));
    process.env.OMP_TEST_HEADER = "changed-live-header";
    await wait(() => run.prompt({ ...input, message: "What was the marker?" }));
    assert.equal(requests.at(-1).headers["x-aligned"], "changed-live-header", "request-time header interpolation is not frozen into OMP config");
    assert.ok(requests.at(-1).body.messages.some((message) => JSON.stringify(message).includes("omp-check-42")), "second turn contains original native history");
    assert.equal(requests[0].headers.authorization, "Bearer fake-aligned-key");
    assert.equal(requests[0].headers["x-aligned"], "fake-aligned-header");
    assert.equal(requests[0].body.top_p, 0.73);
    assert.ok(requests.every(({ body }) => body.messages.some((message) => message.role === "system")), "native OMP system instructions reach the configured Pi transport");
    assert.ok(requests.every(({ body }) => body.max_tokens <= 512), "Pi output limits are preserved, including context-window clamping");
    assert.equal(requests.at(-1).body.max_tokens, 512);
    assert.equal(run.view().context.messages.filter((message) => message.role === "user").length, 2);
    await run.refreshState();
    assert.ok(run.state().state.contextUsage.tokens > 0);
    assert.equal(run.state().state.contextUsage.contextWindow, 262144);
    await run.setThinking("low");
    const switching = run.setModel("aligned", "other");
    assert.equal(run.state().running, true);
    assert.equal(run.state().state.isStreaming, false, "model controls never masquerade as a new agent run");
    await switching;
    assert.equal(run.state().state.thinkingLevel, "medium", "model switches use Pi's configured default");
    await run.setThinking("low");
    assert.equal(readCatalogSession(id).model, "other");
    await wait(() => run.prompt({ id, cwd, message: "new model" }));
    assert.equal(requests.at(-1).body.model, "other");
    const old = run.rpc;
    run.close();
    if (old.child.exitCode === null) await new Promise((resolve) => old.child.once("close", resolve));
    run = runtime.getOmpRun(id);
    await wait(() => run.prompt({ id, cwd, message: "Resume and recall the marker" }));
    assert.equal(readCatalogSession(id).sessionPath, first.sessionPath);
    assert.equal(run.state().state.thinkingLevel, "low", "resume preserves the native session's explicit thinking choice");
    assert.ok(requests.at(-1).body.messages.some((message) => JSON.stringify(message).includes("omp-check-42")));
    mode = "tool";
    const toolEvents = [];
    const stopWatching = run.onEvent((event) => toolEvents.push(event));
    await wait(() => run.prompt({ id, cwd, message: "Use bash" }));
    stopWatching();
    assert.ok(run.view().context.messages.some((message) => message.role === "toolResult" && JSON.stringify(message.content).includes("approved-tool")));
    assert.equal(run.inputs.size, 0, "yolo executes tools without waiting for approval");
    assert.ok(!toolEvents.some((event) => event.type === "extension_ui_request" && event.options?.includes("Approve")), "no tool approval dialog is raised");
    mode = "ask";
    const question = await wait(() => run.prompt({ id, cwd, message: "Ask me which color" }), (event) => event.type === "extension_ui_request" && event.method === "select");
    assert.ok(question.options.includes("Blue"));
    assert.ok(question.optionDetails.some((option) => option.description === "The blue option"));
    assert.ok(runtime.ompAwaitingInputIds().includes(id));
    await wait(() => run.respond(question.id, { value: "Blue" }));
    assert.ok(run.view().context.messages.some((message) => message.role === "toolResult" && message.toolName === "ask" && JSON.stringify(message.content).includes("Blue")));
    mode = "error";
    const failures = [];
    const off = run.onEvent((event) => failures.push(event));
    await wait(() => run.prompt({ id, cwd, message: "surface the model error safely" }));
    off();
    assert.ok(failures.some((event) => event.type === "prompt_error"));
    assert.equal(JSON.stringify(failures).includes("fake-aligned-key"), false);
    assert.equal(JSON.stringify(failures).includes("fake-aligned-header"), false);
    mode = "hang";
    const requestHeld = new Promise((resolve) => { held = resolve; });
    await wait(() => run.prompt({ id, cwd, message: "wait for queue check" }), (event) => event.type === "agent_start");
    await requestHeld;
    const queuedEvents = [];
    const stopQueueEvents = run.onEvent((event) => queuedEvents.push(event));
    const followUp = await handleOmpCommand(new Request(`http://localhost/api/omp/${id}`, { method: "POST", body: JSON.stringify({ type: "prompt", cwd, message: "queued-follow-up-marker", streamingBehavior: "followUp", requestId: "native-queued-follow-up" }) }), { params: Promise.resolve({ id }) });
    assert.equal(followUp.status, 200);
    assert.equal((await followUp.json()).data.queued, true);
    assert.deepEqual(run.state().state.queuedMessages, { steering: [], followUp: ["queued-follow-up-marker"] });
    for (const endpoint of ["../../app/api/catalog/sessions/route.ts", "../../app/api/agent/running/route.ts"]) {
      const route = await jiti.import(endpoint);
      assert.ok((await (await route.GET()).json()).runningSessionIds.includes(id));
    }
    mode = "text";
    await wait(() => run.prompt({ id, cwd, message: "queued-steer-marker", streamingBehavior: "steer" }));
    stopQueueEvents();
    assert.equal(queuedEvents.filter((event) => event.type === "agent_settled").length, 1);
    assert.equal(queuedEvents.at(-1).aborted, false);
    const delivered = queuedEvents.filter((event) => event.type === "message_end" && event.message.role === "user").map((event) => JSON.stringify(event.message.content));
    assert.ok(delivered[0].includes("queued-steer-marker"));
    assert.ok(delivered[1].includes("queued-follow-up-marker"));
    assert.deepEqual(run.state().state.queuedMessages, { steering: [], followUp: [] });
    mode = "hang";
    const started = wait(() => run.prompt({ id, cwd, message: "wait" }), (event) => event.type === "agent_start");
    await started;
    const stopped = wait(() => { assert.equal(run.abort(), true); });
    const ending = await stopped;
    assert.equal(ending.aborted, true);
    assert.equal(run.isStreaming, false);
  } finally {
    runtime.stopOmpRuns();
    closeCatalogDb();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    // Let the native CLI drain before deleting its temporary session files.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(root, { recursive: true, force: true });
  }
});

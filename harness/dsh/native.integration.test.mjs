import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";

// Opt-in: use installed ACP packages read-only, with temporary profiles and a local fake model.
const profile = process.env.DSH_TEST_PROFILE || join(homedir(), ".dsh", "profiles", "acp");
test("installed dsh keeps native identity through steer, follow-up, stop and kernel restart", { skip: !process.env.DSH_TEST_BIN, timeout: 60_000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-native-queue-")));
  const previous = { ...process.env };
  const requests = [];
  let mode = "hold", held;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    if (!req.url.includes("chat/completions")) { res.setHeader("Content-Type", "application/json"); res.end("{}"); return; }
    const body = JSON.parse(raw); requests.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (mode === "hold") { res.write(": waiting\n\n"); held?.(); return; }
    for (const [delta, finish] of [[{ role: "assistant", content: "native-dsh-ok" }, null], [{}, "stop"]]) {
      res.write(`data: ${JSON.stringify({ id: "native-check", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let kernel;
  t.after(async () => {
    kernel?.stop(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rm(root, { recursive: true, force: true });
  });
  const temporaryProfile = join(root, "profiles", "acp");
  await mkdir(temporaryProfile, { recursive: true });
  for (const file of ["package.json", "cordis.yml"]) await copyFile(join(profile, file), join(temporaryProfile, file));
  await symlink(join(dirname(profile), "node_modules"), join(root, "profiles", "node_modules"), "dir");
  await writeFile(join(temporaryProfile, "cordis.patch.yml"), JSON.stringify([
    { id: "llm-deepseek", disabled: true }, { id: "llm-deepseek-account", disabled: true }, { id: "deepseek-account", disabled: true }, { id: "session-telemetry-otel", disabled: true },
    { id: "llm-pi-ai", config: { providers: { protocol: { api: "openai-completions", apiKeyEnv: "DSH_PROTOCOL_TEST_KEY", baseURL: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: "check", name: "Native check", contextWindow: 128000, maxTokens: 512, input: ["text"], reasoningEfforts: false }] } } } },
    { id: "acp", config: { provider: "protocol", model: "check" } },
  ]));
  Object.assign(process.env, { HOME: root, DSH_HOME: root, DSH_DS_TOML: join(root, "absent.toml"), DSH_PROTOCOL_TEST_KEY: "local-fake-key", PI_WEB_DSH_BIN: process.env.DSH_TEST_BIN });
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
  const runtime = await jiti.import("./runtime.ts");
  kernel = (await jiti.import("./acp.ts")).dshKernel();
  const id = "dsh-native-queue";
  const run = runtime.getDshSession(id);
  const events = [];
  run.onEvent((event) => events.push(event));
  const wait = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("Native dsh settlement timed out")); }, 20000);
    const off = run.onEvent((event) => { if (event.type === "agent_settled") { clearTimeout(timer); off(); resolve(event); } });
  });
  const prompt = (text, sessionPath) => ({ sessionId: id, cwd: root, text, provider: "protocol", model: "check", sessionPath });
  const firstHeld = new Promise((resolve) => { held = resolve; });
  const first = await runtime.sendDshPrompt(prompt("native-marker-42"));
  await firstHeld;
  assert.equal(runtime.isDshRunning(id), true);
  await runtime.sendDshPrompt(prompt("native-later"), "followUp");
  const ended = wait(); mode = "text";
  await runtime.sendDshPrompt(prompt("native-now"), "steer");
  assert.equal((await ended).aborted, false);
  const delivered = events.filter((event) => event.type === "message_end" && event.message.role === "user").map((event) => event.message.content);
  assert.deepEqual(delivered, ["native-now", "native-later"]);
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
  assert.match(JSON.stringify(requests.at(-1)), /native-marker-42/);
  assert.ok(first.sessionPath, "native session path must support restart recovery");
  kernel.stop();
  const resumed = wait();
  await runtime.sendDshPrompt(prompt("after kernel restart", first.sessionPath)); await resumed;
  assert.match(JSON.stringify(requests.at(-1)), /native-later/);
  mode = "hold";
  const stopHeld = new Promise((resolve) => { held = resolve; });
  await runtime.sendDshPrompt(prompt("wait for stop", first.sessionPath)); await stopHeld;
  await runtime.sendDshPrompt(prompt("must not run"), "followUp");
  const stopped = wait(); runtime.abortDshPrompt(id);
  assert.equal((await stopped).aborted, true);
  assert.deepEqual(run.queuedMessages(), { steering: [], followUp: [] });
  assert.equal(runtime.isDshRunning(id), false);
});

import assert from "node:assert/strict";
import test, { after, beforeEach, mock } from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "grok-runtime-"));
const previous = { GROK_HOME: process.env.GROK_HOME, CODING_AGENT_WEB_DATA: process.env.CODING_AGENT_WEB_DATA };
process.env.GROK_HOME = root;
process.env.CODING_AGENT_WEB_DATA = join(root, "data.db");
const children = [];
mock.method(childProcess, "spawn", (bin, args, options) => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), signals: [], bin, args, options,
    kill(signal) { this.signals.push(signal); return true; },
  });
  children.push(child);
  return child;
});
syncBuiltinESMExports();
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const runtime = await jiti.import("./runtime.ts");
const { grokHistoryFile } = await jiti.import("./index.ts");
const route = await jiti.import("../../app/api/grok/[id]/route.ts");
const catalogRoute = await jiti.import("../../app/api/catalog/sessions/route.ts");
const runningRoute = await jiti.import("../../app/api/agent/running/route.ts");
const db = await jiti.import("../../lib/catalog-db.ts");
after(() => {
  db.closeCatalogDb();
  mock.restoreAll();
  syncBuiltinESMExports();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(join(tmpdir(), "pi-web-grok-images", id), { recursive: true, force: true });
});
beforeEach(() => { globalThis[Symbol.for("pi-web.grokRuns")]?.clear(); children.length = 0; });
const id = "11111111-1111-4111-8111-111111111111";
const prompt = (text, model = "grok-first") => ({ sessionId: id, cwd: root, text, model });
const context = { params: Promise.resolve({ id }) };
const post = (body) => route.POST(new Request("http://localhost/api/grok/" + id, { method: "POST", body: JSON.stringify(body) }), context);
const state = async () => (await route.GET(new Request(`http://localhost/api/grok/${id}?state=1`), context)).json();
const close = (child, code = 0) => { child.stdout.end(); child.stderr.end(); child.emit("close", code); };

async function assertListed(expected) {
  assert.equal(runtime.grokRunningIds().includes(id), expected);
  for (const endpoint of [catalogRoute, runningRoute]) {
    // Multiple authority polls must agree, including while a stop awaits close.
    for (let poll = 0; poll < 3; poll++) {
      const body = await (await endpoint.GET()).json();
      assert.equal(body.runningSessionIds.includes(id), expected);
      assert.equal(body.runningSessionIds.includes("grok-idle"), false);
    }
  }
  const snapshot = await state();
  assert.equal(snapshot.running, expected);
  assert.equal(snapshot.state.isStreaming, expected);
}

test("Grok reports running in both sidebar endpoints and drains steer before follow-up only after CLI close", async () => {
  runtime.getGrokEventSource("grok-idle", "");
  const run = runtime.getGrokEventSource(id, "");
  const events = [];
  const unsubscribe = run.onEvent((event) => events.push(event));
  await runtime.sendGrokPrompt(prompt("first"));
  const first = children.at(-1);
  await assertListed(true);
  await assert.rejects(runtime.sendGrokPrompt(prompt("duplicate")), /already answering/);
  assert.deepEqual(first.args.slice(-2), ["-s", id]);

  // The native CLI, not the adapter, owns the history used to resume each turn.
  const history = grokHistoryFile(root, id);
  mkdirSync(dirname(history), { recursive: true });
  writeFileSync(history, '{"type":"user","content":"first"}\n');
  assert.deepEqual(await runtime.sendGrokPrompt(prompt("later", "grok-later"), "followUp"), { queued: true });
  assert.equal(children.at(-1), first);
  assert.deepEqual(first.signals, []);
  assert.deepEqual((await state()).state.queuedMessages, { steering: [], followUp: ["later"] });
  const queuedResponse = await post({ type: "prompt", message: "now", cwd: root, model: "grok-now", streamingBehavior: "steer" });
  assert.equal(queuedResponse.status, 200);
  assert.equal((await queuedResponse.json()).data.queued, true);
  assert.deepEqual(first.signals, ["SIGINT"]);
  assert.equal(children.at(-1), first, "steer must wait for the old CLI to close");
  await assertListed(true);
  const replay = [];
  run.onEvent((event) => replay.push(event))();
  assert.deepEqual(replay.at(-1), { type: "queue_update", steering: ["now"], followUp: ["later"] });

  first.stdout.write(JSON.stringify({ type: "text", data: "partial" }) + "\n");
  close(first, 130);
  const steered = children.at(-1);
  assert.notEqual(steered, first);
  assert.equal(steered.args[1], "now");
  assert.deepEqual(steered.args.slice(-2), ["-r", id]);
  assert.equal(steered.options.cwd, root);
  assert.equal(steered.args[steered.args.indexOf("--model") + 1], "grok-now");
  assert.equal(events.some((event) => event.type === "prompt_error"), false);
  assert.equal(events.some((event) => event.type === "agent_settled"), false);
  assert.ok(events.some((event) => event.type === "message_end" && event.message.stopReason === "aborted"));
  assert.deepEqual(events.filter((event) => event.type === "message_end" && event.message.role === "user").map((event) => event.message.content), ["now"]);
  await assertListed(true);
  close(steered);
  const followUp = children.at(-1);
  assert.equal(followUp.args[1], "later");
  assert.equal(followUp.args[followUp.args.indexOf("--model") + 1], "grok-later");
  assert.equal(events.some((event) => event.type === "agent_end"), false);
  close(followUp);
  await assertListed(false);
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
  assert.equal(events.at(-1).aborted, false);
  unsubscribe();
});

test("recall preserves attachments, Stop drops the queue, and a behavior arriving at idle starts visibly", async () => {
  const run = runtime.getGrokEventSource(id, "");
  const events = [];
  const unsubscribe = run.onEvent((event) => events.push(event));
  await runtime.sendGrokPrompt(prompt("again"));
  const current = children.at(-1);
  const images = [{ data: "aW1hZ2U=", mimeType: "image/png" }];
  await runtime.sendGrokPrompt({ ...prompt("recall me"), images }, "followUp");
  const recalled = await (await post({ type: "clear_queue" })).json();
  assert.deepEqual(recalled.data, { steering: [], followUp: ["recall me"], images });
  assert.deepEqual((await state()).state.queuedMessages, { steering: [], followUp: [] });
  await runtime.sendGrokPrompt(prompt("must not run"), "followUp");
  const beforeStop = children.length;
  assert.equal((await (await post({ type: "abort" })).json()).data.aborted, true);
  await assertListed(true);
  await assert.rejects(runtime.sendGrokPrompt(prompt("too soon"), "steer"), /stopping/);
  close(current, 130);
  assert.equal(children.length, beforeStop);
  await assertListed(false);
  assert.equal(events.at(-1).aborted, true);

  await runtime.sendGrokPrompt({ ...prompt("idle follow-up"), images }, "followUp");
  const delivered = events.filter((event) => event.type === "message_end" && event.message.role === "user").at(-1).message;
  assert.deepEqual(delivered.content, [{ type: "text", text: "idle follow-up" }, { type: "image", source: { type: "base64", data: images[0].data, media_type: "image/png" } }]);
  assert.match(children.at(-1).args[1], /\[attached images\]/);
  close(children.at(-1));
  assert.equal(events.at(-1).aborted, false);
  unsubscribe();
});

test("a failed CLI settles once and its late close cannot settle a queued successor", async () => {
  const run = runtime.getGrokEventSource(id, "");
  const events = [];
  const unsubscribe = run.onEvent((event) => events.push(event));
  await runtime.sendGrokPrompt(prompt("failure"));
  const failed = children.at(-1);
  await runtime.sendGrokPrompt(prompt("recover"), "followUp");
  failed.emit("error", new Error("ENOENT"));
  const recovery = children.at(-1);
  assert.notEqual(recovery, failed);
  close(failed, -2);
  assert.equal(run.child, recovery);
  await assertListed(true);
  close(recovery);
  await assertListed(false);
  assert.equal(events.filter((event) => event.type === "prompt_error").length, 1);
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
  unsubscribe();
});

test("invalid streaming behavior is rejected without starting a CLI", async () => {
  const before = children.length;
  const response = await post({ type: "prompt", message: "bad behavior", cwd: root, streamingBehavior: "invalid" });
  assert.equal(response.status, 400);
  assert.equal((await post(null)).status, 400);
  assert.equal(children.length, before);
});

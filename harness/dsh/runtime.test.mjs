import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const previousData = process.env.CODING_AGENT_WEB_DATA;
process.env.CODING_AGENT_WEB_DATA = join(mkdtempSync(join(tmpdir(), "dsh-runtime-")), "data.db");
const calls = [];
const updates = new Set();
const exits = new Set();
let ready = async () => {};
let complete;
let fail;
let openError = null;
const client = {
  ready: () => ready(),
  onExit: (listener) => exits.add(listener),
  onUpdate: (listener) => { updates.add(listener); return () => updates.delete(listener); },
  notify: (method, params) => calls.push({ method, params }),
  request: async (method, params) => {
    calls.push({ method, params });
    if (method === "session/resume") {
      if (openError) throw openError;
      return { configOptions: [] }; // ACP resume intentionally has no sessionId.
    }
    if (method === "session/prompt") return new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    throw new Error(`Unexpected request: ${method}`);
  },
};
globalThis[Symbol.for("pi-web.dshAcp")] = client;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const runtime = await jiti.import("./runtime.ts");
const catalogRoute = await jiti.import("../../app/api/catalog/sessions/route.ts");
const runningRoute = await jiti.import("../../app/api/agent/running/route.ts");
const db = await jiti.import("../../lib/catalog-db.ts");
after(() => {
  db.closeCatalogDb();
  delete globalThis[Symbol.for("pi-web.dshAcp")];
  if (previousData === undefined) delete process.env.CODING_AGENT_WEB_DATA;
  else process.env.CODING_AGENT_WEB_DATA = previousData;
});
const prompt = (id) => ({ sessionId: id, cwd: process.cwd(), text: "continue", sessionPath: "/sessions/native-id" });
const drain = () => new Promise((resolve) => setImmediate(resolve));

async function assertListed(id, expected) {
  assert.equal(runtime.dshRunningIds().includes(id), expected);
  for (const route of [catalogRoute, runningRoute]) {
    const body = await (await route.GET()).json();
    assert.equal(body.runningSessionIds.includes(id), expected);
    assert.equal(body.runningSessionIds.includes("native-id"), false);
    assert.equal(body.runningSessionIds.includes("dsh-idle"), false);
  }
}

test("resumed ACP identity survives cancel, settlement, subsequent turns and kernel restart", async () => {
  const id = "dsh-resumed";
  runtime.getDshSession("dsh-idle");
  const run = runtime.getDshSession(id);
  const events = [];
  run.onEvent((event) => events.push(event));
  await runtime.sendDshPrompt(prompt(id));
  assert.equal(run.acpSessionId, "native-id");
  assert.deepEqual(calls.at(-1).params.sessionId, "native-id");
  await assertListed(id, true);
  assert.equal(runtime.abortDshPrompt(id), true);
  assert.deepEqual(calls.at(-1), { method: "session/cancel", params: { sessionId: "native-id" } });
  await assert.rejects(runtime.sendDshPrompt(prompt(id)), /already answering/);
  await assertListed(id, true); // Cancel is a notification, not settlement.
  complete({ stopReason: "cancelled" });
  await drain();
  await assertListed(id, false);
  assert.equal(events.at(-1).aborted, true);
  await runtime.sendDshPrompt(prompt(id));
  assert.equal(calls.at(-1).params.sessionId, "native-id");
  complete({ stopReason: "end_turn" });
  await drain();
  assert.equal(events.at(-1).aborted, false);
  for (const listener of exits) listener("test kernel restart");
  assert.equal(run.acpSessionId, null);
  await runtime.sendDshPrompt(prompt(id));
  assert.equal(calls.at(-2).method, "session/resume");
  assert.equal(calls.at(-1).params.sessionId, "native-id");
  fail(new Error("provider failed"));
  await drain();
  await assertListed(id, false);
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 3);
  assert.equal(updates.size, 0);
});

test("initialization is busy, rejects duplicate sends, and can be cancelled before prompt admission", async () => {
  const id = "dsh-starting";
  let release;
  ready = () => new Promise((resolve) => { release = resolve; });
  const sending = runtime.sendDshPrompt(prompt(id));
  await assertListed(id, true);
  await assert.rejects(runtime.sendDshPrompt(prompt(id)), /already answering/);
  assert.equal(runtime.abortDshPrompt(id), true);
  const promptsBefore = calls.filter((call) => call.method === "session/prompt").length;
  release();
  await assert.rejects(sending, /cancelled before it started/);
  assert.equal(calls.filter((call) => call.method === "session/prompt").length, promptsBefore);
  await assertListed(id, false);
  ready = async () => {};
});

test("failed resume clears busy state without silently opening a new conversation", async () => {
  openError = new Error("Invalid params: session is not resumable");
  try {
    await assert.rejects(runtime.sendDshPrompt(prompt("dsh-failed")), /could not resume.*not resumable/);
    await assertListed("dsh-failed", false);
    assert.equal(runtime.getDshSession("dsh-failed").acpSessionId, null);
    assert.equal(calls.some((call) => call.method === "session/new"), false);
  } finally { openError = null; }
});

test("a prompt sent while a turn runs is queued, steered, cleared or dropped", async () => {
  const id = "dsh-queue";
  const run = runtime.getDshSession(id);
  const events = [];
  run.onEvent((event) => events.push(event));
  const prompts = () => calls.filter((call) => call.method === "session/prompt").length;

  await runtime.sendDshPrompt(prompt(id));
  const before = prompts();

  // A follow-up waits for the running turn: nothing reaches the kernel yet.
  assert.deepEqual(
    await runtime.sendDshPrompt({ ...prompt(id), text: "later" }, "followUp"),
    { sessionPath: "/sessions/native-id", queued: true },
  );
  assert.deepEqual(run.queuedMessages(), { steering: [], followUp: ["later"] });
  assert.equal(prompts(), before);
  assert.ok(events.some((event) => event.type === "queue_update" && event.followUp[0] === "later"));

  // Steering preempts it: cancel, then the queued text starts the next turn.
  await runtime.sendDshPrompt({ ...prompt(id), text: "now" }, "steer");
  assert.deepEqual(calls.at(-1), { method: "session/cancel", params: { sessionId: "native-id" } });
  complete({ stopReason: "cancelled" });
  await drain();
  assert.equal(prompts(), before + 1);
  assert.deepEqual(run.queuedMessages(), { steering: [], followUp: ["later"] });
  // Same run: the browser must not see a completed turn between queued prompts.
  assert.equal(events.filter((event) => event.type === "agent_end").length, 0);
  assert.equal(events.filter((event) => event.type === "agent_start").length, 2);
  const delivered = events.find((event) => event.type === "message_end");
  assert.equal(delivered.message.role, "user");
  assert.equal(delivered.message.content, "now");

  // Recall hands the texts back and empties the rows.
  assert.deepEqual(runtime.clearDshQueue(id), { steering: [], followUp: ["later"] });
  assert.deepEqual(run.queuedMessages(), { steering: [], followUp: [] });

  // Stop means stop: a queued follow-up must not start after the turn is cut.
  await runtime.sendDshPrompt({ ...prompt(id), text: "dropped" }, "followUp");
  assert.equal(runtime.abortDshPrompt(id), true);
  assert.deepEqual(run.queuedMessages(), { steering: [], followUp: [] });
  complete({ stopReason: "cancelled" });
  await drain();
  assert.equal(prompts(), before + 1);
  assert.deepEqual(
    { type: events.at(-1).type, aborted: events.at(-1).aborted },
    { type: "agent_settled", aborted: true },
  );
  assert.equal(runtime.isDshRunning(id), false);
});

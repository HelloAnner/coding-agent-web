import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const root = mkdtempSync(path.join(tmpdir(), "dsh-web-state-"));
process.env.CODING_AGENT_WEB_DATA = path.join(root, "catalog.db");
const models = { default: { provider: "gateway", model: "test" }, groups: [{ id: "gateway", models: [{ id: "test", name: "Native test" }] }] };
const sessions = new Map(), calls = [];
let eventController, selection, selectionEntered;
function push(id, type, data = {}) {
  const state = sessions.get(id);
  const event = { seq: ++state.seq, type, data };
  for (const controller of state.controllers) controller.enqueue({ type: "event", event });
}
const host = {
  generation: 1, home: root, profileDir: path.join(root, "profiles/coding-agent-web"), ready: async () => {},
  async call(method, args = {}) {
    calls.push({ method, args });
    const request = args.request ?? {};
    const state = sessions.get(request.sessionId);
    if (method === "session/modelCatalog") return models;
    if (method === "session/list") return { items: [...sessions].map(([sessionId, state]) => ({ sessionId, running: state.running, agentAvailable: false })) };
    if (method === "session/create") {
      sessions.set(request.sessionId, { cwd: request.cwd, seq: 0, running: false, controllers: new Set(), inbox: {} });
      mkdirSync(path.join(root, "sessions/project", request.sessionId), { recursive: true });
      return { sessionId: request.sessionId };
    }
    if (method === "session/selectModel") { selectionEntered?.(); if (selection) await selection; return; }
    if (method === "session/projections") return { values: { inbox: state.inbox } };
    if (method === "session/prompt") {
      if (!state.running) { state.running = true; push(request.sessionId, "turn/start"); }
      else {
        const queue = request.mode === "steer" ? "next-step" : "next-turn";
        (state.inbox[queue] ??= []).push({ id: request.requestId, content: request.content });
      }
      return;
    }
    if (method === "session/updateQueue") { for (const queue of Object.keys(state.inbox)) state.inbox[queue] = state.inbox[queue].filter((item) => item.id !== request.itemId); return; }
    if (method === "session/cancel") return;
    if (method === "$events/result") return;
    throw new Error(`Unexpected method ${method}`);
  },
  async stream(method, args = {}) {
    let controller;
    const state = sessions.get(args.request?.address?.sessionId);
    const readable = new ReadableStream({ start(value) { controller = value; }, cancel() { state?.controllers.delete(controller); } });
    if (method === "$events") { eventController = controller; controller.enqueue({ type: "ready", clientId: "web-client" }); }
    else {
      assert.equal(method, "session/follow");
      state.controllers.add(controller);
      controller.enqueue({ type: "snapshot", header: { id: args.request.address.sessionId, cwd: state.cwd }, records: [], cursor: state.seq, hasMore: false, projections: { values: { inbox: state.inbox } } });
    }
    return { readable, close() { state?.controllers.delete(controller); try { controller.error(new Error("closed")); } catch {} }, send() {}, end() {} };
  },
};
globalThis[Symbol.for("coding-agent-web.dshWebHost")] = host;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const runtime = await jiti.import("./web-session.ts");
const { closeCatalogDb } = await jiti.import("../../lib/catalog-db.ts");
const wait = async (predicate) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } assert.fail("Native state transition timed out"); };
after(() => { closeCatalogDb(); rmSync(root, { recursive: true, force: true }); });

test("native queue, explicit approvals, lease handoff and Stop preserve authoritative running state", async () => {
  const id = "web-state", run = runtime.getDshSession(id), events = [];
  run.onEvent((event) => events.push(event));
  const prompt = (text) => ({ sessionId: id, cwd: root, text });
  await runtime.sendDshPrompt(prompt("start"));
  await assert.rejects(() => runtime.sendDshPrompt(prompt("duplicate")), /already answering/);
  await runtime.sendDshPrompt(prompt("now"), "steer");
  await runtime.sendDshPrompt(prompt("later"), "followUp");
  assert.deepEqual(run.queuedMessages(), { steering: ["now"], followUp: ["later"] });
  eventController.enqueue({ type: "waterfall", agentId: id, eventId: "approval-1", event: "approval/request", request: { toolName: "shell", reason: "write a file" } });
  await wait(() => runtime.dshInteractions(id).length === 1);
  assert.equal(calls.filter((call) => call.method === "$events/result").length, 0, "no unconditional allow");
  await assert.rejects(() => runtime.answerDshInteraction(id, "approval-1", "allowed"), /Invalid approval/);
  await runtime.answerDshInteraction(id, "approval-1", "allowed-once");
  assert.equal(calls.at(-1).args.outcome.value, "allowed-once");
  eventController.enqueue({ type: "waterfall", agentId: id, eventId: "approval-2", event: "approval/request", request: {} });
  await wait(() => runtime.dshInteractions(id).length === 1);
  await runtime.leaseDshNativeView(id, "native-view-lease-123", true);
  assert.equal(calls.at(-1).args.outcome.kind, "next", "visible native Client owns its own waterfall");
  assert.deepEqual(runtime.dshInteractions(id), []);
  await runtime.leaseDshNativeView(id, "native-view-lease-123", false);
  const stopped = await runtime.abortDshPrompt(id);
  assert.equal(stopped, true);
  assert.equal(runtime.isDshRunning(id), true, "cancel acknowledgement is not idle confirmation");
  assert.deepEqual(run.queuedMessages(), { steering: [], followUp: [] });
  assert.equal(calls.at(-1).method, "session/cancel");
  sessions.get(id).running = false;
  push(id, "turn/end", { reason: "cancelled" });
  await wait(() => !runtime.isDshRunning(id));
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
  assert.equal(events.find((event) => event.type === "agent_settled").aborted, true);
  assert.deepEqual((await runtime.listDshWebModels()).models.map((model) => model.name), ["Native test"]);
});

test("Stop while selecting a model prevents prompt submission, and ids cannot escape their harness", async () => {
  let release, entered;
  selection = new Promise((resolve) => { release = resolve; });
  const selecting = new Promise((resolve) => { entered = resolve; });
  selectionEntered = entered;
  const sending = runtime.sendDshPrompt({ sessionId: "cancel-start", cwd: root, text: "must not run", provider: "gateway", model: "test" });
  const rejected = assert.rejects(sending, /cancelled before admission/);
  await selecting;
  const stopping = runtime.abortDshPrompt("cancel-start");
  release();
  await rejected; await stopping;
  assert.equal(calls.some((call) => call.method === "session/prompt" && call.args.request.sessionId === "cancel-start"), false);
  assert.equal(runtime.isDshRunning("cancel-start"), false);
  assert.throws(() => runtime.getDshSession("../../outside"), /Invalid dsh/);
  await assert.rejects(() => runtime.answerDshInteraction("cancel-start", "approval-1", "allowed-once"), /expired or belongs/);
  selection = null; selectionEntered = null;
});

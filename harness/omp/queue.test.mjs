import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { OmpRun } = await createJiti(import.meta.url).import("./runtime.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function setup(t) {
  const run = new OmpRun("omp-queue-check");
  const calls = [], events = [];
  run.open = async () => {};
  run.identity = () => ({ sessionId: run.id, sessionPath: "/native.jsonl", provider: "test", model: "test", cwd: "/project" });
  run.rpc = { alive: true, request: async (frame) => { calls.push(frame); return {}; }, close() {}, write() {} };
  run.onEvent((event) => events.push(event));
  t.after(() => run.close());
  const send = (message, streamingBehavior, extra = {}) => run.prompt({ id: run.id, cwd: "/project", message, streamingBehavior, ...extra });
  return { run, calls, events, send };
}

test("OMP prioritizes steer, deduplicates queued request IDs and stays busy through terminal boundaries", async (t) => {
  const { run, calls, events, send } = setup(t);
  await send("first");
  await send("later", "followUp", { requestId: "later-id" });
  await send("later", "followUp", { requestId: "later-id" });
  await send("now", "steer");
  assert.deepEqual(run.queuedMessages(), { steering: ["now"], followUp: ["later"] });
  assert.deepEqual(calls.map((frame) => frame.type), ["prompt", "abort"]);
  assert.equal(run.state().running, true);
  run.receive({ type: "agent_start" }); // A late start cannot cancel a pending interrupt.
  run.receive({ type: "agent_end", isTerminal: false });
  assert.equal(calls.length, 2);
  run.receive({ type: "agent_end", isTerminal: true }); await tick();
  assert.equal(calls.at(-1).message, "now");
  assert.equal(run.isBusy, true);
  assert.equal(events.some((event) => event.type === "agent_settled"), false);
  run.receive({ type: "agent_end", isTerminal: true }); await tick();
  assert.equal(calls.at(-1).message, "later");
  run.receive({ type: "agent_end", isTerminal: true });
  assert.equal(run.state().running, false);
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
  assert.equal(events.at(-1).aborted, false);
});

test("OMP Stop during preparation of a queued successor cannot resurrect the cancelled message", async (t) => {
  const { run, send } = setup(t);
  await send("first"); await send("cancel next", "followUp");
  const ready = Promise.withResolvers();
  run.open = () => ready.promise;
  run.receive({ type: "agent_end", isTerminal: true });
  run.abort(); ready.resolve(); await tick();
  assert.equal(run.isBusy, false);
  assert.deepEqual(run.queuedMessages(), { steering: [], followUp: [] });
});

test("OMP Recall preserves attachments, Stop discards pending work, and a disconnected queue remains recallable", async (t) => {
  const { run, calls, events, send } = setup(t);
  await send("first");
  const images = [{ data: "eA==", mimeType: "image/png" }];
  await send("recall", "followUp", { images });
  assert.deepEqual(run.clearQueue(), { steering: [], followUp: ["recall"], images });
  await send("stop", "followUp");
  run.abort();
  await assert.rejects(send("too soon", "steer"), /stopping/);
  run.receive({ type: "agent_end", isTerminal: true });
  assert.equal(calls.filter((frame) => frame.type === "prompt").length, 1);
  assert.equal(events.at(-1).aborted, true);
  await send("late", "followUp");
  await send("keep after disconnect", "followUp", { images });
  run.rpc = null; run.settle("disconnected");
  assert.equal(run.state().running, false);
  assert.deepEqual(run.clearQueue(), { steering: [], followUp: ["keep after disconnect"], images });
});

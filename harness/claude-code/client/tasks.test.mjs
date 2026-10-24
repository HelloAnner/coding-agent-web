import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const shim = fileURLToPath(new URL("../../../hooks/__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shim } });
const { renderHook } = await import(shim);
const { useClaudeTasks } = await jiti.import("./use-tasks.ts");
const settle = async (hook) => { for (let i = 0; i < 6; i++) { await new Promise((resolve) => setImmediate(resolve)); hook.flush(); } };
const task = (id, runId = "001") => ({ id, runId, type: "shell", status: "running", description: id, background: false, ambient: false, toolUseId: `tool-${id}` });
const snapshot = (tasks, connected = true) => ({ connected, foreground: false, tasks });

function setup(t, fetch) {
  const previous = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window };
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  globalThis.window = new EventTarget();
  globalThis.fetch = fetch;
  const hook = renderHook((props) => useClaudeTasks(props.id, props.active), { id: "session-one", active: false });
  t.after(() => { hook.unmount(); Object.assign(globalThis, previous); });
  return hook;
}

test("task polling discards a response from the previous session", async (t) => {
  const delayed = Promise.withResolvers();
  const requests = [];
  const hook = setup(t, async (url, options) => {
    requests.push({ url, signal: options.signal });
    return url.includes("session-one") ? delayed.promise : Response.json(snapshot([task("b-two")]));
  });
  hook.rerender({ id: "session-two", active: false });
  await settle(hook);
  delayed.resolve(Response.json(snapshot([task("b-one")])));
  await settle(hook);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(hook.result.snapshot.tasks[0].id, "b-two");
});

test("hiding and returning during an in-flight read resumes polling without committing the aborted read", async (t) => {
  const delayed = Promise.withResolvers();
  let calls = 0;
  const hook = setup(t, async () => ++calls === 1 ? delayed.promise : Response.json(snapshot([task("fresh")])));
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  delayed.resolve(Response.json(snapshot([task("aborted")])));
  await settle(hook);
  assert.equal(calls, 2);
  assert.equal(hook.result.snapshot.tasks[0].id, "fresh");
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  await settle(hook);
  assert.equal(calls, 2);
});

test("task actions carry the displayed run id, report native errors, and do not invent a stopped state", async (t) => {
  const requests = [];
  let reject = false;
  const hook = setup(t, async (url, options) => {
    if (options.method === "POST") {
      requests.push(JSON.parse(options.body));
      return reject ? Response.json({ error: "Native task already changed" }, { status: 409 }) : Response.json({ success: true });
    }
    return Response.json(snapshot([task("b-one", "002")]));
  });
  await settle(hook);
  await hook.result.act(hook.result.snapshot.tasks[0], "stop");
  await settle(hook);
  assert.deepEqual(requests[0], { action: "stop", taskId: "b-one", runId: "002" });
  assert.equal(hook.result.snapshot.tasks[0].status, "running");
  assert.equal(hook.result.pending, null);
  reject = true;
  await hook.result.act(hook.result.snapshot.tasks[0], "background");
  await settle(hook);
  assert.equal(hook.result.actionError, "Native task already changed");
});

test("resuming a task replaces its detail and rejects a delayed previous-run output", async (t) => {
  const oldOutput = Promise.withResolvers();
  let run = "001";
  const urls = [];
  const hook = setup(t, async (url) => {
    urls.push(url);
    if (url.includes("?task=")) return url.includes("run=001") ? oldOutput.promise : Response.json({ task: task("b-one", run), output: "new-run-output" });
    return Response.json(snapshot([task("b-one", run)]));
  });
  await settle(hook);
  hook.result.select("b-one"); hook.flush();
  run = "002";
  hook.result.refresh(); await settle(hook);
  oldOutput.resolve(Response.json({ task: task("b-one", "001"), output: "old-run-output" }));
  await settle(hook);
  assert.ok(urls.some((url) => url.includes("run=002")));
  assert.equal(hook.result.detail.output, "new-run-output");
});

test("a stop request survives navigation without leaking its result into the next session", async (t) => {
  const action = Promise.withResolvers();
  const hook = setup(t, async (url, options) => options.method === "POST" ? action.promise : Response.json(snapshot([task(url.includes("session-one") ? "one" : "two")])));
  await settle(hook);
  const stopping = hook.result.act(hook.result.snapshot.tasks[0], "stop");
  hook.rerender({ id: "session-two", active: false });
  await settle(hook);
  action.resolve(Response.json({ error: "old-session-error" }, { status: 409 }));
  await stopping; await settle(hook);
  assert.equal(hook.result.snapshot.tasks[0].id, "two");
  assert.equal(hook.result.actionError, null);
});

test("permanent native output errors do not poll forever, and Refresh retries the selected task", async (t) => {
  const previousTimer = globalThis.setTimeout;
  let scheduled = 0, details = 0;
  globalThis.setTimeout = (callback, delay, ...args) => { if (delay === 2000) scheduled++; return previousTimer(callback, delay, ...args); };
  t.after(() => { globalThis.setTimeout = previousTimer; });
  const hook = setup(t, async (url) => {
    if (url.includes("?task=")) { details++; return Response.json({ error: "Native output unavailable" }, { status: 400 }); }
    return Response.json(snapshot([task("b-one")], false));
  });
  await settle(hook);
  hook.result.select("b-one"); hook.flush(); await settle(hook);
  assert.equal(hook.result.detailError, "Native output unavailable");
  assert.equal(scheduled, 0);
  hook.result.refresh(); await settle(hook);
  assert.equal(details, 2);
});

test("task rows preserve parent/child work and terminate safely on malformed cycles", async () => {
  const real = createJiti(import.meta.url, { tsconfigPaths: true, jsx: { runtime: "automatic" } });
  const { claudeTaskRows } = await real.import("./Tasks.tsx");
  const rows = claudeTaskRows([task("a-parent"), { ...task("b-child"), parentTaskId: "a-parent" }, { ...task("orphan"), parentTaskId: "missing" }, { ...task("loop-one"), parentTaskId: "loop-two" }, { ...task("loop-two"), parentTaskId: "loop-one" }]);
  assert.equal(rows.length, 5);
  assert.equal(rows.find((row) => row.task.id === "b-child").depth, 1);
  assert.equal(rows.find((row) => row.task.id === "orphan").depth, 0);
  assert.equal(new Set(rows.map((row) => row.task.id)).size, 5);
});

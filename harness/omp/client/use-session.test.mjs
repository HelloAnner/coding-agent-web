import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("use-session.ts", await readFile(new URL("./use-session.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const hook = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "useOmpSession");
const script = new Script(ts.transpileModule(`(${hook.getText(source).replace(/^export\s+/, "")})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
class OmpClientError extends Error { constructor(message, status) { super(message); this.status = status; } }
const identity = { sessionPath: "/omp/native.jsonl", provider: "pi-provider", model: "pi-model", cwd: "/project" };
function setup(send, fetchImpl) {
  const calls = [], writes = [];
  const state = { id: null, known: false, cwd: "/project", model: { provider: "pi-provider", modelId: "pi-model" }, thinkingLevel: "high", busy: false, mounted: true };
  const native = script.runInNewContext({
    useRef: (current) => ({ current }), useMemo: (fn) => fn(), OmpClientError, newOmpId: () => "omp-ui-id",
    ompSessionUrl: (id) => `/api/omp/${id}`,
    fetch: fetchImpl ?? (async (url) => { writes.push(["fetch", url]); return Response.json({ sessionId: state.id, running: false, context: { messages: [] } }); }),
    sendOmpCommand: async (id, body) => { calls.push({ id, body }); return send ? send(id, body) : identity; },
  })();
  native.bind({
    current: () => ({ ...state }),
    begin(id) { writes.push(["begin", id]); state.id = id; state.busy = true; return () => writes.push(["rollback"]); },
    end(clear) { writes.push(["end", clear]); state.busy = false; if (clear) state.id = null; },
    connect: async (id) => writes.push(["connect", id]),
    created(value, text) { writes.push(["created", value, text]); state.known = true; },
    restore: (text) => writes.push(["restore", text]), notice: (text) => writes.push(["notice", text]),
    loading() {}, view: (value, preserve) => writes.push(["view", value, preserve]), snapshot: (value) => writes.push(["snapshot", value]),
    model: (value) => writes.push(["model", value]), thinking: (value) => writes.push(["thinking", value]),
    switching: (value) => writes.push(["switching", value]), reconcile: (id) => writes.push(["reconcile", id]),
  });
  return { native, state, calls, writes };
}

test("OMP sends the Pi selection and image bytes straight through, with no trust round trip", async () => {
  const state = setup();
  await state.native.submit("hello", [{ data: "eA==", mimeType: "image/png", previewUrl: "not-on-wire" }]);
  assert.deepEqual(state.calls.map(({ body }) => body.type), ["ensure_session", "prompt"]);
  assert.equal(state.calls[0].body.provider, "pi-provider");
  assert.equal(state.calls[0].body.modelId, "pi-model");
  assert.equal(state.calls[0].body.thinkingLevel, "high");
  assert.equal("trusted" in state.calls[0].body, false);
  assert.equal(state.calls[1].body.images[0].previewUrl, undefined);
  assert.equal(state.writes.filter(([key]) => key === "connect").length, 1);
  assert.equal(state.native.isSubmitting(), false);
});

test("a captured first prompt survives unmounting while its native session is being prepared", async () => {
  const creating = Promise.withResolvers();
  const state = setup((_id, body) => body.type === "ensure_session" ? creating.promise : identity);
  const sent = state.native.submit("keep this prompt");
  assert.equal(state.native.isSubmitting(), true);
  state.state.mounted = false;
  creating.resolve(identity);
  await sent;
  assert.equal(state.calls.at(-1).body.message, "keep this prompt");
  assert.equal(state.calls.at(-1).id, "omp-ui-id");
  assert.equal(state.writes.some(([key]) => key === "connect"), false);
});

test("stop during preparation prevents a prompt; stop racing an ACK is sent again after acceptance", async () => {
  const ready = Promise.withResolvers();
  const preparing = setup((_id, body) => {
    if (body.type === "ensure_session") return ready.promise;
    if (body.type === "abort") throw new OmpClientError("not indexed yet", 404);
    return identity;
  });
  const before = preparing.native.submit("cancel before send");
  await preparing.native.abort();
  ready.resolve(identity); await before;
  assert.equal(preparing.calls.some(({ body }) => body.type === "prompt"), false);
  assert.ok(preparing.writes.some(([key]) => key === "rollback"));
  assert.ok(preparing.writes.some(([key, text]) => key === "restore" && text === "cancel before send"));
  const accepted = Promise.withResolvers(), dispatched = Promise.withResolvers();
  const racing = setup((_id, body) => { if (body.type === "prompt") { dispatched.resolve(); return accepted.promise; } return identity; });
  const sending = racing.native.submit("cancel an accepted prompt");
  await dispatched.promise;
  await racing.native.abort();
  accepted.resolve(identity); await sending;
  assert.deepEqual(racing.calls.map(({ body }) => body.type), ["ensure_session", "prompt", "abort", "abort"]);
});

test("failed native preparation restores the draft; an uncertain send is never automatically repeated", async () => {
  const rejected = setup(async () => { throw new OmpClientError("Invalid Pi model", 400); });
  await rejected.native.submit("restore me");
  assert.equal(rejected.calls.length, 1);
  assert.ok(rejected.writes.some(([key]) => key === "rollback"));
  assert.ok(rejected.writes.some(([key, value]) => key === "restore" && value === "restore me"));
  const uncertain = setup(async (_id, body) => { if (body.type === "prompt") throw new TypeError("connection lost"); return identity; });
  await uncertain.native.submit("not twice");
  assert.deepEqual(uncertain.calls.map(({ body }) => body.type), ["ensure_session", "prompt"]);
  assert.equal(uncertain.writes.some(([key]) => key === "rollback"), false);
  assert.ok(uncertain.writes.some(([key]) => key === "reconcile"));
  assert.ok(uncertain.writes.some(([key, text]) => key === "notice" && text.includes("not sent again")));
});

test("a delayed history read cannot replace newer SSE messages or a newer read", async () => {
  const view = (text) => ({ sessionId: "omp-existing", running: true, context: { messages: [{ role: "user", content: text }] } });
  for (const continuous of [false, true]) {
    const first = Promise.withResolvers(), second = Promise.withResolvers(), retry = Promise.withResolvers();
    let reads = 0;
    const state = setup(undefined, () => { if (++reads === 1) return first.promise; retry.resolve(); return second.promise; });
    state.state.id = "omp-existing";
    const loading = state.native.load(state.state.id, true);
    state.native.handleEvent({ type: "omp_snapshot", messages: [] });
    first.resolve(Response.json(view("old")));
    await retry.promise;
    if (continuous) state.native.handleEvent({ type: "message_end" });
    second.resolve(Response.json(view("fresh")));
    await loading;
    const applied = state.writes.filter(([key]) => key === "view");
    assert.equal(reads, 2, "at most one retry, not an unbounded history polling loop");
    assert.equal(applied.length, 1);
    assert.equal(applied[0][1].context.messages[0].content, "fresh");
    assert.equal(applied[0][2], continuous, "continuous events keep the live message list while metadata loads");
  }
  const old = Promise.withResolvers();
  let reads = 0;
  const state = setup(undefined, () => ++reads === 1 ? old.promise : Response.json(view("newer request")));
  state.state.id = "omp-existing";
  const earlier = state.native.load(state.state.id);
  await state.native.load(state.state.id);
  old.resolve(Response.json(view("late old request")));
  await earlier;
  assert.deepEqual(state.writes.filter(([key]) => key === "view").map(([, value]) => value.context.messages[0].content), ["newer request"]);
});

test("OMP queue controls use native endpoints, strip preview URLs and restore failed sends", async () => {
  const state = setup();
  state.state.id = "omp-existing"; state.state.known = true; state.state.busy = true;
  await state.native.queue("now", "steer", [{ data: "eA==", mimeType: "image/png", previewUrl: "local-preview" }]);
  await state.native.queue("later", "followUp");
  await state.native.recallQueue();
  assert.deepEqual(state.calls.map(({ body }) => body.type), ["prompt", "prompt", "clear_queue"]);
  assert.equal(state.calls[0].body.streamingBehavior, "steer");
  assert.equal(state.calls[1].body.streamingBehavior, "followUp");
  assert.equal(state.calls[0].body.images[0].previewUrl, undefined);
  const failing = setup(async () => { throw new TypeError("network lost"); });
  failing.state.id = "omp-existing"; failing.state.known = true;
  await failing.native.queue("restore this", "steer");
  assert.equal(failing.calls.length, 1);
  assert.ok(failing.writes.some(([kind, text]) => kind === "restore" && text === "restore this"));
});

test("model selection changes only after native confirmation, while snapshots and cancelled inputs stay native", async () => {
  const state = setup(async (_id, body) => { if (body.type === "set_model") throw new OmpClientError("Not available in Pi", 400); return identity; });
  state.state.id = "omp-existing"; state.state.known = true;
  assert.equal(await state.native.selectModel("other", "model"), false);
  assert.equal(state.writes.some(([key]) => key === "model"), false);
  assert.equal(state.calls[0].body.type, "set_model");
  assert.equal(state.native.handleEvent({ type: "omp_snapshot", messages: [{ role: "user", content: "history" }] }), true);
  assert.equal(state.native.handleEvent({ type: "agent_start" }), false);
  await state.native.respond("approval-id", { cancelled: true });
  assert.equal(state.calls.at(-1).body.type, "extension_ui_response");
  assert.equal(state.calls.at(-1).body.cancelled, true);
  const fresh = setup();
  assert.equal(await fresh.native.selectModel("pi-provider", "other"), true);
  assert.equal(fresh.calls.length, 0, "choosing before the first send cannot start a CLI");
});

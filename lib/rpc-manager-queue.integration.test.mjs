import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const catalog = await jiti.import("../app/api/catalog/sessions/route.ts");
const running = await jiti.import("../app/api/agent/running/route.ts");
const db = await jiti.import("./catalog-db.ts");

async function setup(t, inputGate) {
  const root = await mkdtemp(join(tmpdir(), "pi-queue-check-"));
  const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, data: process.env.CODING_AGENT_WEB_DATA, sessions: globalThis.__piSessions };
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.CODING_AGENT_WEB_DATA = join(root, "data.db");
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: !inputGate, noSkills: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: inputGate ? [(pi) => pi.on("input", async (event) => { if (event.text === "slow queued") { inputGate.entered.resolve(); await inputGate.release.promise; } return { action: "continue" }; })] : [],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root) });
  const wrapper = new AgentSessionWrapper(session);
  wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  globalThis.__piSessions = new Map([[wrapper.sessionId, wrapper]]);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  t.after(async () => {
    wrapper.destroy(); db.closeCatalogDb();
    globalThis.__piSessions = previous.sessions;
    for (const [key, value] of [["PI_CODING_AGENT_DIR", previous.agentDir], ["CODING_AGENT_WEB_DATA", previous.data]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const started = Promise.withResolvers();
  let release;
  faux.setResponses([
    (_context, options) => new Promise((resolve) => {
      release = () => resolve(fauxAssistantMessage("first answer"));
      options.signal.addEventListener("abort", release, { once: true });
      started.resolve();
    }),
    fauxAssistantMessage("steered answer"), fauxAssistantMessage("follow-up answer"),
  ]);
  await wrapper.send({ type: "prompt", message: "first" });
  await started.promise;
  return { wrapper, session, events, faux, release: () => release() };
}

for (const action of ["clear_queue", "abort"]) {
  test(`Pi ${action} takes back both native queues; Stop never starts a queued turn`, async (t) => {
    const { wrapper, session } = await setup(t);
    await wrapper.send({ type: "prompt", message: "later", streamingBehavior: "followUp" });
    await wrapper.send({ type: "prompt", message: "now", streamingBehavior: "steer" });
    assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: ["now"], followUp: ["later"] });
    for (const endpoint of [catalog, running]) {
      const snapshot = await (await endpoint.GET()).json();
      assert.ok(snapshot.runningSessionIds.includes(wrapper.sessionId), "both sidebar snapshots must list Pi");
    }
    assert.deepEqual(await wrapper.send({ type: action }), { steering: ["now"], followUp: ["later"] });
    if (action !== "abort") await wrapper.send({ type: "abort" });
    assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [], followUp: [] });
    assert.equal(wrapper.isRunning(), false);
    assert.equal(session.messages.filter((message) => message.role === "user").length, 1);
  });
}

for (const type of ["prompt", "steer", "follow_up"]) {
  test(`Pi Stop withdraws a late ${type} input handler and its waiting admissions`, async (t) => {
    const gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
    const { wrapper, session, faux } = await setup(t, gate);
    const submissions = ["slow queued", "also waiting"].map((message) => wrapper.send({ type, message, streamingBehavior: "followUp" }));
    const results = Promise.allSettled(submissions);
    await gate.entered.promise;
    await wrapper.send({ type: "abort" });
    gate.release.resolve();
    for (const result of await results) { assert.equal(result.status, "rejected"); assert.match(result.reason.message, /stopping/); }
    await session.waitForIdle();
    assert.deepEqual((await wrapper.send({ type: "get_state" })).queuedMessages, { steering: [], followUp: [] });
    assert.equal(faux.state.callCount, 1, "a withdrawn input must never reach another model request");
    assert.equal(wrapper.isRunning(), false);
  });
}

test("Pi Recall returns all queued images without changing native queue modes", async (t) => {
  const { wrapper, session } = await setup(t);
  const images = [{ type: "image", data: "eA==", mimeType: "image/png" }];
  for (const streamingBehavior of ["steer", "followUp"]) {
    for (let i = 0; i < 2; i++) await wrapper.send({ type: "prompt", message: `${streamingBehavior} ${i}`, images, streamingBehavior });
  }
  const previous = [session.agent.steeringMode, session.agent.followUpMode];
  const recalled = await wrapper.send({ type: "clear_queue" });
  assert.equal(recalled.images.length, 4);
  assert.deepEqual(recalled.images[0], { data: "eA==", mimeType: "image/png" });
  assert.deepEqual([session.agent.steeringMode, session.agent.followUpMode], previous);
  await wrapper.send({ type: "abort" });
});

test("Pi's native steer precedes follow-up and one settlement ends the logical run", async (t) => {
  const { wrapper, session, release, events } = await setup(t);
  await wrapper.send({ type: "prompt", message: "later", streamingBehavior: "followUp" });
  await wrapper.send({ type: "prompt", message: "now", streamingBehavior: "steer" });
  const settled = new Promise((resolve) => {
    const off = wrapper.onEvent((event) => { if (event.type === "agent_settled") { off(); resolve(); } });
  });
  release(); await settled;
  assert.deepEqual(session.messages.filter((message) => message.role === "user").map((message) => message.content[0].text), ["first", "now", "later"]);
  assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
});

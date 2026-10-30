import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const view = await jiti.import("./web-view.ts");

test("native proxy permits its fixed surface, not arbitrary URLs or encoded traversal", async () => {
  assert.equal(view.dshNativeRoute([], "?view=plugins"), "/?view=plugins");
  assert.equal(view.dshNativeRoute(["_stream"], ""), "/_stream");
  assert.equal(view.dshNativeRoute(["api", "pluginManager", "listBundles"], ""), "/api/pluginManager/listBundles");
  for (const parts of [["https:", "evil.example"], ["assets", ".."], ["assets", "%2e%2e"], ["assets", "../secret"], ["api", "file", "etc", "passwd"], ["assets", "a?x=y"], ["connect"]]) {
    assert.equal(view.dshNativeRoute(parts, ""), null);
  }
  const denied = await view.proxyDshNative(new Request("http://127.0.0.1/api/harnesses/dsh/native/", { headers: { host: "127.0.0.1", origin: "https://evil.example" } }), []);
  assert.equal(denied.status, 403);
  const script = view.dshTransportScript({ mode: "plugins" });
  assert.ok(script.includes("openStream"));
  assert.ok(!script.includes("?token="));
  assert.ok(!script.includes("cookie"));
});

test("management admission fails closed for other conversations and background jobs", async () => {
  let running = true, job = "finished", applied = false;
  const key = Symbol.for("coding-agent-web.dshWebHost");
  globalThis[key] = {
    call: async () => ({ items: [{ sessionId: "another-tab", running, agentAvailable: true }] }),
    stream: async () => ({ readable: new ReadableStream({ start(controller) { controller.enqueue({ jobs: [{ status: job }] }); } }) }),
  };
  try {
    await assert.rejects(() => view.dshAdmission(true, async () => { applied = true; }), /running conversations/);
    running = false; job = "stopping";
    await assert.rejects(() => view.dshAdmission(true, async () => { applied = true; }), /background jobs/);
    assert.equal(applied, false);
    job = "finished";
    await view.dshAdmission(true, async () => { applied = true; });
    assert.equal(applied, true);
  } finally { delete globalThis[key]; }
});

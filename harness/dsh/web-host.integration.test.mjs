import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { DshWebHost, DSH_WEB_PROFILE } = await jiti.import("./web-host.ts");

test("native Web Host, authenticated RPC, independent profile and live plugin changes without TUI", { skip: process.env.DSH_NATIVE_TEST !== "1", timeout: 120_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "coding-agent-dsh-web-"));
  const host = new DshWebHost(home);
  try {
    await host.ready();
    assert.equal(host.profileDir, join(home, "profiles", DSH_WEB_PROFILE));
    const catalog = await host.call("session/modelCatalog");
    assert.ok(Array.isArray(catalog.groups));
    const bundles = await host.call("pluginManager/listBundles");
    assert.ok(bundles.some((bundle) => bundle.name === "@deepseek-ai/dsh-web-app"));
    const plugins = await host.call("pluginManager/listPlugins");
    const timer = plugins.find((plugin) => plugin.moduleName === "@deepseek-ai/dsh-session-title-first-prompt-llm" && !plugin.readOnlyReason);
    assert.ok(timer, "native inventory exposes an addressable context plugin");
    const changed = await host.call("pluginManager/setPluginEnabled", { id: timer.entryId, enabled: false });
    assert.equal(changed.application, "applied");
    assert.equal((await host.call("pluginManager/listPlugins")).find((plugin) => plugin.entryId === timer.entryId).enabled, false);
    const created = await host.call("session/create", { request: { cwd: home } });
    assert.ok(created.sessionId);
    const stream = await host.stream("session/follow", { request: { address: { kind: "session", sessionId: created.sessionId }, maxMessages: 50, assistantStream: true } });
    const reader = stream.readable.getReader();
    try {
      const { value } = await reader.read();
      assert.equal(value.type, "snapshot");
      assert.equal(value.header.id, created.sessionId);
      assert.equal(value.header.cwd, home);
    } finally { await reader.cancel(); }
    await assert.rejects(host.call("session/selectModel", { request: { sessionId: created.sessionId, provider: "missing-provider", model: "missing" } }), /available|model/i);
    await assert.rejects(host.fetch("//example.com/"), /Invalid/);
    const settings = await host.call("settings/describe");
    assert.ok(settings);
  } finally {
    await host.stop();
    await rm(home, { recursive: true, force: true });
  }
});

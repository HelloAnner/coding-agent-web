import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";

// Uses a disposable native profile and a small HTTP carrier, never the user's Next server or dsh home.
test("official browser Client, plugin configuration and module assets work through the protected HTTP carrier", { skip: process.env.DSH_BROWSER_TEST !== "1", timeout: 180_000 }, async () => {
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
  const { DshWebHost } = await jiti.import("./web-host.ts");
  const home = await mkdtemp(join(tmpdir(), "coding-agent-dsh-view-"));
  process.env.CODING_AGENT_WEB_DATA = join(home, "catalog.db");
  const { upsertCatalogSession, closeCatalogDb } = await jiti.import("../../lib/catalog-db.ts");
  const host = new DshWebHost(home);
  globalThis[Symbol.for("coding-agent-web.dshWebHost")] = host;
  const { proxyDshNative, DSH_NATIVE_PREFIX, ensureDshEmbed } = await jiti.import("./web-view.ts");
  const failures = [];
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const relative = url.pathname.slice(DSH_NATIVE_PREFIX.length).split("/").filter(Boolean).map(decodeURIComponent);
      const request = new Request(url, { method: req.method, headers: req.headers, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}), signal: abort.signal });
      const response = await proxyDshNative(request, relative);
      if (response.status >= 400 && !abort.signal.aborted) failures.push([url.pathname, response.status]);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        try { while (true) { const { value, done } = await reader.read(); if (done) break; if (!res.write(value)) await once(res, "drain"); } }
        finally { await reader.cancel().catch(() => {}); }
      }
      res.end();
    } catch { res.destroy(); }
  });
  let browser;
  try {
    await ensureDshEmbed();
    assert.ok((await host.call("pluginManager/listBundles")).some((bundle) => bundle.name === "@coding-agent-web/dsh-embed" && bundle.enabled));
    const fixture = join(home, "fixture");
    await mkdir(fixture);
    await writeFile(join(fixture, "package.json"), JSON.stringify({ name: "@coding-agent-web/native-fixture", version: "1.0.0", type: "commonjs", main: "index.cjs", exports: { ".": "./index.cjs", "./client": "./client.js" }, dsh: { bundle: { patch: "./cordis.patch.yml" }, client: { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-plugin-manager"] } } }));
    await writeFile(join(fixture, "index.cjs"), "exports.name = 'native-fixture'; exports.apply = function () {};\n");
    await writeFile(join(fixture, "cordis.patch.yml"), "- insert:\n    - id: native-fixture\n      name: '@coding-agent-web/native-fixture'\n");
    await writeFile(join(fixture, "client.js"), `window.__ModuleLoader__.load({id:"@coding-agent-web/native-fixture",factory:function(require){var React=require("react");return {inject:["slots"],apply:function(ctx){ctx.slots.inject("plugins.bundle.config",function(){return ctx.slots.register({name:"plugins.bundle.config",key:"@coding-agent-web/native-fixture"},function(){var state=React.useState("native-config");return React.createElement("label",null,"Fixture value",React.createElement("input",{value:state[0],onChange:function(e){state[1](e.target.value)}}));});});}};}});`);
    const installed = await host.call("pluginManager/installBundle", { spec: `link:${fixture}`, options: { enabled: true } });
    assert.equal(installed.application, "applied");
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    await page.addInitScript(() => { window.__NativeMessages = []; window.addEventListener("message", (event) => { window.__NativeMessages.push(event.data); }); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}${DSH_NATIVE_PREFIX}?view=plugins`);
    await page.waitForFunction(() => document.body.innerText.includes("插件") || document.body.innerText.includes("Plugins"), { timeout: 30_000 });
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByText("Install, enable, and configure plugins", { exact: true }).waitFor({ timeout: 10_000 }).catch(async (error) => { throw new Error(error.message + "\n" + JSON.stringify(await page.evaluate(() => window.__NativeMessages))); });
    await page.getByText("@coding-agent-web/native-fixture", { exact: true }).click();
    await page.getByLabel("Fixture value").waitFor({ timeout: 10_000 }).catch(async (error) => { throw new Error(error.message + "\n" + await page.locator("body").innerText() + "\n" + JSON.stringify({ errors, failures, messages: await page.evaluate(() => window.__NativeMessages) })); });
    await page.getByLabel("Fixture value").fill("plugin-ui-loaded-without-app-changes");
    assert.equal(await page.getByLabel("Fixture value").inputValue(), "plugin-ui-loaded-without-app-changes");
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${origin}${DSH_NATIVE_PREFIX}?view=models`);
    await page.waitForFunction(() => window.__NativeMessages.some((value) => value.type === "coding-agent-dsh-selection" && value.nativeId), { timeout: 15_000 });
    await page.getByRole("button", { name: "Models and credentials", exact: true }).click();
    await page.getByText("Models", { exact: true }).last().click();
    await page.getByRole("button", { name: "Add model provider", exact: true }).waitFor({ timeout: 15_000 });
    await host.call("session/create", { request: { sessionId: "native-existing-session", cwd: home } });
    upsertCatalogSession({ id: "web-legacy-id", harness: "dsh", cwd: home, sessionPath: join(home, "sessions/project/native-existing-session") });
    await page.goto(`${origin}${DSH_NATIVE_PREFIX}?view=session&session=web-legacy-id`);
    await page.waitForFunction(() => window.__NativeMessages.some((value) => value.type === "coding-agent-dsh-selection" && value.nativeId === "native-existing-session"), null, { timeout: 10_000 }).catch(async (error) => { throw new Error(error.message + "\n" + await page.locator("body").innerText() + "\n" + JSON.stringify({ errors, failures, state: await page.evaluate(() => ({ view: window.__CODING_AGENT_DSH_VIEW__, messages: window.__NativeMessages })) })); });
    assert.deepEqual(errors, [], JSON.stringify(errors));
    assert.deepEqual(failures.filter(([, status]) => status >= 400), [], JSON.stringify(failures));
    assert.equal(await page.evaluate(() => !!window.__DSH_TRANSPORT__.openStream), true);
    assert.ok(!(await page.content()).includes("?token="));
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await host.stop();
    closeCatalogDb();
    await rm(home, { recursive: true, force: true });
  }
});

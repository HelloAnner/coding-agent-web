import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";

// Uses a disposable native profile and a small HTTP carrier, never the user's Next server or dsh home.
test("official browser Client, plugin configuration and module assets work through the protected HTTP carrier", { skip: process.env.DSH_BROWSER_TEST !== "1", timeout: 180_000 }, async () => {
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
  const { DshWebHost } = await jiti.import("./web-host.ts");
  const home = await mkdtemp(join(tmpdir(), "coding-agent-dsh-view-"));
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
      if (response.status >= 400) failures.push([url.pathname, response.status]);
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
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}${DSH_NATIVE_PREFIX}?view=plugins`);
    await page.waitForFunction(() => document.body.innerText.includes("插件") || document.body.innerText.includes("Plugins"), { timeout: 30_000 });
    await page.waitForTimeout(1500);
    assert.deepEqual(errors, [], JSON.stringify(errors));
    assert.deepEqual(failures.filter(([, status]) => status >= 400), [], JSON.stringify(failures));
    assert.equal(await page.evaluate(() => !!window.__DSH_TRANSPORT__.openStream), true);
    assert.ok(!(await page.content()).includes("?token="));
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await host.stop();
    await rm(home, { recursive: true, force: true });
  }
});

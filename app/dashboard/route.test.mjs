import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  dashboardOverview,
  dashboardPage,
  startDashboardServer,
} from "../../dashboard/server.mjs";

const dashboardDir = new URL("../../dashboard/", import.meta.url);

test("the dashboard's backend reports its own figures", () => {
  const first = dashboardOverview();
  const second = dashboardOverview();
  assert.equal(first.app, "dashboard");
  assert.equal(Number.isNaN(Date.parse(first.generatedAt)), false);
  assert.equal(Number.isNaN(Date.parse(first.serverStartedAt)), false);
  assert.ok(first.serverUptimeSeconds >= 0);
  assert.ok(first.processUptimeSeconds >= 0);
  assert.equal(second.requestsServed, first.requestsServed + 1);
  assert.ok(first.memory.totalBytes > 0);
  assert.ok(first.memory.usedBytes >= 0);
  assert.ok(first.memory.percent >= 0 && first.memory.percent <= 100);
  assert.equal(first.load.length, 3);
  assert.ok(first.load.every((value) => Number.isFinite(value) && value >= 0));
  assert.ok(first.host.hostname);
  assert.ok(first.host.cpuCount >= 1);
  assert.equal(typeof first.host.node, "string");
  assert.ok(first.host.uptimeSeconds >= 0);
});

test("the page is the dashboard folder's, with its own CSS and JS inlined", async () => {
  const html = await dashboardPage();
  assert.doesNotMatch(html, /\{\{styles\}\}|\{\{script\}\}/);
  assert.match(html, /<title>Dashboard<\/title>/);
  assert.match(html, /class="app-switch"/);
  assert.match(html, /aria-checked="true" href="\/dashboard"/);
  assert.match(html, /aria-checked="false" href="\/">[\s\S]*?<span>Coding<\/span>/);
  assert.match(html, /\/api\/dashboard\/overview/);
  // The styles and script are embedded, not linked.
  assert.match(html, /--accent:/);
  assert.match(html, /function render\(data\)/);
});

test("the dashboard imports nothing from the coding app", async () => {
  const sources = await Promise.all(
    ["index.html", "styles.css", "app.js", "server.mjs"].map((name) => readFile(new URL(name, dashboardDir), "utf8")),
  );
  for (const source of sources) {
    assert.doesNotMatch(source, /@\/(components|lib|hooks)\//);
    assert.doesNotMatch(source, /from ["']\.\.\//);
  }
  const server = sources[3];
  for (const match of server.matchAll(/from "([^"]+)"/g)) {
    assert.match(match[1], /^node:/, `server.mjs imports only Node built-ins: ${match[1]}`);
  }
});

test("the standalone server serves the page and its API on its own port", async () => {
  const server = startDashboardServer({ port: 0, host: "127.0.0.1" });
  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const page = await fetch(`${base}/dashboard`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await page.text(), /<title>Dashboard<\/title>/);

    const overview = await fetch(`${base}/api/dashboard/overview`);
    assert.equal(overview.status, 200);
    const body = await overview.json();
    assert.equal(body.app, "dashboard");
    assert.ok(Array.isArray(body.load));

    assert.equal((await fetch(`${base}/missing`)).status, 404);
    assert.equal((await fetch(`${base}/api/dashboard/overview`, { method: "POST" })).status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

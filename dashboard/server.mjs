// The dashboard's own backend. It knows nothing about the coding agent: only
// the host's figures, kept by this module, and the dashboard's own files.

import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";

const startedAt = Date.now();
const here = dirname(fileURLToPath(import.meta.url));
let requestsServed = 0;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The dashboard's folder: the working directory's in this repo, else this file's. */
async function dashboardDir() {
  for (const dir of [process.env.PI_DASHBOARD_DIR, join(process.cwd(), "dashboard"), here]) {
    if (dir && await exists(join(dir, "index.html"))) return dir;
  }
  throw new Error("dashboard files not found");
}

async function buildPage() {
  const dir = await dashboardDir();
  const [html, styles, script, font] = await Promise.all([
    readFile(join(dir, "index.html"), "utf8"),
    readFile(join(dir, "styles.css"), "utf8"),
    readFile(join(dir, "app.js"), "utf8"),
    readFile(join(dir, "fonts", "noto-sans-mono-latin.woff2")).catch(() => null),
  ]);
  // The same mono face as the coding app, kept inside this folder and
  // embedded so the page needs no asset route.
  const fontUrl = font ? `data:font/woff2;base64,${font.toString("base64")}` : "";
  // Replacer functions: the CSS and JS may contain "$" sequences.
  return html
    .replace("{{styles}}", () => styles.replace("{{font}}", () => fontUrl))
    .replace("{{script}}", () => script);
}

let productionPage = null;

/** The three files as one HTML document (the Next route and the standalone server). */
export function dashboardPage() {
  if (process.env.NODE_ENV !== "production") return buildPage();
  productionPage ??= buildPage();
  return productionPage;
}

/** What the dashboard shows. Its shape belongs to this app alone. */
export function dashboardOverview() {
  requestsServed += 1;
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  return {
    app: "dashboard",
    generatedAt: new Date().toISOString(),
    serverStartedAt: new Date(startedAt).toISOString(),
    serverUptimeSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
    processUptimeSeconds: Math.round(process.uptime()),
    requestsServed,
    memory: {
      usedBytes,
      totalBytes,
      percent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    },
    load: os.loadavg().map((value) => Math.round(value * 100) / 100),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      node: process.version,
      uptimeSeconds: Math.round(os.uptime()),
    },
  };
}

const CONTENT_TYPES = {
  "/": "text/html; charset=utf-8",
  "/dashboard": "text/html; charset=utf-8",
  "/api/dashboard/overview": "application/json; charset=utf-8",
};

/**
 * Standalone mode: `node dashboard/server.mjs` serves the same page and API
 * on its own port, without Next or anything else in this repo.
 */
export function startDashboardServer({
  port = Number(process.env.DASHBOARD_PORT || 4310),
  host = process.env.DASHBOARD_HOST || "127.0.0.1",
} = {}) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end("Method not allowed");
      return;
    }
    const path = url.pathname;
    if (path === "/" || path === "/dashboard") {
      response.writeHead(200, {
        "Content-Type": CONTENT_TYPES[path],
        "Cache-Control": "no-store",
      });
      response.end(await dashboardPage());
      return;
    }
    if (path === "/api/dashboard/overview") {
      response.writeHead(200, {
        "Content-Type": CONTENT_TYPES[path],
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(dashboardOverview()));
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });
  server.listen(port, host, () => {
    console.log(`Dashboard on http://${host}:${port}/dashboard`);
  });
  return server;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) startDashboardServer();

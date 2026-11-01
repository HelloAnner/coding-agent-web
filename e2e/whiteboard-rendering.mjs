// node e2e/whiteboard-rendering.mjs
// Bundle only the real canvas component into a temporary browser fixture: no
// Next build/server, credentials, notes files, or user database are touched.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack");
const repo = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), "whiteboard-rendering-"));
const output = path.join(temp, "out");
let server;
let browser;
try {
  const source = await readFile(path.join(repo, "notes/ui/WhiteboardCanvas.tsx"), "utf8");
  await writeFile(path.join(temp, "canvas.js"), ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText);
  await writeFile(path.join(temp, "mobile.js"), ts.transpileModule(
    await readFile(path.join(repo, "hooks/useIsMobile.ts"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
  ).outputText);
  await writeFile(path.join(temp, "entry.js"), `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import Canvas from "./canvas.js";
    window.resizeEvents = 0;
    window.addEventListener("resize", () => window.resizeEvents++);
    const root = createRoot(document.getElementById("root"));
    const props = {
      content: JSON.stringify({ elements: [], appState: { viewModeEnabled: window.innerWidth > 640 }, files: {} }),
      view: { scrollX: 0, scrollY: 0, zoom: 1 },
      theme: "light", board: { fontFamily: 2, fontSize: 20 },
      onChange: scene => window.saved = JSON.parse(scene),
      onViewChange: view => window.view = view,
    };
    window.loadScene = content => root.render(React.createElement(Canvas, { ...props, content }));
    window.loadScene(props.content);
  `);
  await new Promise((resolve, reject) => {
    const compiler = webpack({
      mode: "development", devtool: false, entry: path.join(temp, "entry.js"),
      output: { path: output, filename: "bundle.js", publicPath: "/" },
      resolve: {
        alias: { "@/hooks/useIsMobile": path.join(temp, "mobile.js") },
        modules: ["node_modules", path.join(repo, "node_modules")],
        conditionNames: ["browser", "import", "production", "default"],
      },
      module: { rules: [
        { test: /\.css$/, type: "asset/source" },
        { test: /\.m?js$/, resolve: { fullySpecified: false } },
      ] },
      performance: { hints: false },
    });
    compiler.run((error, stats) => compiler.close((closeError) => {
      if (error || closeError || stats.hasErrors()) {
        reject(error || closeError || new Error(stats.toString({ all: false, errors: true })));
      } else resolve();
    }));
  });
  server = createServer(async (request, response) => {
    try {
      if (request.url === "/") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/excalidraw.css"><link rel="stylesheet" href="/notes.css">
          <style>body{margin:0}#root{position:fixed;inset:40px 0 0 80px;display:flex}
          .notes-board{position:relative;flex:1;min-height:0}
          .notes-board>.excalidraw{position:absolute;inset:0}
          .selected-shape-actions{display:none!important}</style>
          <div id="root"></div><script src="/bundle.js"></script>`);
        return;
      }
      const css = request.url === "/excalidraw.css" || request.url === "/notes.css";
      const file = css
        ? path.join(repo, request.url === "/notes.css" ? "notes/ui/notes.css" : "node_modules/@excalidraw/excalidraw/dist/prod/index.css")
        : path.resolve(output, `.${request.url}`);
      if (!css && !file.startsWith(output + path.sep)) { response.writeHead(404).end(); return; }
      response.setHeader("Content-Type", css ? "text/css; charset=utf-8" : file.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/octet-stream");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector("canvas.static");
  await page.waitForFunction(() => window.saved && window.view);
  assert.equal(await page.locator(".excalidraw--view-mode").count(), 0, "Desktop opens in edit mode even if file says view mode");
  await page.keyboard.press("o");
  await page.mouse.move(300, 240);
  await page.mouse.down();
  await page.mouse.move(620, 460, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => window.saved.elements.length === 1);
  await page.evaluate(() => { window.originalCanvases = [...document.querySelectorAll("canvas")]; });
  const original = await page.evaluate(() => window.saved.elements);

  // Read rendered pixels, not just stored coordinates: stale bitmaps can have
  // correct scene data/selection bounds while drawing at the wrong scale.
  const checkAlignment = async (expectedElements = original) => {
    const result = await page.evaluate(() => {
      const canvas = document.querySelector("canvas.static");
      const rect = canvas.getBoundingClientRect();
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let left = Infinity, top = Infinity, right = -1, bottom = -1;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (pixels[i + 3] > 100 && pixels[i] < 120 && pixels[i + 1] < 120 && pixels[i + 2] < 180) {
          left = Math.min(left, x); top = Math.min(top, y);
          right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
      }
      const element = window.saved.elements.find((e) => !e.isDeleted);
      const view = window.view;
      return {
        actual: [rect.x + left * rect.width / canvas.width, rect.y + top * rect.height / canvas.height,
          (right - left + 1) * rect.width / canvas.width, (bottom - top + 1) * rect.height / canvas.height],
        expected: [rect.x + (element.x + view.scrollX) * view.zoom, rect.y + (element.y + view.scrollY) * view.zoom,
          element.width * view.zoom, element.height * view.zoom],
        sameCanvases: window.originalCanvases.every((c, i) => c === document.querySelectorAll("canvas")[i]),
        elements: window.saved.elements,
      };
    });
    result.actual.forEach((value, i) => assert.ok(Math.abs(value - result.expected[i]) < 6,
      `Rendered bounds ${result.actual} must match element/selection bounds ${result.expected}`));
    assert.ok(result.sameCanvases, "Changing displays must not remount the board");
    assert.deepEqual(result.elements, expectedElements, "Redrawing must not change the scene or element versions");
  };
  await checkAlignment();
  const cdp = await page.context().newCDPSession(page);
  for (const ratio of [1.25, 2, 1]) {
    const view = await page.evaluate(() => window.view);
    // Moving a window between displays can change DPR without any resize.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 720, deviceScaleFactor: ratio, mobile: false });
    await page.waitForTimeout(250);
    assert.deepEqual(await page.evaluate(() => window.view), view, "Keep pan/zoom when rebuilding bitmaps");
    await page.mouse.move(700, 500);
    await page.mouse.wheel(0, 15);
    await page.waitForTimeout(350);
    await checkAlignment();
  }
  assert.equal(await page.evaluate(() => window.resizeEvents), 0, "Regression must not rely on resize invalidation");

  // Hit the unfilled ellipse's outline, drag it, then undo twice. Cache refreshes
  // must preserve hit testing and must not insert extra undo steps.
  const point = await page.evaluate(() => {
    const e = window.saved.elements[0], v = window.view;
    const r = document.querySelector("canvas.static").getBoundingClientRect();
    return { x: r.x + (e.x + v.scrollX) * v.zoom, y: r.y + (e.y + e.height / 2 + v.scrollY) * v.zoom };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 30, point.y + 20, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction((x) => Math.abs(window.saved.elements[0].x - x - 30) < 1, original[0].x);
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForFunction((x) => window.saved.elements[0]?.x === x, original[0].x);
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForFunction(() => window.saved.elements.every((e) => e.isDeleted));
  // A completed agent write must fill an already-open empty board in place.
  const view = await page.evaluate(() => window.view);
  // restoreElements normalizes an unbound shape's null bindings to [].
  const refreshed = original.map((element) => ({ ...element, boundElements: element.boundElements ?? [] }));
  await page.evaluate((elements) => {
    window.loadScene(JSON.stringify({ elements, appState: {}, files: {} }));
  }, refreshed);
  await page.waitForFunction(() => window.saved.elements.some((element) => !element.isDeleted));
  assert.deepEqual(await page.evaluate(() => window.view), view, "Reloading content must keep pan/zoom");
  await checkAlignment(refreshed);
  // New opens choose the device default, not the last saved mode. A manual
  // change survives status/content renders and crossing the mobile breakpoint.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.on("pageerror", (error) => errors.push(error.message));
  await mobile.goto(`http://127.0.0.1:${server.address().port}`);
  await mobile.waitForSelector(".excalidraw--view-mode");
  await mobile.evaluate((elements) => window.loadScene(JSON.stringify({ elements, appState: { viewModeEnabled: false }, files: {} })), refreshed);
  await mobile.waitForFunction(() => window.saved?.elements.length === 1);
  const beforePan = await mobile.evaluate(() => window.saved.elements);
  const beforeView = await mobile.evaluate(() => window.view);
  await mobile.mouse.move(180, 300);
  await mobile.mouse.down();
  await mobile.mouse.move(230, 340, { steps: 5 });
  await mobile.mouse.up();
  await mobile.waitForFunction((before) => window.view.scrollX !== before.scrollX || window.view.scrollY !== before.scrollY, beforeView);
  assert.deepEqual(await mobile.evaluate(() => window.saved.elements), beforePan, "Viewing pans without editing elements");
  const modeButton = await mobile.locator(".notes-board-mode").boundingBox();
  assert.ok(modeButton.width >= 44 && modeButton.height >= 44, "Mobile mode toggle has a touch-sized target");
  assert.ok(await mobile.evaluate((box) => {
    const overlay = document.createElement("aside");
    overlay.className = "notes-agent";
    document.getElementById("root").append(overlay);
    const above = overlay.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    overlay.remove();
    return above;
  }, modeButton), "Mode button stays below the mobile agent/drawer overlays");
  await mobile.getByRole("button", { name: "编辑", exact: true }).click();
  await mobile.waitForFunction(() => !document.querySelector(".excalidraw--view-mode"));
  await mobile.getByRole("button", { name: "查看", exact: true }).click();
  await mobile.waitForSelector(".excalidraw--view-mode");
  await mobile.getByRole("button", { name: "编辑", exact: true }).click();
  await mobile.waitForFunction(() => !document.querySelector(".excalidraw--view-mode"));
  await mobile.evaluate(() => window.loadScene(JSON.stringify(window.saved)));
  await mobile.setViewportSize({ width: 800, height: 600 });
  await mobile.setViewportSize({ width: 390, height: 844 });
  assert.equal(await mobile.locator(".excalidraw--view-mode").count(), 0, "Manual edit mode is not reset by rerenders or resize");
  await mobile.reload();
  await mobile.waitForSelector(".excalidraw--view-mode");
  await mobile.close();
  assert.deepEqual(errors, []);
  console.log("Whiteboard: mobile view/edit defaults, manual toggles, content updates, DPR, hit testing and undo pass.");
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}

// node e2e/whiteboard-export.mjs
// Bundle only the real canvas component into a temporary browser fixture: no
// Next build/server, credentials, notes files, or user database are touched.
// The board's right-click menu must offer 导出图片, and that item must download
// the whole scene as a PNG named after the board file.
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
const temp = await mkdtemp(path.join(tmpdir(), "whiteboard-export-"));
const output = path.join(temp, "out");
let server, browser;
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
    createRoot(document.getElementById("root")).render(React.createElement(Canvas, {
      content: JSON.stringify({ elements: [], appState: {}, files: {} }),
      view: { scrollX: 0, scrollY: 0, zoom: 1 },
      theme: "light", board: { fontFamily: 2, fontSize: 20 }, name: "架构图",
      onChange: () => {}, onViewChange: () => {},
    }));
  `);
  await new Promise((resolve, reject) => {
    const compiler = webpack({
      mode: "development", devtool: false, entry: path.join(temp, "entry.js"),
      output: { path: output, filename: "bundle.js", publicPath: "/" },
      resolve: { alias: { "@/hooks/useIsMobile": path.join(temp, "mobile.js") }, modules: ["node_modules", path.join(repo, "node_modules")], conditionNames: ["browser", "import", "production", "default"] },
      module: { rules: [{ test: /\.css$/, type: "asset/source" }, { test: /\.m?js$/, resolve: { fullySpecified: false } }] },
      performance: { hints: false },
    });
    compiler.run((error, stats) => compiler.close((closeError) => {
      if (error || closeError || stats.hasErrors()) reject(error || closeError || new Error(stats.toString({ all: false, errors: true })));
      else resolve();
    }));
  });
  server = createServer(async (request, response) => {
    try {
      if (request.url === "/") {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><link rel="stylesheet" href="/excalidraw.css">
          <style>body{margin:0}#root{position:fixed;inset:0;display:flex}
          .notes-board{position:relative;flex:1;min-height:0}
          .notes-board>.excalidraw{position:absolute;inset:0}</style>
          <div id="root"></div><script src="/bundle.js"></script>`);
        return;
      }
      const css = request.url === "/excalidraw.css";
      const file = css
        ? path.join(repo, "node_modules/@excalidraw/excalidraw/dist/prod/index.css")
        : path.resolve(output, `.${request.url}`);
      response.setHeader("Content-Type", css ? "text/css" : "text/javascript; charset=utf-8");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector("canvas.static");
  await page.waitForTimeout(500);
  await page.keyboard.press("r");
  await page.mouse.move(300, 240);
  await page.mouse.down();
  await page.mouse.move(620, 460, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  await page.mouse.click(700, 550, { button: "right" });
  const item = page.locator('[data-testid="board-export-image"]');
  await item.waitFor({ timeout: 5000 });
  assert.match(await page.locator(".context-menu").innerText(), /导出图片/, "menu lists 导出图片");
  const downloadPromise = page.waitForEvent("download", { timeout: 20000 });
  await item.locator("button").click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "架构图.png", "file is named after the board");
  const bytes = await readFile(await download.path());
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "must be a PNG");
  assert.ok(bytes.length > 1000, `PNG looks empty: ${bytes.length} bytes`);
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".context-menu").count(), 0, "menu closes after the click");
  // Opening the menu again must not stack a second copy of the item.
  await page.mouse.click(700, 550, { button: "right" });
  await item.waitFor({ timeout: 5000 });
  assert.equal(await item.count(), 1, "one item per open menu");
  assert.deepEqual(errors, []);
  console.log("Whiteboard: right-click 导出图片 downloads the whole board as <title>.png and closes the menu.");
} finally {
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
}

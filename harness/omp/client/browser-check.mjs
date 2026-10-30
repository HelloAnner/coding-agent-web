// Isolated real React controls/hook + fake HTTP/SSE. No Next server/build,
// credentials, user sessions, or native model inference are touched.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack");
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), "omp-browser-"));
const calls = [], streams = new Set();
let browser, server;
let messages = [], running = false, model = { provider: "shared", modelId: "first" };
let queuedMessages = { steering: [], followUp: [] };
const emit = (frame) => { for (const stream of streams) stream.write(`data: ${JSON.stringify(frame)}\n\n`); };
const view = (id) => ({ sessionId: id, filePath: "/omp/2026-10-30T00-00-00-000Z_native-uuid.jsonl", tree: [], leafId: null,
  context: { messages, entryIds: messages.map((message) => message.nativeId), oldestEntryId: null, hasMore: false, turnsBefore: 0, model, thinkingLevel: "medium" },
  running, state: { isStreaming: running, isPromptRunning: false, model: { provider: model.provider, id: model.modelId }, thinkingLevel: "medium", queuedMessages },
});
try {
  await writeFile(path.join(temp, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=function(source){return ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText}`);
  await writeFile(path.join(temp, "entry.tsx"), `
    import React, { useRef, useState } from "react";
    import { createRoot } from "react-dom/client";
    import { ChatInput } from "@/components/ChatInput";
    import { useAgentSession } from "@/hooks/useAgentSession";
    import { I18nProvider, useI18n } from "@/hooks/useI18n";
    function App() {
      const { t } = useI18n();
      const [session, setSession] = useState(() => JSON.parse(sessionStorage.getItem("fixture-session") || "null"));
      const [harness, setHarness] = useState(session?.harness || "pi");
      const input = useRef(null);
      const agent = useAgentSession({ session, harness, newSessionCwd: "/fixture", newSessionDraftKey: "fixture-draft", chatInputRef: input, t,
        onSessionCreated: value => { sessionStorage.setItem("fixture-session", JSON.stringify(value)); setSession(value); } });
      return <main><div ref={agent.scrollContainerRef}>
        <div data-testid="status">{agent.agentRunning ? "running" : "idle"}</div>
        <div data-testid="messages">{agent.messages.map((message, index) => <p key={index}>{typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("")}</p>)}</div>
        {agent.extensionDialog && <button data-testid="ask" onClick={() => agent.respondToExtensionUi(agent.extensionDialog, { value: agent.extensionDialog.options?.[0] ?? "ok" })}>{agent.extensionDialog.title}</button>}
        {agent.notices.map(notice => <p key={notice.id}>{notice.message}</p>)}
      </div><ChatInput ref={input} onSend={agent.handleSend} onAbort={agent.handleAbort} isStreaming={agent.agentRunning}
        onSteer={agent.agentRunning ? agent.handleSteer : undefined} onFollowUp={agent.agentRunning ? agent.handleFollowUp : undefined}
        onPromptWithStreamingBehavior={agent.agentRunning ? agent.handlePromptWithStreamingBehavior : undefined}
        queuedMessages={agent.queuedMessages} onRecallQueue={agent.handleRecallQueue}
        harness={harness} onHarnessChange={setHarness} harnessLocked={Boolean(session) || agent.agentRunning}
        model={agent.displayModel} modelList={agent.modelList} modelNames={agent.modelNames} onModelChange={agent.handleModelChange}
        modelControlsLocked={harness === "omp" && (agent.agentRunning || agent.modelSwitching)} modelSwitching={agent.modelSwitching}
        thinkingLevel={agent.thinkingLevel} onThinkingLevelChange={agent.handleThinkingLevelChange} cwd="/fixture" draftKey={session?.id || "fixture-draft"} />
      </main>;
    }
    createRoot(document.getElementById("root")).render(<I18nProvider><App /></I18nProvider>);
  `);
  await new Promise((resolve, reject) => {
    const compiler = webpack({ mode: "development", devtool: false, entry: path.join(temp, "entry.tsx"),
      output: { path: path.join(temp, "out"), filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js", ".mjs", ".json"], alias: { "@": repo }, modules: [path.join(repo, "node_modules"), "node_modules"], conditionNames: ["browser", "import", "default"] },
      module: { rules: [{ test: /\.tsx?$/, use: path.join(temp, "loader.cjs") }] }, performance: { hints: false },
    });
    compiler.run((error, stats) => compiler.close((closeError) => error || closeError || stats.hasErrors()
      ? reject(error || closeError || new Error(stats.toString({ all: false, errors: true }))) : resolve()));
  });
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const json = (value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
      if (url.pathname === "/") { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><meta charset="utf-8"><style>body{margin:24px}main{height:650px;display:flex;flex-direction:column}main>div{flex:1;overflow:auto}:root{--bg:white;--bg-panel:white;--text:black;--text-muted:#555;--border:#bbb;--bg-hover:#eee}</style><div id="root"></div><script src="/bundle.js"></script>'); return; }
      if (url.pathname.endsWith(".js")) { res.setHeader("Content-Type", "text/javascript"); res.end(await readFile(path.join(temp, "out", path.basename(url.pathname)))); return; }
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ path: url.pathname, body });
      if (url.pathname === "/api/harnesses") { json({ harnesses: [{ id: "pi", label: "pi" }, { id: "omp", label: "omp" }] }); return; }
      if (url.pathname === "/api/models") { json({ models: { "shared:first": "Shared first", "shared:second": "Shared second" }, modelList: ["first", "second"].map(id => ({ provider: "shared", id, name: `Shared ${id}` })), defaultModel: { provider: "shared", modelId: "first" }, defaultThinkingLevel: "medium", thinkingLevels: {}, thinkingLevelMaps: {}, thinkingLevelPins: {} }); return; }
      if (url.pathname.startsWith("/api/omp/")) {
        const id = url.pathname.split("/")[3];
        const identity = () => ({ sessionPath: view(id).filePath, provider: model.provider, model: model.modelId, cwd: "/fixture" });
        if (url.pathname.endsWith("/events")) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          streams.add(res); req.on("close", () => streams.delete(res));
          res.write(`data: ${JSON.stringify({ type: "connected", sessionId: id, isStreaming: running })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "omp_snapshot", messages })}\n\n`); return;
        }
        if (!body) { json(view(id)); return; }
        if (body.type === "ensure_session") { model = { provider: body.provider, modelId: body.modelId }; json({ success: true, data: identity() }); return; }
        if (body.type === "set_model") { model = { provider: body.provider, modelId: body.modelId }; json({ success: true, data: { provider: model.provider, id: model.modelId } }); return; }
        if (body.type === "clear_queue") {
          const recalled = queuedMessages; queuedMessages = { steering: [], followUp: [] };
          emit({ type: "queue_update", ...queuedMessages }); json({ success: true, data: recalled }); return;
        }
        if (body.type === "prompt" && body.streamingBehavior) {
          queuedMessages[body.streamingBehavior === "steer" ? "steering" : "followUp"].push(body.message);
          emit({ type: "queue_update", ...queuedMessages }); json({ success: true, data: { ...identity(), queued: true } }); return;
        }
        if (body.type === "prompt") {
          running = true; const message = { role: "user", content: body.message, timestamp: Date.now(), nativeId: `u${messages.length}` }; messages.push(message);
          emit({ type: "agent_start" }); emit({ type: "message_end", message }); json({ success: true, data: identity() }); return;
        }
        if (body.type === "extension_ui_response" || body.type === "abort") {
          const message = { role: "assistant", content: [{ type: "text", text: "OMP fixture answer" }], timestamp: Date.now(), nativeId: `a${messages.length}` }; messages.push(message);
          emit({ type: "extension_ui_closed", id: body.id }); emit({ type: "message_end", message }); running = false;
          emit({ type: "agent_end" }); emit({ type: "agent_settled", aborted: body.type === "abort" }); json({ success: true }); return;
        }
      }
      json({});
    } catch (error) { res.writeHead(500).end(error.message); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const picker = page.locator(".model-selector.is-toolbar > button");
  await picker.filter({ hasText: "Shared first" }).waitFor();
  await page.getByRole("button", { name: "pi", exact: true }).click();
  await page.getByRole("option", { name: "omp", exact: true }).click();
  await picker.click();
  await page.getByRole("option").filter({ hasText: "Shared second" }).click();
  await picker.filter({ hasText: "Shared second" }).waitFor();
  assert.equal(calls.some(({ path }) => path.includes("/harnesses/omp/models")), false, "OMP must not load an independent model list");
  const composer = page.locator("textarea");
  const accepted = () => page.waitForResponse((response) => response.url().includes("/api/omp/") && response.request().method() === "POST" && response.request().postDataJSON()?.type === "prompt");
  const firstAccepted = accepted();
  await composer.fill("OMP browser first turn"); await composer.press("Enter");
  await firstAccepted;
  await page.getByTestId("status").filter({ hasText: "running" }).waitFor();
  await page.waitForFunction(() => document.querySelector(".model-selector > button")?.disabled === true);
  await composer.fill("OMP queued follow-up");
  await page.getByRole("button", { name: "Follow-up", exact: true }).click();
  await page.getByText(/^queued · 1$/i).waitFor();
  await composer.fill("OMP steer now");
  await page.getByRole("button", { name: "Steer", exact: true }).click();
  await page.getByText(/^queued · 2$/i).waitFor();
  await page.getByRole("button", { name: "Recall to input", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("textarea")?.value.includes("OMP queued follow-up") && document.querySelector("textarea")?.value.includes("OMP steer now"));
  await composer.fill("");
  emit({ type: "extension_ui_request", id: "ask", method: "select", title: "Pick a color", options: ["Blue", "Red"] });
  await page.getByTestId("ask").click();
  await page.getByTestId("status").filter({ hasText: "idle" }).waitFor();
  await page.getByTestId("messages").getByText("OMP fixture answer", { exact: true }).waitFor();
  await page.reload();
  await page.getByTestId("messages").getByText("OMP browser first turn", { exact: true }).waitFor();
  await picker.filter({ hasText: "Shared second" }).waitFor();
  const secondAccepted = accepted();
  await composer.fill("OMP browser second turn"); await composer.press("Enter");
  await secondAccepted;
  await page.getByTestId("status").filter({ hasText: "running" }).waitFor();
  await page.getByRole("button", { name: /Stop/ }).click();
  await page.getByTestId("status").filter({ hasText: "idle" }).waitFor();
  const queued = calls.filter(({ body }) => body?.streamingBehavior);
  assert.deepEqual(queued.map(({ body }) => body.streamingBehavior), ["followUp", "steer"]);
  const prompts = calls.filter(({ body }) => body?.type === "prompt" && !body.streamingBehavior);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].path, prompts[1].path, "reload and the second turn keep the exact native web identity");
  assert.equal(calls.some(({ path }) => path.startsWith("/api/agent/")), false, "OMP never creates or calls a Pi agent");
  assert.deepEqual(errors, []);
  console.log("PASS: real OMP composer/hook shares Pi models, locks controls, answers ask, reloads, sends two turns, steers, queues, recalls and stops without Pi agent calls");
} finally {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}

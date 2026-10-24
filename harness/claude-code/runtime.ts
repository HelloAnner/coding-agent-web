import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import type { AgentEventLike } from "../../lib/agent-event-wire";
import { readCatalogSession, upsertCatalogSession } from "../../lib/catalog-db";
import type { ExtensionUiRequest } from "../../lib/types";
import { ClaudeEventMapper } from "./events";
import { claudeProcessEnv, object, prepareClaudeProfile, resolveClaudeProfile, type ClaudeProfile } from "./index";
import { claudeTranscriptFile, CLAUDE_UUID } from "./transcript";

type Listener = (event: AgentEventLike) => void;
interface PendingInput { request: Record<string, unknown>; ui: ExtensionUiRequest }
interface ControlWaiter { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
const IDLE_MS = 10 * 60_000;

class ClaudeRun {
  readonly subscribers = new Set<Listener>();
  readonly inputs = new Map<string, PendingInput>();
  readonly controls = new Map<string, ControlWaiter>();
  readonly backgroundTasks = new Set<string>();
  child: ChildProcessWithoutNullStreams | null = null;
  mapper: ClaudeEventMapper | null = null;
  isStreaming = false;
  aborted = false;
  profile: ClaudeProfile | null = null;
  cwd = "";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private stderr = "";
  private secrets: string[] = [];
  private ready: Promise<void> | null = null;

  constructor(readonly id: string) {}
  get streamingMessage() { return this.mapper?.message ?? null; }
  isAlive(): boolean { return true; }
  onEvent(listener: Listener): () => void {
    this.subscribers.add(listener);
    for (const id of this.mapper?.runningTools ?? []) listener({ type: "tool_execution_start", toolCallId: id, toolName: this.mapper?.toolNames.get(id) });
    for (const pending of this.inputs.values()) listener(pending.ui);
    return () => {
      this.subscribers.delete(listener);
      if (!this.child && !this.isStreaming && !this.subscribers.size && registry().runs.get(this.id) === this) registry().runs.delete(this.id);
    };
  }
  publish(event: AgentEventLike): void {
    for (const listener of this.subscribers) { try { listener(event); } catch { /* a broken browser must not stop the CLI */ } }
  }
  write(value: unknown): void {
    if (!this.child?.stdin.writable) throw new Error("Claude Code is not connected");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  request(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.controls.delete(id); reject(new Error("Claude Code control request timed out")); }, 30_000);
      this.controls.set(id, { resolve, reject, timer });
      try { this.write({ type: "control_request", request_id: id, request }); }
      catch (error) { clearTimeout(timer); this.controls.delete(id); reject(error); }
    });
  }
  private redact(text: string): string {
    for (const value of this.secrets) text = text.replaceAll(value, "[redacted]");
    return text;
  }
  async start(profile: ClaudeProfile, cwd: string, resume: boolean): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.child) {
      if (JSON.stringify(this.profile) === JSON.stringify(profile) && this.child.stdin.writable) { await this.ready; return; }
      if (this.backgroundTasks.size) throw new Error("Wait for Claude Code background tasks before applying profile changes");
      const old = this.child;
      this.child = null;
      this.ready = null;
      for (const pending of this.controls.values()) { clearTimeout(pending.timer); pending.reject(new Error("Claude Code was restarted")); }
      this.controls.clear();
      old.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => old.kill("SIGTERM"), 2000);
        const kill = setTimeout(() => old.kill("SIGKILL"), 5000);
        old.once("close", () => { clearTimeout(timer); clearTimeout(kill); resolve(); });
      });
    }
    if (this.aborted) throw new Error("Claude Code was stopped before sending this message");
    prepareClaudeProfile(profile);
    this.profile = profile;
    this.cwd = cwd;
    this.stderr = "";
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--forward-subagent-text", "--permission-prompt-tool", "stdio", "--permission-mode", profile.permissionMode,
      ...(profile.permissionMode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : []),
      ...(profile.model ? ["--model", profile.model] : []), ...(profile.effort ? ["--effort", profile.effort] : []),
      ...(resume ? ["--resume", this.id] : ["--session-id", this.id])];
    const env = claudeProcessEnv(profile);
    this.secrets = Object.entries(env).filter(([key, value]) => /TOKEN|KEY|HEADERS/.test(key) && value && value.length > 7).map(([, value]) => value!);
    const child = spawn(process.env.PI_WEB_CLAUDE_BIN?.trim() || "claude", args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (this.child !== child || !line.trim()) return;
      let record: Record<string, unknown>;
      try { record = object(JSON.parse(line)); }
      catch { this.settle("Claude Code emitted invalid stream-json"); this.close(); return; }
      this.receive(record);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    const closed = (reason: string) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      for (const pending of this.controls.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)); }
      this.controls.clear();
      if (this.isStreaming) this.settle(this.aborted ? undefined : this.redact(this.stderr.trim().split("\n").at(-1) || reason));
      this.backgroundTasks.clear();
      if (!this.subscribers.size && registry().runs.get(this.id) === this) registry().runs.delete(this.id);
    };
    child.on("error", (error) => closed(`Claude Code could not start: ${error.message}`));
    child.on("close", (code) => closed(`Claude Code exited before completing the turn (${code})`));
    child.stdin.on("error", () => { /* child error/close settles the run and its control waiters */ });
    this.ready = this.request({ subtype: "initialize" }).then(() => undefined);
    try { await this.ready; }
    catch (error) { if (this.child === child) this.close(); throw error; }
  }
  private receive(record: Record<string, unknown>): void {
    if (record.type === "control_response") {
      const response = object(record.response);
      const id = String(response.request_id ?? "");
      const pending = this.controls.get(id);
      if (pending) {
        clearTimeout(pending.timer); this.controls.delete(id);
        if (response.subtype === "error") pending.reject(new Error(this.redact(String(response.error ?? "Claude Code control request failed"))));
        else pending.resolve(object(response.response));
      }
      return;
    }
    if (record.type === "control_request") { this.input(record); return; }
    if (record.type === "control_cancel_request") { this.removeInput(String(record.request_id)); return; }
    if (record.type === "system" && record.subtype === "task_started" && typeof record.task_id === "string") this.backgroundTasks.add(record.task_id);
    if (record.type === "system" && record.subtype === "task_notification" && typeof record.task_id === "string") this.backgroundTasks.delete(record.task_id);
    if (record.type === "system" && record.subtype === "init") {
      this.publish({ type: "extension_ui_request", id: "claude-model", method: "setStatus", statusKey: "claude-model", statusText: typeof record.model === "string" ? record.model : undefined });
      for (const key of ["plugin_errors", "mcp_server_errors"]) if (Array.isArray(record[key]) && record[key].length) this.publish({ type: "prompt_error", errorMessage: `Claude Code reported ${record[key].length} ${key.replaceAll("_", " ")}` });
      return;
    }
    if (record.type === "result") {
      const errors = Array.isArray(record.errors) ? record.errors.filter((item) => typeof item === "string").join("\n") : "";
      this.settle(!this.aborted && (record.is_error || record.subtype !== "success") ? this.redact(errors || String(record.result ?? record.subtype ?? "Claude Code failed")) : undefined);
      const denials = Array.isArray(record.permission_denials) ? record.permission_denials.length : 0;
      if (denials && !this.aborted) this.publish({ type: "extension_ui_request", id: randomUUID(), method: "notify", notifyType: "warning", message: `Claude Code denied ${denials} tool request(s)` });
      return;
    }
    if (!this.isStreaming && !record.parent_tool_use_id && record.type === "stream_event" && object(record.event).type === "message_start") {
      this.isStreaming = true;
      this.aborted = false;
      this.mapper = new ClaudeEventMapper((event) => this.publish(event));
      this.publish({ type: "agent_start" });
    }
    this.mapper?.push(record);
  }
  private input(record: Record<string, unknown>): void {
    const id = String(record.request_id ?? "");
    const request = object(record.request);
    const input = object(request.input);
    let ui: ExtensionUiRequest;
    if (request.subtype === "can_use_tool" && request.tool_name === "AskUserQuestion" && Array.isArray(input.questions)) {
      const questions = input.questions.map((raw) => {
        const question = object(raw);
        return { question: String(question.question ?? ""), header: String(question.header ?? ""), multiSelect: question.multiSelect === true,
          options: Array.isArray(question.options) ? question.options.map((rawOption) => { const option = object(rawOption); return { label: String(option.label ?? ""), description: String(option.description ?? "") }; }) : [] };
      });
      ui = { type: "extension_ui_request", id, method: "editor", title: "Claude Code", questions, prefill: "{}" };
    } else if (request.subtype === "can_use_tool") {
      ui = { type: "extension_ui_request", id, method: "confirm", title: `Claude Code · ${String(request.tool_name ?? "Tool")}`, message: this.redact(`${String(request.decision_reason ?? request.description ?? "")}\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``) };
    } else if (request.subtype === "elicitation") {
      ui = { type: "extension_ui_request", id, method: "editor", title: `${String(request.message ?? "MCP input")}\n${JSON.stringify(request.requested_schema ?? {})}`, prefill: "{}" };
    } else {
      this.write({ type: "control_response", response: { subtype: "error", request_id: id, error: "Unsupported Claude Code control request" } });
      return;
    }
    this.inputs.set(id, { request, ui });
    this.publish(ui);
  }
  private removeInput(id: string): void {
    if (!this.inputs.delete(id)) return;
    this.publish({ type: "extension_ui_closed", id });
  }
  respond(id: string, response: { confirmed?: unknown; value?: unknown; cancelled?: unknown }): void {
    const pending = this.inputs.get(id);
    if (!pending) throw new Error("This Claude Code request is no longer pending");
    const request = pending.request;
    let answer: Record<string, unknown>;
    if (request.subtype === "elicitation") {
      let content: unknown;
      if (response.cancelled !== true) { try { content = JSON.parse(String(response.value)); } catch { throw new Error("Expected a JSON object"); } }
      if (response.cancelled !== true && (content === null || typeof content !== "object" || Array.isArray(content))) throw new Error("Expected a JSON object");
      answer = response.cancelled === true ? { action: "cancel" } : { action: "accept", content };
    } else if (response.cancelled === true || (pending.ui.method === "confirm" && response.confirmed !== true)) {
      answer = { behavior: "deny", message: "The user declined this request" };
    } else {
      const input = object(request.input);
      if (request.tool_name === "AskUserQuestion") {
        let raw: unknown;
        try { raw = JSON.parse(String(response.value)); } catch { throw new Error("Expected answers to Claude Code questions"); }
        const answers = object(raw);
        if (!Array.isArray(input.questions) || input.questions.some((question) => typeof answers[String(object(question).question)] !== "string" || !String(answers[String(object(question).question)]).trim())) throw new Error("Answer every question before submitting");
        answer = { behavior: "allow", updatedInput: { ...input, answers } };
      } else answer = { behavior: "allow", updatedInput: input };
    }
    this.write({ type: "control_response", response: { subtype: "success", request_id: id, response: answer } });
    this.removeInput(id);
  }
  settle(error?: string): void {
    if (!this.isStreaming) return;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.mapper?.finish(this.aborted);
    this.isStreaming = false;
    for (const id of [...this.inputs.keys()]) this.removeInput(id);
    if (error) this.publish({ type: "prompt_error", errorMessage: error });
    this.publish({ type: "agent_end" });
    this.publish({ type: "agent_settled", aborted: this.aborted });
    this.scheduleIdle();
  }
  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.isStreaming) return;
      if (this.backgroundTasks.size) this.scheduleIdle();
      else this.close();
    }, IDLE_MS);
    this.idleTimer.unref();
  }
  abort(): boolean {
    if (!this.isStreaming && !this.backgroundTasks.size) return false;
    this.aborted = true;
    if (!this.child) return true;
    // The native host interrupt ends the current turn without discarding its session.
    const child = this.child;
    const turn = this.mapper;
    const stillStopping = () => this.child === child && this.mapper === turn && (this.isStreaming || this.backgroundTasks.size > 0);
    void this.request({ subtype: "interrupt" }).catch(() => { if (stillStopping()) child.kill("SIGINT"); });
    this.stopTimer = setTimeout(() => { if (stillStopping()) child.kill("SIGINT"); }, 3000);
    this.stopTimer.unref();
    setTimeout(() => { if (stillStopping()) this.close(); }, 8000).unref();
    return true;
  }
  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.stopTimer) clearTimeout(this.stopTimer);
    const child = this.child;
    if (!child) return;
    if (this.isStreaming) { this.aborted = true; child.kill("SIGINT"); }
    child.stdin.end();
    setTimeout(() => { if (this.child === child) child.kill("SIGTERM"); }, 2000).unref();
    setTimeout(() => { if (this.child === child) child.kill("SIGKILL"); }, 5000).unref();
  }
}

const KEY = Symbol.for("coding-agent-web.claudeCodeRuns");
interface ClaudeRegistry { runs: Map<string, ClaudeRun>; shutdownRegistered: boolean }
function registry(): ClaudeRegistry {
  const holder = globalThis as Record<symbol, ClaudeRegistry | undefined>;
  const state = holder[KEY] ??= { runs: new Map(), shutdownRegistered: false };
  if (!state.shutdownRegistered) {
    state.shutdownRegistered = true;
    const shutdown = () => { for (const run of state.runs.values()) run.close(); };
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown); process.once("exit", () => { for (const run of state.runs.values()) run.child?.kill("SIGTERM"); });
  }
  return state;
}
export function getClaudeRun(id: string): ClaudeRun {
  if (!CLAUDE_UUID.test(id)) throw new Error("Invalid Claude Code session id");
  const runs = registry().runs;
  if (!runs.has(id)) runs.set(id, new ClaudeRun(id));
  return runs.get(id)!;
}
export function claudeRunningIds(): string[] { return [...registry().runs.values()].filter((run) => run.isStreaming || run.backgroundTasks.size).map((run) => run.id); }
export function claudeAwaitingInputIds(): string[] { return [...registry().runs.values()].filter((run) => run.inputs.size).map((run) => run.id); }
export function claudeState(id: string) {
  const run = registry().runs.get(id);
  return { running: Boolean(run?.isStreaming || run?.backgroundTasks.size), state: { isStreaming: Boolean(run?.isStreaming || run?.backgroundTasks.size), isPromptRunning: false } };
}
export function stopClaudeRuns(): void { for (const run of registry().runs.values()) run.close(); }

export async function sendClaudePrompt(prompt: { id: string; cwd: string; profileId?: string; provider?: string; promptId?: string; text: string; images?: Array<{ data: string; mimeType: string }> }): Promise<{ sessionPath: string; provider: string; model: string }> {
  const run = getClaudeRun(prompt.id);
  if (!prompt.text.trim() && !prompt.images?.length) throw new Error("Message is empty");
  if (run.isStreaming) throw new Error("Claude Code is already answering in this session");
  if (/^\/model(?:\s|$)/i.test(prompt.text.trimStart())) throw new Error("Claude Code model is fixed by its profile. Start a new chat to switch models.");
  const profile = resolveClaudeProfile(prompt.profileId, prompt.provider);
  const cwd = realpathSync(prompt.cwd);
  const existing = readCatalogSession(prompt.id);
  if (existing && (existing.harness !== "claude-code" || existing.model !== profile.id || existing.provider !== profile.provider || realpathSync(existing.cwd) !== cwd || existing.sessionPath !== profile.configDir)) throw new Error("This Claude Code session keeps its original profile and directory. Start a new chat to switch models.");
  if (existing && !claudeTranscriptFile(profile.configDir, prompt.id) && !run.child) throw new Error("Claude Code session history is missing. Start a new chat instead of resetting this conversation.");
  if (run.child && (run.cwd !== cwd || run.profile?.id !== profile.id)) throw new Error("Claude Code session profile mismatch");
  run.isStreaming = true; run.aborted = false;
  const turn = new ClaudeEventMapper((event) => run.publish(event));
  run.mapper = turn;
  run.publish({ type: "agent_start" });
  try {
    await run.start(profile, cwd, Boolean(existing));
    if (run.aborted || run.mapper !== turn) throw new Error("Claude Code was stopped before sending this message");
    upsertCatalogSession({ id: prompt.id, cwd, harness: "claude-code", provider: profile.provider, model: profile.id, title: existing?.title || prompt.text.trim().slice(0, 100) || profile.name, sessionPath: profile.configDir });
    run.write({ type: "user", uuid: prompt.promptId ?? randomUUID(), session_id: prompt.id, parent_tool_use_id: null, message: { role: "user", content: [
      ...(prompt.text.trim() ? [{ type: "text", text: prompt.text }] : []),
      ...(prompt.images ?? []).map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } })),
    ] } });
    return { sessionPath: profile.configDir, provider: profile.provider, model: profile.id };
  } catch (error) {
    if (run.mapper === turn) run.settle();
    throw error;
  }
}

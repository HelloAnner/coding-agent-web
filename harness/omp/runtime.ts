import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentEventLike } from "../../lib/agent-event-wire";
import { readCatalogSession, upsertCatalogSession, updateCatalogSession } from "../../lib/catalog-db";
import type { ExtensionUiRequest } from "../../lib/types";
import { ompAgentDir, ompConfigIdentity, ompProcessEnv, ompSessionsRoot, OMP_ID } from "./index";
import { OmpEvents, ompUiRequest } from "./events";
import { OmpModelBridge } from "./model-bridge";
import { readProjectModels, selectedOmpModel, type ProjectModels } from "./models";
import { object, OmpError, OmpRpc, type Frame } from "./rpc";
import { readOmpTranscript, type OmpMessage } from "./transcript";

export interface OmpPrompt {
  id: string; cwd: string; provider?: string; modelId?: string; thinkingLevel?: string;
  message?: string; images?: Array<{ data: string; mimeType: string }>; requestId?: string;
  streamingBehavior?: "steer" | "followUp";
}
const IDLE_MS = 10 * 60_000;
let checkedBinary: { binary: string; check: Promise<void> } | null = null;
async function checkBinary(binary: string): Promise<void> {
  if (checkedBinary?.binary === binary) return checkedBinary.check;
  const check = promisify(execFile)(binary, ["--version"], { timeout: 10_000, maxBuffer: 4096 }).then(({ stdout }) => {
    if (stdout.trim() !== "omp/18.3.0") throw new OmpError("This adapter requires omp 18.3.0; other lifecycle dialects have not been validated", 503);
  }).catch((error) => {
    checkedBinary = null;
    if (error instanceof OmpError) throw error;
    throw new OmpError("omp is not available. Install omp 18.3.0 or set PI_WEB_OMP_BIN", 503);
  });
  checkedBinary = { binary, check };
  return check;
}

export class OmpRun {
  readonly subscribers = new Set<(event: AgentEventLike) => void>();
  readonly inputs = new Map<string, ExtensionUiRequest>();
  rpc: OmpRpc | null = null;
  private bridge: OmpModelBridge | null = null;
  private mapper: OmpEvents | null = null;
  private active = false;
  private starting = false;
  private promptStarting = false;
  private stopping = false;
  private steered = false;
  // ponytail: pending prompts survive browser reconnects, not a web server restart.
  private readonly queued: { steering: OmpPrompt[]; followUp: OmpPrompt[] } = { steering: [], followUp: [] };
  private generation = 0;
  private promptId: string | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private source: ProjectModels | null = null;
  private nativeState: Frame = {};
  private nativeId = "";
  private file = "";
  private cwd = "";
  private messages: OmpMessage[] = [];
  private readonly accepted = new Set<string>();
  constructor(readonly id: string) {}
  get isBusy(): boolean { return this.starting || this.active || this.inputs.size > 0; }
  get isStreaming(): boolean { return this.active || this.starting && this.promptStarting || this.inputs.size > 0; }
  get streamingMessage() { return this.mapper?.streamingMessage ?? null; }
  isAlive(): boolean { return true; }
  onEvent(listener: (event: AgentEventLike) => void): () => void {
    this.subscribers.add(listener);
    listener({ type: "omp_snapshot", messages: this.messages });
    for (const tool of this.mapper?.tools.values() ?? []) listener(tool);
    for (const request of this.inputs.values()) listener(request);
    listener({ type: "queue_update", ...this.queuedMessages() });
    return () => { this.subscribers.delete(listener); this.release(); };
  }
  private publish(event: AgentEventLike): void {
    for (const listener of [...this.subscribers]) { try { listener(event); } catch { /* a disconnected tab must not stop OMP */ } }
  }
  async refreshState(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc?.alive || this.starting) return;
    const state = await rpc.request({ type: "get_state" }).catch(() => null);
    if (state && this.rpc === rpc && !this.starting) this.nativeState = state;
  }
  state() {
    const model = object(this.nativeState.model);
    return { running: this.isBusy, state: {
      isStreaming: this.isStreaming, isPromptRunning: false, isCompacting: this.nativeState.isCompacting === true,
      model: typeof model.provider === "string" && typeof model.id === "string" ? { provider: model.provider, id: model.id } : undefined,
      thinkingLevel: this.nativeState.thinkingLevel,
      contextUsage: this.nativeState.contextUsage,
      queuedMessages: this.queuedMessages(),
    } };
  }
  view() {
    const row = this.row();
    const transcript = readOmpTranscript(this.id, row.sessionPath);
    if (this.nativeId && transcript.header.id !== this.nativeId) throw new OmpError("OMP native session identity changed", 409);
    if (realpathSync(String(transcript.header.cwd)) !== realpathSync(row.cwd)) throw new OmpError("OMP history belongs to a different project", 409);
    if (!this.active) this.messages = transcript.messages;
    const model = object(this.nativeState.model);
    return { sessionId: this.id, filePath: transcript.path, tree: [], leafId: null, totalActiveMs: 0, stats: transcript.stats,
      context: { messages: this.active ? this.messages : transcript.messages,
        entryIds: (this.active ? this.messages : transcript.messages).map((message) => message.nativeId),
        oldestEntryId: null, hasMore: false, turnsBefore: 0,
        thinkingLevel: typeof this.nativeState.thinkingLevel === "string" ? this.nativeState.thinkingLevel : transcript.thinkingLevel,
        model: typeof model.provider === "string" && typeof model.id === "string" ? { provider: model.provider, modelId: model.id } : transcript.model ?? { provider: row.provider, modelId: row.model },
      }, ...this.state() };
  }
  private row() {
    const row = readCatalogSession(this.id);
    if (!row || row.harness !== "omp") throw new OmpError("OMP session not found", 404);
    if (row.profilePath !== ompConfigIdentity()) throw new OmpError("This OMP session keeps its original configuration directory", 409);
    return row;
  }
  private lock(prompt = false): number {
    if (this.isBusy) throw new OmpError("OMP is already working in this conversation", 409);
    this.starting = true; this.promptStarting = prompt; this.stopping = false; this.steered = false;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    return ++this.generation;
  }
  private async open(input: OmpPrompt): Promise<void> {
    const cwd = realpathSync(input.cwd);
    const row = readCatalogSession(this.id);
    if (row && (row.harness !== "omp" || realpathSync(row.cwd) !== cwd || row.profilePath !== ompConfigIdentity())) throw new OmpError("This OMP session keeps its harness, project and configuration directory", 409);
    const transcript = row ? readOmpTranscript(this.id, row.sessionPath) : null;
    if (transcript && realpathSync(String(transcript.header.cwd)) !== cwd) throw new OmpError("OMP history belongs to another project", 409);
    const source = await readProjectModels(cwd);
    const model = selectedOmpModel(source, input.provider ?? row?.provider, input.modelId ?? row?.model);
    if (input.images?.length && !model.input.includes("image")) throw new OmpError("This Pi model does not support image input");
    if (row && (input.provider && input.provider !== row.provider || input.modelId && input.modelId !== row.model)) throw new OmpError("Use the model selector to change an existing OMP model", 409);
    if (this.stopping) throw new OmpError("OMP was stopped before sending");
    this.source = source;
    if (this.rpc?.alive) {
      await this.bridge!.configure(source);
      return;
    }
    const binary = process.env.PI_WEB_OMP_BIN?.trim() || "omp";
    await checkBinary(binary);
    if (this.stopping) throw new OmpError("OMP was stopped before starting");
    const piRoot = (await import("@earendil-works/pi-coding-agent")).getAgentDir();
    if (ompConfigIdentity() === (existsSync(piRoot) ? realpathSync(piRoot) : path.resolve(piRoot))) throw new OmpError("OMP and Pi must use different session/configuration directories");
    mkdirSync(ompAgentDir(), { recursive: true, mode: 0o700 });
    const sessionDir = path.join(ompSessionsRoot(), this.id);
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    if (!statSync(sessionDir).isDirectory()) throw new OmpError("Invalid OMP session directory");
    const selector = `${model.provider}/${model.id}`;
    const rpc = new OmpRpc(binary, ["--mode", "rpc-ui", "--no-pty", "--no-title", "--approval-mode", "always-ask",
      "--session-dir", sessionDir, "-e", path.join(process.cwd(), "harness", "omp", "model-extension.mjs"),
      ...(row ? ["--resume", row.sessionPath] : ["--model", selector]),
      "--smol", selector, "--slow", selector, "--plan", selector,
    ], cwd, ompProcessEnv());
    this.rpc = rpc;
    this.cwd = cwd;
    this.mapper = new OmpEvents(`${this.id}:${randomUUID()}`, (event) => this.publish(event), (message) => this.messages.push(message));
    this.messages = transcript?.messages ?? [];
    rpc.listeners.add((frame) => { if (this.rpc === rpc) this.receive(frame); });
    rpc.exits.add((error) => {
      if (this.rpc !== rpc) return;
      this.rpc = null; this.bridge?.close(); this.bridge = null;
      for (const id of this.inputs.keys()) this.publish({ type: "extension_ui_closed", id });
      this.inputs.clear();
      this.settle(this.stopping && !this.steered ? undefined : error instanceof OmpError ? error.message : "OMP connection failed. Check native session and Pi model settings.");
      this.release();
    });
    this.bridge = new OmpModelBridge(rpc, source);
    try {
      await Promise.all([rpc.start(), this.bridge.configure()]);
      if (this.stopping) throw new OmpError("OMP was stopped before sending");
      if (!row) {
        const created = await rpc.request({ type: "new_session" });
        if (created.cancelled !== false) throw new OmpError("OMP cancelled session creation");
      }
      this.nativeState = await rpc.request({ type: "get_state" });
      const nativeId = this.nativeState.sessionId;
      const file = this.nativeState.sessionFile;
      if (typeof nativeId !== "string" || typeof file !== "string") throw new OmpError("OMP did not provide a persistent native session", 503);
      const saved = readOmpTranscript(this.id, file);
      if (saved.header.id !== nativeId || realpathSync(String(saved.header.cwd)) !== cwd || row && (saved.header.id !== transcript!.header.id || saved.path !== transcript!.path)) throw new OmpError("OMP did not resume the expected native conversation", 409);
      this.nativeId = nativeId; this.file = saved.path;
      const selected = await rpc.request({ type: "set_model", provider: model.provider, modelId: model.id });
      if (selected.provider !== model.provider || selected.id !== model.id) throw new OmpError("OMP selected a different model", 409);
      const level = input.thinkingLevel ?? (row ? transcript?.thinkingLevel : undefined) ?? source.scope.thinkingLevelPins[selector] ?? source.settings.getModelThinkingLevel(model.provider, model.id) ?? source.settings.getDefaultThinkingLevel();
      if (level) await rpc.request({ type: "set_thinking_level", level });
      this.nativeState = await rpc.request({ type: "get_state" });
      const actualModel = object(this.nativeState.model);
      if (actualModel.provider !== model.provider || actualModel.id !== model.id) throw new OmpError("OMP did not confirm the selected Pi model", 409);
      if (!row) upsertCatalogSession({ id: this.id, harness: "omp", cwd, provider: model.provider, model: model.id,
        sessionPath: this.file, profilePath: ompConfigIdentity(), title: input.message?.trim().split("\n")[0].slice(0, 100) || "OMP" });
    } catch (error) { rpc.close(); throw error; }
  }
  async ensure(input: OmpPrompt) {
    this.lock();
    try { await this.open(input); return this.identity(); }
    finally { this.starting = false; this.scheduleIdle(); this.release(); }
  }
  private identity() {
    const row = this.row();
    return { sessionId: this.id, sessionPath: row.sessionPath, provider: row.provider, model: row.model, cwd: row.cwd };
  }
  async prompt(input: OmpPrompt) {
    if (input.requestId && this.accepted.has(input.requestId)) return { ...this.identity(), accepted: true };
    if (!input.message?.trim() && !input.images?.length) throw new OmpError("Message is empty");
    if (input.message?.trimStart().startsWith("/")) throw new OmpError("OMP slash commands are not exposed by this web adapter; use the model and session controls");
    if (input.streamingBehavior && this.isBusy) {
      if (!this.active || this.stopping && !this.steered) throw new OmpError("OMP is preparing or stopping; wait before queueing another prompt", 409);
      (input.streamingBehavior === "steer" ? this.queued.steering : this.queued.followUp).push(input);
      this.rememberRequest(input);
      this.publish({ type: "queue_update", ...this.queuedMessages() });
      if (input.streamingBehavior === "steer") this.interrupt(true);
      return { ...this.identity(), accepted: true, queued: true };
    }
    return this.startPrompt(input);
  }
  private rememberRequest(input: OmpPrompt): void {
    if (!input.requestId) return;
    this.accepted.add(input.requestId);
    if (this.accepted.size > 128) this.accepted.delete(this.accepted.values().next().value!);
  }
  queuedMessages(): { steering: string[]; followUp: string[] } {
    return { steering: this.queued.steering.map((input) => input.message ?? ""), followUp: this.queued.followUp.map((input) => input.message ?? "") };
  }
  clearQueue() {
    const cleared = this.queuedMessages();
    const images = [...this.queued.steering, ...this.queued.followUp].flatMap((input) => input.images ?? []);
    this.queued.steering.length = this.queued.followUp.length = 0;
    this.publish({ type: "queue_update", ...this.queuedMessages() });
    return { ...cleared, ...(images.length ? { images } : {}) };
  }
  private async startPrompt(input: OmpPrompt) {
    const generation = this.lock(true);
    try {
      await this.open(input);
      if (this.stopping || generation !== this.generation) throw new OmpError("OMP was stopped before sending");
      this.starting = false; this.active = true;
      this.promptId = randomUUID();
      await this.rpc!.request({ type: "prompt", message: input.message ?? "", images: input.images?.map((image) => ({ type: "image", ...image })) }, this.promptId);
      this.rememberRequest(input);
      return { ...this.identity(), accepted: true };
    } catch (error) { if (generation === this.generation) { this.starting = false; this.settle(this.stopping ? undefined : error instanceof OmpError ? error.message : "OMP prompt failed. Check native session and Pi model settings."); } throw error; }
  }
  private receive(frame: Frame): void {
    if (frame.type === "extension_ui_request") {
      if (frame.method === "cancel" && typeof frame.targetId === "string") { this.inputs.delete(frame.targetId); this.publish({ type: "extension_ui_closed", id: frame.targetId }); return; }
      const request = ompUiRequest(frame);
      if (!request) {
        if (typeof frame.id === "string") this.rpc?.write({ type: "extension_ui_response", id: frame.id, cancelled: true });
        return;
      }
      if (["select", "confirm", "input", "editor"].includes(request.method)) this.inputs.set(request.id, request);
      this.publish(request); return;
    }
    if (frame.type === "response" && frame.id === this.promptId) {
      if (frame.success !== true) this.settle("OMP rejected the prompt. Check Pi model settings and native session configuration.");
      else if (object(frame.data).agentInvoked === false) this.settle();
      return;
    }
    if (frame.type === "prompt_result" && frame.id === this.promptId && frame.agentInvoked === false) { this.settle(); return; }
    if (frame.type === "agent_start") this.active = true;
    if (frame.type === "agent_end") {
      if (frame.isTerminal !== false) this.settle();
      return;
    }
    this.mapper?.push(frame);
  }
  private settle(error?: string): void {
    const active = this.active || this.promptStarting;
    const aborted = this.stopping && !this.steered;
    this.active = false; this.promptStarting = false; this.promptId = null;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.mapper?.finish();
    if (active && !aborted && !error && this.rpc?.alive) {
      const next = this.queued.steering.shift() ?? this.queued.followUp.shift();
      if (next) {
        this.publish({ type: "queue_update", ...this.queuedMessages() });
        void this.startPrompt(next).catch(() => {
          // Preparation failed before delivery: retain the accepted prompt for Recall.
          if (this.stopping && !this.steered) return;
          (next.streamingBehavior === "steer" ? this.queued.steering : this.queued.followUp).unshift(next);
          this.publish({ type: "queue_update", ...this.queuedMessages() });
        });
        return;
      }
    }
    if (active) {
      if (error) this.publish({ type: "prompt_error", errorMessage: error });
      this.publish({ type: "agent_end" });
      this.publish({ type: "agent_settled", aborted });
    }
    this.scheduleIdle();
  }
  private scheduleIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (!this.isBusy && !this.queued.steering.length && !this.queued.followUp.length) this.close(); else this.scheduleIdle(); }, IDLE_MS);
    this.idle.unref();
  }
  abort(): boolean {
    const cleared = this.clearQueue();
    const stopped = this.interrupt(false);
    return stopped || cleared.steering.length + cleared.followUp.length > 0;
  }
  private interrupt(steer: boolean): boolean {
    if (!this.isBusy) return false;
    const alreadyStopping = this.stopping;
    this.stopping = true; this.steered = steer;
    if (alreadyStopping) return true;
    const rpc = this.rpc;
    const generation = this.generation;
    const stillStopping = () => this.rpc === rpc && this.generation === generation && this.stopping;
    if (rpc) {
      for (const id of this.inputs.keys()) {
        this.publish({ type: "extension_ui_closed", id });
        try { rpc.write({ type: "extension_ui_response", id, cancelled: true }); } catch { rpc.close(); break; }
      }
      this.inputs.clear();
      void rpc.request({ type: "abort" }).catch(() => { if (stillStopping()) rpc.close(); });
      this.stopTimer = setTimeout(() => { if (stillStopping()) rpc.close(); }, 3000);
      this.stopTimer.unref();
    }
    return true;
  }
  respond(id: string, response: Frame): void {
    const pending = this.inputs.get(id);
    if (!pending || !this.rpc?.alive) throw new OmpError("This OMP request is no longer pending", 409);
    if ("expiresAt" in pending && typeof pending.expiresAt === "number" && pending.expiresAt <= Date.now()) throw new OmpError("This OMP request has expired", 409);
    let result: Frame;
    if (response.cancelled === true) result = { cancelled: true };
    else if (pending.method === "confirm" && typeof response.confirmed === "boolean") result = { confirmed: response.confirmed };
    else if ((pending.method === "select" || pending.method === "input" || pending.method === "editor") && typeof response.value === "string" && response.value.length <= 1024 * 1024) {
      if (pending.method === "select" && !pending.options.includes(response.value)) throw new OmpError("Invalid OMP option");
      result = { value: response.value };
    } else throw new OmpError("Invalid OMP UI response");
    this.rpc.write({ type: "extension_ui_response", id, ...result });
    this.inputs.delete(id); this.publish({ type: "extension_ui_closed", id });
  }
  async setModel(provider: string, modelId: string) {
    this.lock();
    try {
      const row = this.row();
      await this.open({ id: this.id, cwd: row.cwd });
      selectedOmpModel(this.source!, provider, modelId);
      const previous = object(this.nativeState.model);
      const thinking = previous.provider === provider && previous.id === modelId ? this.nativeState.thinkingLevel
        : this.source!.settings.getModelThinkingLevel(provider, modelId) ?? this.source!.settings.getDefaultThinkingLevel() ?? this.nativeState.thinkingLevel;
      const selected = await this.rpc!.request({ type: "set_model", provider, modelId });
      if (typeof thinking === "string") await this.rpc!.request({ type: "set_thinking_level", level: thinking });
      this.nativeState = await this.rpc!.request({ type: "get_state" });
      const actual = object(this.nativeState.model);
      if (selected.provider !== provider || selected.id !== modelId || actual.provider !== provider || actual.id !== modelId) throw new OmpError("OMP selected a different model", 409);
      updateCatalogSession(this.id, { provider, model: modelId });
      return { provider, id: modelId };
    } catch (error) { this.close(); throw error; }
    finally { this.starting = false; this.scheduleIdle(); }
  }
  async setThinking(level: string) {
    this.lock();
    try {
      const row = this.row(); await this.open({ id: this.id, cwd: row.cwd });
      const levels = await this.rpc!.request({ type: "get_available_thinking_levels" });
      if (!Array.isArray(levels.levels) || !levels.levels.includes(level)) throw new OmpError("This thinking level is unavailable for the selected model");
      await this.rpc!.request({ type: "set_thinking_level", level });
      this.nativeState = await this.rpc!.request({ type: "get_state" });
      return { level: this.nativeState.thinkingLevel };
    } catch (error) { this.close(); throw error; }
    finally { this.starting = false; this.scheduleIdle(); }
  }
  private release(): void {
    if (this.rpc || this.isBusy || this.subscribers.size || this.queued.steering.length || this.queued.followUp.length) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (registry().runs.get(this.id) === this) registry().runs.delete(this.id);
  }
  close(): void {
    if (this.isBusy) { this.stopping = true; this.steered = false; }
    this.clearQueue();
    if (this.idle) clearTimeout(this.idle);
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.idle = this.stopTimer = null;
    this.bridge?.close();
    this.rpc?.close();
  }
}
const KEY = Symbol.for("coding-agent-web.omp-runs");
interface Registry { runs: Map<string, OmpRun>; shutdown: boolean }
function registry(): Registry {
  const holder = globalThis as Record<symbol, Registry | undefined>;
  const state = holder[KEY] ??= { runs: new Map(), shutdown: false };
  if (!state.shutdown) {
    state.shutdown = true;
    process.once("SIGINT", stopOmpRuns); process.once("SIGTERM", stopOmpRuns);
    process.once("exit", () => { for (const run of state.runs.values()) run.rpc?.child.kill("SIGTERM"); });
  }
  return state;
}
export function getOmpRun(id: string): OmpRun {
  if (!OMP_ID.test(id)) throw new OmpError("Invalid OMP session id");
  const runs = registry().runs;
  if (!runs.has(id)) runs.set(id, new OmpRun(id));
  return runs.get(id)!;
}
export function findOmpRun(id: string): OmpRun | undefined { return registry().runs.get(id); }
export function ompRunningIds(): string[] { return [...registry().runs.values()].filter((run) => run.isBusy).map((run) => run.id); }
export function ompAwaitingInputIds(): string[] { return [...registry().runs.values()].filter((run) => run.inputs.size).map((run) => run.id); }
export function stopOmpRuns(): void { for (const run of registry().runs.values()) run.close(); }

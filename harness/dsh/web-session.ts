import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import type { AgentEventLike } from "../../lib/agent-event-wire";
import type { AgentMessage, AssistantMessage, ImageContent } from "../../lib/types";
import { readCatalogSession, updateCatalogSession } from "../../lib/catalog-db";
import type { HarnessModelList } from "../types";
import { dshWebHost, type DshStream } from "./web-host";
import { dshAdmission } from "./web-view";
import { nativeMessage, nativeSurface, nativeText, record, records, type NativeEvent, type NativeSnapshot } from "./web-projection";

export interface DshWebPrompt {
  sessionId: string; cwd: string; text: string; provider?: string | null; model?: string | null;
  sessionPath?: string | null; images?: { data: string; mimeType: string }[];
}
export type DshStreamingBehavior = "steer" | "followUp";
export interface DshInteraction { id: string; event: string; request: Record<string, unknown> }
const STATE = Symbol.for("coding-agent-web.dshWebSessions");
const EVENTS = Symbol.for("coding-agent-web.dshWebEvents");

function sessions(): Map<string, DshWebSession> {
  const shared = globalThis as Record<symbol, Map<string, DshWebSession> | undefined>;
  return shared[STATE] ??= new Map();
}
function nativeDirectory(id: string): string {
  const root = path.join(dshWebHost().home, "sessions");
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    if (readdirSync(path.join(root, project.name)).includes(id)) return path.join(root, project.name, id);
  }
  throw new Error("dsh did not persist the native session identity");
}
function legacyRuns(): Map<string, { isStreaming: boolean; queuedMessages(): { steering: string[]; followUp: string[] } }> | undefined {
  // Development hot reload may retain ACP turns from before this deployment. Observe, never drive them.
  return (globalThis as Record<symbol, ReturnType<typeof legacyRuns>>)[Symbol.for("pi-web.dshSessions")];
}

/** Only this bridge's registered sessions can be answered through the shared conversation UI. */
async function eventSource(): Promise<void> {
  const shared = globalThis as Record<symbol, Promise<void> | undefined>;
  if (shared[EVENTS]) return shared[EVENTS];
  const reset = () => { if (shared[EVENTS] === installed) shared[EVENTS] = undefined; };
  const attempt = (async () => {
    const stream = await dshWebHost().stream<Record<string, unknown>>("$events");
    const reader = stream.readable.getReader();
    const first = await reader.read();
    if (first.value?.type !== "ready" || typeof first.value.clientId !== "string") { await reader.cancel(); throw new Error("Invalid dsh event handshake"); }
    const clientId = first.value.clientId;
    void (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) throw new Error("dsh event connection ended");
          if (value.type === "cancel") {
            for (const run of sessions().values()) run.interactions.delete(String(value.eventId));
          } else if (value.type === "waterfall") {
            const run = [...sessions().values()].find((item) => item.nativeId === value.agentId);
            if (!run || run.hasNativeView() || (value.event !== "approval/request" && value.event !== "user-questions/request")) {
              await dshWebHost().call("$events/result", { clientId, eventId: value.eventId, outcome: { kind: "next" } });
            } else {
              const id = String(value.eventId);
              run.interactions.set(id, { id, clientId, event: String(value.event), request: record(value.request) });
            }
          } else if (value.type === "emit") {
            const args = Array.isArray(value.args) ? value.args : [];
            const run = [...sessions().values()].find((item) => item.nativeId === args[0]);
            if (!run) continue;
            if (value.event === "api-session/status") void run.status(args[1] === true);
            else if (value.event === "api-session/error") run.publish({ type: "prompt_error", errorMessage: String(args[1]) });
          }
        }
      } catch {
        reset();
        for (const run of sessions().values()) {
          run.interactions.clear();
          run.publish({ type: "prompt_error", errorMessage: "dsh connection lost; the next action restores its native snapshot. No prompt was resent." });
        }
      } finally { await reader.cancel().catch(() => {}); }
    })();
  })();
  const installed = attempt.catch((error: unknown) => { reset(); throw error; });
  shared[EVENTS] = installed;
  return installed;
}

class DshWebSession {
  nativeId = "";
  sessionPath = "";
  cwd = "";
  isStreaming = false;
  starting = 0;
  cancelRequested = false;
  readonly nativeViews = new Map<string, number>();
  hasNativeView(): boolean { return [...this.nativeViews.values()].some((until) => until > Date.now()); }
  streamingMessage: AssistantMessage | null = null;
  readonly interactions = new Map<string, DshInteraction & { clientId: string }>();
  private readonly listeners = new Set<(event: AgentEventLike) => void>();
  private opening: Promise<NativeSnapshot> | null = null;
  private follow: DshStream<Record<string, unknown>> | null = null;
  private generation = -1;
  private stateRevision = 0;
  private readonly optimistic = new Set<string>();
  private inbox: Record<string, unknown> = {};
  private serial: Promise<unknown> = Promise.resolve();
  private aborted = false;

  constructor(readonly id: string) {}
  isAlive(): boolean { return true; }
  onEvent(listener: (event: AgentEventLike) => void): () => void {
    this.listeners.add(listener);
    listener({ type: "queue_update", ...this.queuedMessages() });
    return () => { this.listeners.delete(listener); };
  }
  publish(event: AgentEventLike): void { for (const listener of this.listeners) { try { listener(event); } catch { /* one disconnected browser is not a Host failure */ } } }
  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.catch(() => {});
    return result;
  }
  queuedMessages() { return { steering: records(this.inbox["next-step"]).map((item) => nativeText(item.content)), followUp: records(this.inbox["next-turn"]).map((item) => nativeText(item.content)) }; }
  async refreshQueue(): Promise<void> {
    if (!this.nativeId) return;
    const projection = await dshWebHost().call<{ values: Record<string, unknown> } | null>("session/projections", { request: { sessionId: this.nativeId } });
    this.inbox = record(projection?.values.inbox);
    this.publish({ type: "queue_update", ...this.queuedMessages() });
  }
  async status(running: boolean): Promise<void> {
    const revision = ++this.stateRevision;
    if (running) {
      if (!this.isStreaming) { this.isStreaming = true; this.publish({ type: "agent_start" }); }
      return;
    }
    try { await this.refreshQueue(); } catch { return; } // Unknown is not an idle confirmation.
    if (revision !== this.stateRevision || records(this.inbox["next-step"]).length || records(this.inbox["next-turn"]).length) return;
    if (this.isStreaming) {
      this.isStreaming = false;
      this.streamingMessage = null;
      this.publish({ type: "agent_end" });
      this.publish({ type: "agent_settled", aborted: this.aborted });
    }
  }
  async image(id: string): Promise<ImageContent | null> {
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) return null;
    try {
      const result = await dshWebHost().call<{ attachment: { mediaType: string }; data: string }>("session/attachment", { request: { sessionId: this.nativeId, attachmentId: id } });
      if (!/^(image\/(png|jpeg|webp|gif))$/.test(result.attachment.mediaType) || result.data.length > 30 * 1024 * 1024) return null;
      return { type: "image", source: { type: "base64", media_type: result.attachment.mediaType, data: result.data } };
    } catch { return null; }
  }

  async open(cwd?: string): Promise<NativeSnapshot> {
    if (cwd && this.cwd && cwd !== this.cwd) throw new Error("dsh session directory cannot change");
    await dshWebHost().ready();
    await eventSource();
    if (this.opening && (this.generation === -1 || this.generation === dshWebHost().generation)) return this.opening;
    this.generation = -1;
    const attempt = this.bind(cwd);
    this.opening = attempt;
    try { return await attempt; } catch (error) { if (this.opening === attempt) this.opening = null; throw error; }
  }

  private async bind(cwd?: string): Promise<NativeSnapshot> {
    const indexed = readCatalogSession(this.id);
    if (indexed && indexed.harness !== "dsh") throw new Error("This session belongs to another harness");
    const boundCwd = indexed?.cwd || this.cwd || cwd;
    if (!boundCwd) throw new Error("A project directory is required");
    if (cwd && cwd !== boundCwd) throw new Error("dsh session directory cannot change");
    if (legacyRuns()?.get(this.id)?.isStreaming) throw new Error("An ACP turn from the previous deployment is still running; finish it before opening the native Web session");
    this.cwd = boundCwd;
    await eventSource();
    if (!this.nativeId) {
      if (indexed) {
        this.nativeId = indexed.sessionPath ? path.basename(indexed.sessionPath) : this.id;
        this.sessionPath = indexed.sessionPath;
      } else {
        const created = await dshWebHost().call<{ sessionId: string }>("session/create", { request: { cwd: this.cwd, sessionId: this.id } });
        if (created.sessionId !== this.id) throw new Error("Native session identity already exists; refusing to replace its context");
        this.nativeId = created.sessionId;
      }
    }
    this.generation = dshWebHost().generation;
    const snapshot = await this.subscribe();
    const list = await dshWebHost().call<{ items: { sessionId: string; running: boolean }[] }>("session/list", { _request: {} });
    const current = list.items.find((item) => item.sessionId === this.nativeId);
    if (!current || typeof current.running !== "boolean") throw new Error("Cannot confirm native dsh session status");
    await this.status(current.running);
    return snapshot;
  }

  private async subscribe(): Promise<NativeSnapshot> {
    const previous = this.follow;
    this.follow = null;
    previous?.close();
    const follow = await dshWebHost().stream<Record<string, unknown>>("session/follow", { request: { address: { kind: "session", sessionId: this.nativeId }, maxMessages: 200, assistantStream: true } });
    this.follow = follow;
    const reader = follow.readable.getReader();
    const opening = await reader.read();
    const snapshot = opening.value as unknown as NativeSnapshot;
    if (snapshot?.type !== "snapshot" || snapshot.header.id !== this.nativeId || snapshot.header.cwd !== this.cwd) {
      await reader.cancel();
      throw new Error("dsh native history does not match this indexed session and directory");
    }
    this.inbox = record(snapshot.projections.values.inbox);
    let cursor = snapshot.cursor;
    void (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) throw new Error("dsh history stream ended");
          if (value.type === "event") {
            const event = value.event as NativeEvent;
            if (event.seq <= cursor) continue;
            if (event.seq !== cursor + 1) throw new Error("dsh history sequence gap; reopen to restore a snapshot");
            cursor = event.seq;
            await this.event(event);
          } else if (value.type === "assistant-stream") this.chunk(record(value.frame));
        }
      } catch (error) {
        if (this.follow !== follow) return;
        this.opening = null;
        this.streamingMessage = null;
        this.publish({ type: "prompt_error", errorMessage: error instanceof Error ? error.message : "dsh history connection lost" });
      } finally { await reader.cancel().catch(() => {}); }
    })();
    return snapshot;
  }

  private chunk(frame: Record<string, unknown>): void {
    if (frame.type === "start") {
      this.streamingMessage = { role: "assistant", content: [], provider: "dsh", model: "dsh" };
      this.publish({ type: "message_start", message: this.streamingMessage });
    }
    const chunk = record(frame.chunk);
    if (frame.type !== "chunk" || typeof chunk.index !== "number") return;
    const index = chunk.index;
    if (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") return;
    if (typeof chunk.text !== "string") return;
    if (!this.streamingMessage) return; // An opening mid-attempt is restored by its durable settlement.
    const thinking = chunk.type === "reasoning-delta";
    if (!this.streamingMessage.content[index]) {
      this.streamingMessage.content[index] = thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
      this.publish({ type: "message_update", assistantMessageEvent: { type: thinking ? "thinking_start" : "text_start", contentIndex: index } });
    }
    const block = this.streamingMessage.content[index];
    if (block.type === "text") block.text += chunk.text;
    else if (block.type === "thinking") block.thinking += chunk.text;
    this.publish({ type: "message_update", assistantMessageEvent: { type: thinking ? "thinking_delta" : "text_delta", contentIndex: index, delta: chunk.text } });
  }

  private async event(event: NativeEvent): Promise<void> {
    if (event.type === "turn/start") { this.aborted = false; await this.status(true); }
    const data = record(event.data);
    if (event.type === "session/title" && typeof data.title === "string" && readCatalogSession(this.id)) updateCatalogSession(this.id, { title: data.title });
    if (event.type === "tool/call") {
      const call = record(data.call);
      this.publish({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name });
    }
    if (event.type === "tool/result") this.publish({ type: "tool_execution_end", toolCallId: record(data.message).toolCallId, isError: record(data.message).isError === true });
    const own = event.type === "user/message" && this.optimistic.delete(String(record(data.source).rpcId));
    const message = own ? null : await nativeMessage(event, (id) => this.image(id));
    if (message) {
      if (message.role !== "assistant" || !this.streamingMessage) this.publish({ type: "message_start", message });
      this.publish({ type: "message_end", message });
      if (message.role === "assistant") this.streamingMessage = null;
    }
    if (event.type.startsWith("inbox/")) await this.refreshQueue();
    if (event.type === "turn/end") { this.aborted = data.reason === "cancelled"; await this.status(false); }
  }

  async send(prompt: DshWebPrompt, behavior?: DshStreamingBehavior) {
    if (!prompt.text.trim() && !prompt.images?.length) throw new Error("Message is empty");
    await this.open(prompt.cwd);
    if (this.cancelRequested) throw new Error("dsh prompt was cancelled before admission");
    if (prompt.provider && prompt.model) await dshWebHost().call("session/selectModel", { request: { sessionId: this.nativeId, provider: prompt.provider, model: prompt.model } });
    if (this.cancelRequested) throw new Error("dsh prompt was cancelled before admission");
    const requestId = randomUUID();
    if (!behavior) this.optimistic.add(requestId);
    try {
      await dshWebHost().call("session/prompt", { request: { requestId, sessionId: this.nativeId, mode: behavior === "steer" ? "steer" : "queue", content: [
        ...(prompt.text.trim() ? [{ type: "text", text: prompt.text }] : []),
        ...(prompt.images ?? []).map((item) => ({ type: "image", mediaType: item.mimeType, data: item.data })),
      ] } });
    } catch (error) { this.optimistic.delete(requestId); throw error; }
    if (!this.sessionPath) {
      for (let attempt = 0; attempt < 100; attempt++) {
        try { this.sessionPath = nativeDirectory(this.nativeId); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      // The native id equals the web id for new sessions; catalog repair can locate a delayed flush.
      // A missing path must never turn an accepted prompt into a retryable rejection.
    }
    if (readCatalogSession(this.id)) updateCatalogSession(this.id, { sessionPath: this.sessionPath });
    await this.refreshQueue();
    return { sessionPath: this.sessionPath, queued: behavior !== undefined };
  }

  async clearQueue() {
    await this.open(); await this.refreshQueue();
    const queued = this.queuedMessages();
    const images: { data: string; mimeType: string }[] = [];
    for (const item of [...records(this.inbox["next-step"]), ...records(this.inbox["next-turn"])]) {
      await dshWebHost().call("session/updateQueue", { request: { sessionId: this.nativeId, itemId: item.id, action: { kind: "remove" } } });
      for (const part of records(item.content)) {
        const id = record(part.attachment).attachmentId ?? part.attachmentId;
        const image = typeof id === "string" ? await this.image(id) : null;
        if (image && typeof image.source.data === "string" && typeof image.source.media_type === "string") images.push({ data: image.source.data, mimeType: image.source.media_type });
      }
    }
    await this.refreshQueue();
    return { ...queued, ...(images.length ? { images } : {}) };
  }
  async abort(): Promise<boolean> {
    if (!this.nativeId) return false;
    this.aborted = true;
    await this.clearQueue();
    if (this.isStreaming) await dshWebHost().call("session/cancel", { request: { sessionId: this.nativeId } });
    return true;
  }
}

export function getDshSession(id: string): DshWebSession {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error("Invalid dsh session id");
  const current = sessions().get(id);
  if (current) return current;
  const run = new DshWebSession(id);
  sessions().set(id, run);
  return run;
}
export function dshRunningIds(): string[] { return [...new Set([...sessions().keys(), ...legacyRuns()?.keys() ?? []].filter(isDshRunning))]; }
export function isDshRunning(id: string): boolean {
  const run = sessions().get(id), queue = run?.queuedMessages();
  return run?.isStreaming === true || (run?.starting ?? 0) > 0 || !!queue?.steering.length || !!queue?.followUp.length || legacyRuns()?.get(id)?.isStreaming === true;
}
export function dshState(id: string) {
  const run = sessions().get(id) ?? legacyRuns()?.get(id);
  return { isStreaming: isDshRunning(id), queuedMessages: run?.queuedMessages() ?? { steering: [], followUp: [] } };
}
export function sendDshPrompt(prompt: DshWebPrompt, behavior?: DshStreamingBehavior) {
  const run = getDshSession(prompt.sessionId);
  if (run.cancelRequested && isDshRunning(run.id)) return Promise.reject(new Error("dsh is stopping"));
  if (isDshRunning(run.id) && !behavior) return Promise.reject(new Error("dsh is already answering in this chat"));
  if (!isDshRunning(run.id)) run.cancelRequested = false;
  run.starting++;
  return run.enqueue(() => dshAdmission(false, () => run.send(prompt, behavior))).finally(() => { run.starting--; });
}
export function abortDshPrompt(id: string) { const run = getDshSession(id); run.cancelRequested = true; return run.enqueue(() => run.abort()); }
export function clearDshQueue(id: string) { const run = getDshSession(id); return run.enqueue(() => run.clearQueue()); }
export function dshInteractions(id: string): DshInteraction[] { return [...getDshSession(id).interactions.values()].map(({ id, event, request }) => ({ id, event, request })); }
export async function leaseDshNativeView(nativeId: string, leaseId: string, active: boolean): Promise<void> {
  if (!/^[\w-]{16,100}$/.test(leaseId)) throw new Error("Invalid native view lease");
  const run = [...sessions().values()].find((run) => run.nativeId === nativeId);
  if (!run) return; // An explicit native-only conversation is not adopted into the web index.
  if (!active) { run.nativeViews.delete(leaseId); return; }
  run.nativeViews.set(leaseId, Date.now() + 15_000);
  for (const item of run.interactions.values()) {
    await dshWebHost().call("$events/result", { clientId: item.clientId, eventId: item.id, outcome: { kind: "next" } });
    run.interactions.delete(item.id);
  }
}
export async function answerDshInteraction(id: string, eventId: string, value: unknown): Promise<void> {
  const run = getDshSession(id);
  const item = run.interactions.get(eventId);
  if (!item) throw new Error("This interaction expired or belongs to another session");
  if (item.event === "approval/request" && value !== "allowed-once" && value !== "rejected" && value !== "cancelled") throw new Error("Invalid approval decision");
  if (item.event === "user-questions/request" && !Array.isArray(record(value).answers)) throw new Error("Expected structured question answers");
  await dshWebHost().call("$events/result", { clientId: item.clientId, eventId, outcome: { kind: "result", value } });
  run.interactions.delete(eventId);
}

export async function readDshWebTranscript(id: string) {
  const run = getDshSession(id);
  await run.open();
  const follow = await dshWebHost().stream<NativeSnapshot>("session/follow", { request: { address: { kind: "session", sessionId: run.nativeId }, maxMessages: 200 } });
  const reader = follow.readable.getReader();
  let snapshot: NativeSnapshot;
  try {
    const first = await reader.read();
    if (!first.value || first.value.type !== "snapshot") throw new Error("Invalid dsh history snapshot");
    snapshot = first.value;
  } finally { await reader.cancel(); }
  let page = { records: snapshot.records, hasMore: snapshot.hasMore };
  const events = snapshot.records.map((item) => item.event);
  // ponytail: return at most 10k messages to the existing unpaged renderer; add UI pagination before raising this cap.
  while (page.hasMore && events.length < 10_000) {
    const before = events[0]?.seq;
    page = await dshWebHost().call("session/page", { request: { address: { kind: "session", sessionId: run.nativeId }, throughSeq: snapshot.cursor, beforeSeq: before, maxMessages: 200 } });
    if (!page.records.length || page.records[0].event.seq >= (before ?? Infinity)) throw new Error("dsh history pagination made no progress");
    events.unshift(...page.records.map((item) => item.event));
  }
  const surface = nativeSurface(events);
  const messages: AgentMessage[] = [], entryIds: string[] = [];
  for (const event of surface) {
    const message = await nativeMessage(event, (id) => run.image(id));
    if (message) { messages.push(message); entryIds.push(`${id}:${event.seq}`); }
  }
  const selected = record(record(snapshot.projections.values.modelSelection).next);
  return { messages, entryIds, model: typeof selected.provider === "string" && typeof selected.model === "string" ? { provider: selected.provider, modelId: selected.model } : null, hasMore: page.hasMore };
}

export async function applyDshCatalogPatch(id: string, patch: { harness?: string; cwd?: string; provider?: string; model?: string; title?: string; sessionPath?: string }): Promise<void> {
  const row = readCatalogSession(id);
  if (!row || row.harness !== "dsh") return;
  if ((patch.harness && patch.harness !== "dsh") || (patch.cwd && patch.cwd !== row.cwd) || (patch.sessionPath && row.sessionPath && patch.sessionPath !== row.sessionPath)) throw new Error("dsh session identity cannot change");
  const run = getDshSession(id);
  const provider = patch.provider ?? row.provider, model = patch.model ?? row.model;
  if ((patch.provider !== undefined || patch.model !== undefined) && (provider !== row.provider || model !== row.model)) {
    await run.open();
    await dshAdmission(false, () => dshWebHost().call("session/selectModel", { request: { sessionId: run.nativeId, provider, model } }));
  }
  if (patch.title !== undefined && patch.title !== row.title) {
    await run.open();
    await dshWebHost().call("session/rename", { request: { sessionId: run.nativeId, title: patch.title } });
  }
}
export async function dshNativeSessionId(id: string): Promise<string | null> {
  if (readCatalogSession(id)?.harness !== "dsh") return null;
  const run = getDshSession(id);
  await run.open();
  return run.nativeId;
}
export async function readDshNativeTitle(id: string): Promise<string | null> {
  const run = getDshSession(id);
  await run.open();
  const projection = await dshWebHost().call<{ values: Record<string, unknown> }>("session/projections", { request: { sessionId: run.nativeId } });
  return typeof projection.values.title === "string" ? projection.values.title : null;
}

export async function listDshWebModels(): Promise<HarnessModelList> {
  const catalog = await dshWebHost().call<{ default: { provider: string; model: string }; groups: { id: string; name: string; models: { id: string; name: string }[] }[] }>("session/modelCatalog");
  return { path: path.join(dshWebHost().profileDir, "cordis.patch.yml"), models: catalog.groups.flatMap((group) => group.models.map((model) => ({ key: JSON.stringify([group.id, model.id]), name: model.name, provider: group.id, model: model.id, enabled: true, isDefault: catalog.default.provider === group.id && catalog.default.model === model.id }))) };
}

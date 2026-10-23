import path from "node:path";
import type { AgentEventLike } from "@/lib/agent-event-wire";
import type { AssistantMessage } from "@/lib/types";
import { dshKernel, type AcpConfigOption, type AcpSessionState } from "./acp";
import { DshEventMapper } from "./events";
import { findDshSessionDir } from "./index";

/**
 * The dsh runtime: one kernel process (`dsh --profile acp`), one ACP session per
 * chat. The kernel owns the session log; this module only drives it.
 *
 *   send()   open or resume the ACP session, pin the model, submit the prompt
 *   abort()  session/cancel; the kernel settles the turn with "cancelled"
 *   resume   session/resume from the log the catalog row points at
 *
 * A chat's web id is ours. The kernel picks its own session id, so the mapping
 * lives here and the catalog row keeps the kernel's session directory.
 */
export interface DshPrompt {
  sessionId: string;
  cwd: string;
  text: string;
  provider?: string | null;
  model?: string | null;
  /** The kernel session directory this chat already has, when it has one. */
  sessionPath?: string | null;
}

type Listener = (event: AgentEventLike) => void;

/** Enough of the last run that a reconnecting tab can rebuild the bubble. */
const REPLAY_LIMIT = 4000;

class DshSession {
  readonly subscribers = new Set<Listener>();
  readonly replay: AgentEventLike[] = [];
  isStreaming = false;
  aborted = false;
  model = "";
  /** The kernel's id for this chat, known once the session is open. */
  acpSessionId: string | null = null;
  /** The kernel's session directory, stored in the catalog row. */
  sessionPath: string | null = null;
  cwd = "";
  /** The chat reads a snapshot from here on connect; the kernel has none mid-run. */
  readonly streamingMessage: AssistantMessage | null = null;

  constructor(readonly sessionId: string) {}

  onEvent(listener: Listener): () => void {
    this.subscribers.add(listener);
    if (this.isStreaming) {
      for (const event of this.replay) listener(event);
    }
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /** The stream helper asks this before it starts forwarding. */
  isAlive(): boolean {
    return true;
  }

  publish(event: AgentEventLike): void {
    if (event.type === "agent_start") this.replay.length = 0;
    if (this.isStreaming && this.replay.length < REPLAY_LIMIT) this.replay.push(event);
    for (const listener of [...this.subscribers]) {
      try {
        listener(event);
      } catch {
        /* one broken stream must not stop the run */
      }
    }
  }
}

const REGISTRY: symbol = Symbol.for("pi-web.dshSessions");
const EXIT_HOOK: symbol = Symbol.for("pi-web.dshExitHook");

function registry(): Map<string, DshSession> {
  const holder = globalThis as Record<symbol, Map<string, DshSession> | undefined>;
  return (holder[REGISTRY] ??= new Map<string, DshSession>());
}

/**
 * The kernel dies with every session it was driving. Their logs stay, so the
 * next prompt resumes from `sessionPath`; in-flight turns are told they failed.
 */
function watchKernel(): void {
  const holder = globalThis as Record<symbol, boolean | undefined>;
  if (holder[EXIT_HOOK]) return;
  holder[EXIT_HOOK] = true;
  dshKernel().onExit((reason) => {
    for (const run of registry().values()) {
      run.acpSessionId = null;
      if (!run.isStreaming) continue;
      run.isStreaming = false;
      run.publish({ type: "prompt_error", errorMessage: reason });
      run.publish({ type: "agent_end" });
      run.publish({ type: "agent_settled", aborted: run.aborted });
    }
  });
}

export function getDshSession(sessionId: string): DshSession {
  watchKernel();
  const existing = registry().get(sessionId);
  if (existing) return existing;
  const run = new DshSession(sessionId);
  registry().set(sessionId, run);
  return run;
}

export function isDshRunning(sessionId: string): boolean {
  return registry().get(sessionId)?.isStreaming === true;
}

/** The ACP model option is the route, encoded as `[provider, model]`. */
function modelValue(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

function offersModel(options: AcpConfigOption[] | undefined, value: string): boolean {
  const model = options?.find((option) => option.id === "model");
  return (model?.options ?? []).some((group) => (group.options ?? []).some((entry) => entry.value === value));
}

async function openAcpSession(run: DshSession, prompt: DshPrompt): Promise<void> {
  if (run.acpSessionId) return;
  const client = dshKernel();
  const params = { cwd: prompt.cwd, mcpServers: [] as unknown[] };
  const resumeId = prompt.sessionPath ? path.basename(prompt.sessionPath) : null;

  let state: AcpSessionState;
  if (resumeId) {
    try {
      state = await client.request<AcpSessionState>("session/resume", { sessionId: resumeId, ...params });
      run.sessionPath = prompt.sessionPath ?? null;
    } catch (error) {
      throw new Error(
        `dsh could not resume this chat: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    state = await client.request<AcpSessionState>("session/new", params);
    run.sessionPath = findDshSessionDir(state.sessionId);
  }
  run.acpSessionId = state.sessionId;
  run.cwd = prompt.cwd;

  const wanted = prompt.provider && prompt.model ? modelValue(prompt.provider, prompt.model) : null;
  if (!wanted) return;
  const current = state.configOptions?.find((option) => option.id === "model")?.currentValue;
  if (current === wanted) return;
  if (!offersModel(state.configOptions, wanted)) {
    throw new Error(`This dsh profile does not mount ${prompt.provider}/${prompt.model}`);
  }
  await client.request("session/set_config_option", { sessionId: state.sessionId, configId: "model", value: wanted });
}

/**
 * Start one turn. Resolves once the kernel accepted the prompt: the reply
 * streams to subscribers as agent events, so the caller only reports "accepted".
 */
export async function sendDshPrompt(prompt: DshPrompt): Promise<{ sessionPath: string }> {
  const run = getDshSession(prompt.sessionId);
  if (run.isStreaming) throw new Error("dsh is already answering in this chat");
  if (!prompt.text.trim()) throw new Error("empty prompt");

  const client = dshKernel();
  await client.ready();
  await openAcpSession(run, prompt);

  run.isStreaming = true;
  run.aborted = false;
  run.model = prompt.model ?? "";
  run.publish({ type: "agent_start" });

  const mapper = new DshEventMapper(run.model, (event) => run.publish(event));
  const acpSessionId = run.acpSessionId;
  const unsubscribe = client.onUpdate((message) => {
    if (message.sessionId === acpSessionId) mapper.push(message.update);
  });
  let settled = false;
  const settle = (stopReason?: string, error?: string) => {
    if (settled) return;
    settled = true;
    unsubscribe();
    mapper.finish(error ? "error" : run.aborted ? "aborted" : stopReason);
    run.isStreaming = false;
    if (error) run.publish({ type: "prompt_error", errorMessage: error });
    run.publish({ type: "agent_end" });
    run.publish({ type: "agent_settled", aborted: run.aborted });
  };

  // The prompt request settles at the end of the turn, so it is not awaited.
  void client
    .request<{ stopReason?: string }>("session/prompt", {
      sessionId: acpSessionId,
      prompt: [{ type: "text", text: prompt.text }],
    })
    .then((result) => settle(result?.stopReason))
    .catch((error: unknown) => settle(undefined, error instanceof Error ? error.message : String(error)));

  return { sessionPath: run.sessionPath ?? "" };
}

export function abortDshPrompt(sessionId: string): boolean {
  const run = registry().get(sessionId);
  if (!run?.isStreaming || !run.acpSessionId) return false;
  run.aborted = true;
  dshKernel().notify("session/cancel", { sessionId: run.acpSessionId });
  return true;
}

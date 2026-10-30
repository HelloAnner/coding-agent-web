import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { AgentEventLike } from "@/lib/agent-event-wire";
import type { AssistantMessage } from "@/lib/types";
import { GrokEventMapper } from "./events";
import {
  grokBin,
  grokHistoryFile,
  grokPermissionMode,
  grokPromptWithImages,
  resolveGrokHistoryFile,
} from "./index";

/**
 * The grok runtime. One `grok -p` child per prompt, nothing long-lived:
 *
 *   send()   spawn grok headless, stream its NDJSON to subscribers
 *   abort()  SIGINT the child, which is grok's own "stop"
 *   resume   `-r <sessionId>` when grok already has that session
 *
 * Grok owns the session files; this module only reads them (see transcript.ts)
 * and never keeps a second copy of the conversation.
 */
export interface GrokPrompt {
  sessionId: string;
  cwd: string;
  text: string;
  model?: string | null;
  /** Attached images, base64 without a data URL prefix. */
  images?: Array<{ data: string; mimeType: string }>;
}

/** Steer interrupts the current CLI; follow-up waits for it to exit. */
export type GrokStreamingBehavior = "steer" | "followUp";

type Listener = (event: AgentEventLike) => void;

/** Enough of the last run that a reconnecting tab can rebuild the bubble. */
const REPLAY_LIMIT = 4000;

class GrokRun {
  readonly subscribers = new Set<Listener>();
  readonly replay: AgentEventLike[] = [];
  child: ChildProcess | null = null;
  isStreaming = false;
  aborted = false;
  interrupted = false;
  model = "";
  // ponytail: queues survive browser reconnects, not server restarts; persist only if needed.
  private readonly queued: { steering: GrokPrompt[]; followUp: GrokPrompt[] } = { steering: [], followUp: [] };
  /** The chat reads a snapshot from here on connect; grok has none mid-run. */
  readonly streamingMessage: AssistantMessage | null = null;

  constructor(readonly sessionId: string, model: string) {
    this.model = model;
  }

  onEvent(listener: Listener): () => void {
    this.subscribers.add(listener);
    if (this.isStreaming) {
      for (const event of this.replay) listener(event);
    }
    listener({ type: "queue_update", ...this.queuedMessages() });
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

  queuedMessages(): { steering: string[]; followUp: string[] } {
    return { steering: this.queued.steering.map((prompt) => prompt.text), followUp: this.queued.followUp.map((prompt) => prompt.text) };
  }

  enqueue(behavior: GrokStreamingBehavior, prompt: GrokPrompt): void {
    (behavior === "steer" ? this.queued.steering : this.queued.followUp).push(prompt);
    this.publish({ type: "queue_update", ...this.queuedMessages() });
    if (behavior === "steer") interruptGrokTurn(this);
  }

  shiftQueue(): GrokPrompt | undefined {
    const next = this.queued.steering.shift() ?? this.queued.followUp.shift();
    if (next) this.publish({ type: "queue_update", ...this.queuedMessages() });
    return next;
  }

  clearQueue() {
    const cleared = this.queuedMessages();
    const images = [...this.queued.steering, ...this.queued.followUp].flatMap((prompt) => prompt.images ?? []);
    this.queued.steering.length = 0;
    this.queued.followUp.length = 0;
    this.publish({ type: "queue_update", ...this.queuedMessages() });
    return { ...cleared, ...(images.length ? { images } : {}) };
  }
}

const REGISTRY: symbol = Symbol.for("pi-web.grokRuns");

/** Route handlers are bundled separately; one registry has to be shared. */
function registry(): Map<string, GrokRun> {
  const holder = globalThis as Record<symbol, Map<string, GrokRun> | undefined>;
  return (holder[REGISTRY] ??= new Map<string, GrokRun>());
}

export function getGrokRun(sessionId: string): GrokRun | null {
  return registry().get(sessionId) ?? null;
}

/** The SSE route's view of a session: the same shape pi's event streams take. */
export function getGrokEventSource(sessionId: string, model: string): GrokRun {
  const existing = registry().get(sessionId);
  if (existing) return existing;
  const run = new GrokRun(sessionId, model);
  registry().set(sessionId, run);
  return run;
}

export function isGrokRunning(sessionId: string): boolean {
  return registry().get(sessionId)?.isStreaming === true;
}

export function grokRunningIds(): string[] {
  return [...registry().values()].filter((run) => run.isStreaming).map((run) => run.sessionId);
}

export function grokState(sessionId: string) {
  const run = getGrokRun(sessionId);
  return {
    isStreaming: isGrokRunning(sessionId),
    queuedMessages: run?.queuedMessages() ?? { steering: [], followUp: [] },
    ...(run?.model ? { model: { provider: "grok", id: run.model } } : {}),
  };
}

function defaultModel(): string {
  return process.env.GROK_DEFAULT_MODEL?.trim() || "grok-4.7";
}

/**
 * Grok resolves `-r <id>` inside the folder's own session root, so the child
 * has to run in the folder the session was started in.
 */
function argsFor(prompt: GrokPrompt, text: string): string[] {
  const resume = resolveGrokHistoryFile(prompt.cwd, prompt.sessionId) !== null;
  return [
    "-p", text,
    "--output-format", "streaming-json",
    "--permission-mode", grokPermissionMode(),
    "--model", prompt.model?.trim() || defaultModel(),
    ...(resume ? ["-r", prompt.sessionId] : ["-s", prompt.sessionId]),
  ];
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

/**
 * `grok -p` has no image flag, so the bytes go to a temp file and the prompt
 * names the paths for grok's own file tools to open.
 */
function writeImages(prompt: GrokPrompt): string[] {
  const images = prompt.images ?? [];
  if (images.length === 0) return [];
  const dir = path.join(tmpdir(), "pi-web-grok-images", prompt.sessionId);
  mkdirSync(dir, { recursive: true });
  return images.map((image, index) => {
    const extension = IMAGE_EXTENSIONS[image.mimeType] ?? "png";
    const file = path.join(dir, `${Date.now()}-${index}.${extension}`);
    writeFileSync(file, Buffer.from(image.data, "base64"));
    return file;
  });
}

/** Where grok keeps this session's transcript. The catalog row stores it. */
export function grokSessionFile(cwd: string, sessionId: string): string {
  return grokHistoryFile(cwd, sessionId);
}

/** Start a CLI turn, announcing prompts that have no optimistic user bubble. */
function startGrokTurn(run: GrokRun, prompt: GrokPrompt, announce: boolean): void {
  run.isStreaming = true;
  run.aborted = false;
  run.interrupted = false;
  run.model = prompt.model?.trim() || defaultModel();
  run.publish({ type: "agent_start" });
  if (announce) {
    const imageBlocks = (prompt.images ?? []).map(({ data, mimeType }) => ({
      type: "image", source: { type: "base64", data, media_type: mimeType },
    }));
    run.publish({
      type: "message_end",
      message: { role: "user", timestamp: Date.now(), content: imageBlocks.length ? [...(prompt.text.trim() ? [{ type: "text", text: prompt.text }] : []), ...imageBlocks] : prompt.text },
    });
  }

  const mapper = new GrokEventMapper(run.model, (event) => run.publish(event));
  let stderr = "";
  let finished = false;
  const finish = (error?: string) => {
    // A spawn error is followed by close; it must not settle the successor.
    if (finished) return;
    finished = true;
    mapper.finish(run.aborted || run.interrupted);
    run.isStreaming = false;
    run.child = null;
    if (error) run.publish({ type: "prompt_error", errorMessage: error });
    const next = !run.aborted && run.shiftQueue();
    if (next) {
      startGrokTurn(run, next, true);
      return;
    }
    run.publish({ type: "agent_end" });
    run.publish({ type: "agent_settled", aborted: run.aborted });
  };

  let child: ChildProcess;
  try {
    const text = grokPromptWithImages(prompt.text, writeImages(prompt));
    child = spawn(grokBin(), argsFor(prompt, text), { cwd: prompt.cwd, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    finish(`grok could not start: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  run.child = child;

  child.stdout?.setEncoding("utf8");
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (finished || !line.trim()) return;
    try {
      mapper.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* a partial line at the end of a killed run */
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });

  child.on("error", (error) => {
    // Fires when the binary or the folder is missing, before anything runs.
    finish(`grok could not start: ${error.message}`);
  });
  child.on("close", (code) => {
    const failed = code !== 0 && !run.aborted && !run.interrupted;
    const tail = stderr.trim().split("\n").pop();
    finish(failed ? tail || `grok exited with code ${code}` : undefined);
  });
}

/** Admission is atomic: a late streaming prompt starts a turn instead of being stranded. */
export async function sendGrokPrompt(prompt: GrokPrompt, behavior?: GrokStreamingBehavior): Promise<{ queued: boolean }> {
  if (!prompt.text.trim() && !prompt.images?.length) throw new Error("empty prompt");
  const run = getGrokEventSource(prompt.sessionId, prompt.model ?? defaultModel());
  if (run.isStreaming) {
    if (run.aborted) throw new Error("grok is stopping; wait for it to finish before sending");
    if (!behavior) throw new Error("grok is already answering in this session");
    run.enqueue(behavior, prompt);
    return { queued: true };
  }
  startGrokTurn(run, prompt, behavior !== undefined);
  return { queued: false };
}

export function clearGrokQueue(sessionId: string) {
  return getGrokRun(sessionId)?.clearQueue() ?? { steering: [], followUp: [] };
}

function interruptGrokTurn(run: GrokRun): void {
  const child = run.child;
  if (!child || run.interrupted) return;
  run.interrupted = true;
  child.kill("SIGINT");
  setTimeout(() => {
    if (run.child === child) child.kill("SIGTERM");
  }, 3000).unref?.();
}

export function abortGrokPrompt(sessionId: string): boolean {
  const run = getGrokRun(sessionId);
  if (!run) return false;
  const cleared = run.clearQueue();
  if (!run.isStreaming) return cleared.steering.length + cleared.followUp.length > 0;
  run.aborted = true;
  interruptGrokTurn(run);
  return true;
}

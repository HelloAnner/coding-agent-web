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

type Listener = (event: AgentEventLike) => void;

/** Enough of the last run that a reconnecting tab can rebuild the bubble. */
const REPLAY_LIMIT = 4000;

class GrokRun {
  readonly subscribers = new Set<Listener>();
  readonly replay: AgentEventLike[] = [];
  child: ChildProcess | null = null;
  isStreaming = false;
  aborted = false;
  model = "";
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

  mapper(): GrokEventMapper {
    return new GrokEventMapper(this.model, (event) => this.publish(event));
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

/**
 * Start one turn. Resolves once the child is running: the reply streams to
 * subscribers as agent events, so the caller only reports "accepted".
 */
export async function sendGrokPrompt(prompt: GrokPrompt): Promise<void> {
  const run = getGrokEventSource(prompt.sessionId, prompt.model ?? defaultModel());
  if (run.isStreaming) throw new Error("grok is already answering in this session");
  if (!prompt.text.trim() && !prompt.images?.length) throw new Error("empty prompt");

  const files = writeImages(prompt);
  const text = grokPromptWithImages(prompt.text, files);

  run.isStreaming = true;
  run.aborted = false;
  run.model = prompt.model?.trim() || defaultModel();
  run.publish({ type: "agent_start" });

  const mapper = run.mapper();
  let stderr = "";
  const finish = (error?: string) => {
    if (!run.isStreaming) return;
    mapper.finish(run.aborted);
    run.isStreaming = false;
    run.child = null;
    if (error) run.publish({ type: "prompt_error", errorMessage: error });
    run.publish({ type: "agent_end" });
    run.publish({ type: "agent_settled", aborted: run.aborted });
  };

  let child: ChildProcess;
  try {
    child = spawn(grokBin(), argsFor(prompt, text), { cwd: prompt.cwd, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    finish(`grok could not start: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  run.child = child;

  child.stdout?.setEncoding("utf8");
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (!line.trim()) return;
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
    const failed = code !== 0 && !run.aborted;
    const tail = stderr.trim().split("\n").pop();
    finish(failed ? tail || `grok exited with code ${code}` : undefined);
  });
}

export function abortGrokPrompt(sessionId: string): boolean {
  const run = registry().get(sessionId);
  const child = run?.child;
  if (!run || !child) return false;
  run.aborted = true;
  child.kill("SIGINT");
  setTimeout(() => {
    if (run.child === child) child.kill("SIGTERM");
  }, 3000).unref?.();
  return true;
}

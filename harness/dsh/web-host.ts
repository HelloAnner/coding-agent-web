import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "undici";

/** Host, browser assets and Remote wire must be from this same tested release. */
export const DSH_WEB_VERSION = "0.2.0-rc.2";
export const DSH_WEB_PROFILE = "coding-agent-web";
const execute = promisify(execFile);

export class DshRemoteError extends Error {
  constructor(message: string, readonly code = "dsh/transport", readonly details: unknown = {}) {
    super(message);
    this.name = "DshRemoteError";
  }
}

export interface DshStream<T = unknown> {
  readonly readable: ReadableStream<T>;
  send(value: unknown): void;
  end(): void;
  close(): void;
}

/** One local, official Web Host. No TUI, Pi AgentSession or provider credentials in the bridge. */
export class DshWebHost {
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private origin = "";
  private cookie = "";
  private readonly streams = new Set<() => void>();
  private stopping = false;
  private quitting = false;
  private readonly shutdown = () => { this.quitting = true; void this.stop(); };
  private epoch = 0;
  generation = 0;

  constructor(readonly home = process.env.DSH_HOME || path.join(homedir(), ".dsh"), readonly bin = process.env.PI_WEB_DSH_BIN?.trim() || "dsh") {}

  get profileDir(): string { return path.join(this.home, "profiles", DSH_WEB_PROFILE); }

  ready(): Promise<void> {
    if (this.stopping || this.quitting) return Promise.reject(new DshRemoteError("dsh is stopping"));
    if (this.starting) return this.starting;
    process.once("SIGINT", this.shutdown);
    process.once("SIGTERM", this.shutdown);
    const attempt = this.start().catch(async (error: unknown) => {
      if (this.starting === attempt) await this.stop();
      throw error;
    });
    this.starting = attempt;
    return attempt;
  }

  private async start(): Promise<void> {
    const legacy = (globalThis as Record<symbol, { isRunning?: () => boolean } | undefined>)[Symbol.for("pi-web.dshAcp")];
    if (legacy?.isRunning?.()) throw new DshRemoteError("Restart coding-agent-web after its old ACP turns finish before opening native dsh; two Hosts must not write the same sessions", "dsh/migration");
    const epoch = this.epoch;
    const { stdout } = await execute(this.bin, ["--version"], { timeout: 10_000 });
    if (this.epoch !== epoch) throw new DshRemoteError("dsh startup was cancelled");
    if (stdout.trim() !== DSH_WEB_VERSION) {
      throw new DshRemoteError(`dsh ${DSH_WEB_VERSION} is required by this adapter; found ${stdout.trim().slice(0, 40)}. Host and Client releases must match.`, "dsh/version");
    }
    const args = ["--profile", DSH_WEB_PROFILE];
    if (!existsSync(path.join(this.profileDir, "package.json"))) args.push("--from-default-profile", "web");
    args.push("--no-open", "--host", "127.0.0.1", "--port", "0");
    const child = spawn(this.bin, args, { cwd: homedir(), env: { ...process.env, DSH_HOME: this.home }, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    this.generation++;
    // Raw startup diagnostics can contain plugin configuration; never relay them to a browser.
    child.stderr?.resume();
    const launch = await new Promise<URL>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => finish(new DshRemoteError("dsh Web Host did not become ready within 60 seconds")), 60_000);
      const finish = (error?: Error, url?: URL) => {
        clearTimeout(timer);
        child.stdout?.off("data", output);
        child.off("error", failed);
        child.off("exit", exited);
        if (error) reject(error);
        else resolve(url!);
      };
      const failed = () => finish(new DshRemoteError("Could not launch the local dsh Web Host"));
      const exited = () => finish(new DshRemoteError("dsh Web Host exited before becoming ready; inspect the profile configuration"));
      const output = (chunk: Buffer) => {
        buffer = (buffer + chunk.toString("utf8")).slice(-16384);
        const match = /(?:^|\n)dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/.exec(buffer);
        if (match) finish(undefined, new URL(match[1]));
      };
      child.stdout?.on("data", output);
      child.once("error", failed);
      child.once("exit", exited);
    });
    child.stdout?.resume();
    child.once("exit", () => {
      if (this.child !== child) return;
      process.off("SIGINT", this.shutdown);
      process.off("SIGTERM", this.shutdown);
      this.child = null;
      this.starting = null;
      this.cookie = "";
      for (const close of [...this.streams]) close();
    });
    // rc.2's official authentication exchanges its launch URL for an authority-bound Cookie.
    // Keep both credentials server-side; neither is returned by an application API.
    const response = await fetch(launch, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    if (this.epoch !== epoch || this.child !== child) throw new DshRemoteError("dsh startup was cancelled");
    const cookies = response.headers.getSetCookie();
    if (response.status !== 303 || cookies.length !== 1) throw new DshRemoteError("dsh browser authentication failed");
    this.cookie = cookies[0].split(";", 1)[0];
    this.origin = launch.origin;
  }

  /** A fixed local route; callers cannot supply an upstream URL or headers. */
  async fetch(route: string, init: RequestInit = {}): Promise<Response> {
    if (!route.startsWith("/") || route.startsWith("//") || /[\\\r\n]/.test(route)) throw new DshRemoteError("Invalid dsh route");
    await this.ready();
    const target = new URL(route, this.origin);
    if (target.origin !== this.origin) throw new DshRemoteError("Invalid dsh origin");
    const headers = new Headers(init.headers);
    headers.set("cookie", this.cookie);
    return fetch(target, { ...init, headers, redirect: "manual", cache: "no-store" });
  }

  async call<T = unknown>(endpoint: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (!/^(?:[\w$-]+\/[\w$-]+)$/.test(endpoint)) throw new DshRemoteError("Invalid Remote endpoint");
    const rpcId = randomUUID();
    const response = await this.fetch(`/api/${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } }),
      signal: signal ?? AbortSignal.timeout(120_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new DshRemoteError(`dsh Remote returned HTTP ${response.status}`); }
    const body = await response.json();
    if (body?.type !== "server-response" || body.rpcId !== rpcId || typeof body.result?.ok !== "boolean") throw new DshRemoteError("Invalid dsh Remote response");
    if (!body.result.ok) throw new DshRemoteError(body.result.error?.message || "dsh refused the operation", body.result.error?.code, body.result.error?.details);
    return body.result.value as T;
  }

  /** Pinned official Remote-stream wire; each subscription owns its cancellation and backpressure. */
  async stream<T = unknown>(endpoint: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<DshStream<T>> {
    if (endpoint !== "$events" && !/^[\w-]+\/[\w-]+$/.test(endpoint)) throw new DshRemoteError("Invalid stream endpoint");
    await this.ready();
    signal?.throwIfAborted();
    const socket = new WebSocket(this.origin.replace("http:", "ws:") + "/api/remote.mux", { headers: { cookie: this.cookie } });
    const streamId = randomUUID();
    let ended = false;
    let controller: ReadableStreamDefaultController<T>;
    const cleanup = () => {
      if (ended) return;
      ended = true;
      signal?.removeEventListener("abort", close);
      this.streams.delete(close);
      socket.close();
    };
    const close = () => {
      if (ended) return;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "cancel", streamId }));
      controller.error(new DshRemoteError("dsh Remote stream was disconnected"));
      cleanup();
    };
    const readable = new ReadableStream<T>({
      start(value) { controller = value; },
      cancel: cleanup,
    }, { highWaterMark: 8 * 1024 * 1024, size: value => Buffer.byteLength(JSON.stringify(value)) });
    this.streams.add(close);
    signal?.addEventListener("abort", close, { once: true });
    socket.addEventListener("message", (event) => {
      if (ended) return;
      try {
        if (typeof event.data !== "string") throw new DshRemoteError("Unexpected binary Remote frame");
        const frame = JSON.parse(event.data);
        if (frame.streamId !== streamId) throw new DshRemoteError("Remote stream identity mismatch");
        if (frame.type === "item") {
          if ((controller.desiredSize ?? 0) <= 0) throw new DshRemoteError("dsh consumer is too slow; reconnect to restore its snapshot");
          controller.enqueue(frame.value);
        } else if (frame.type === "end") { controller.close(); cleanup(); }
        else if (frame.type === "error") { controller.error(new DshRemoteError(frame.error?.message || "dsh stream failed", frame.error?.code)); cleanup(); }
        else throw new DshRemoteError("Invalid dsh stream frame");
      } catch (error) { controller.error(error); cleanup(); }
    });
    socket.addEventListener("close", close);
    socket.addEventListener("error", close);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { close(); reject(new DshRemoteError("dsh stream connection timed out")); }, 10_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        if (ended) { reject(new DshRemoteError("dsh stream was cancelled")); return; }
        socket.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
        resolve();
      }, { once: true });
      socket.addEventListener("close", () => { clearTimeout(timer); reject(new DshRemoteError("dsh stream connection closed")); }, { once: true });
    });
    return {
      readable,
      send: value => { if (!ended) socket.send(JSON.stringify({ type: "item", streamId, value })); },
      end: () => { if (!ended) socket.send(JSON.stringify({ type: "end", streamId })); },
      close,
    };
  }

  async stop(): Promise<void> {
    process.off("SIGINT", this.shutdown);
    process.off("SIGTERM", this.shutdown);
    this.stopping = true;
    this.epoch++;
    const child = this.child;
    for (const close of [...this.streams]) close();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill("SIGTERM");
      });
    }
    this.child = null;
    this.starting = null;
    this.cookie = "";
    this.stopping = false;
  }
}

const HOST = Symbol.for("coding-agent-web.dshWebHost");
export function dshWebHost(): DshWebHost {
  const shared = globalThis as Record<symbol, DshWebHost | undefined>;
  return shared[HOST] ??= new DshWebHost();
}

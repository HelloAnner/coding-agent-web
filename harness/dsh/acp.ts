import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { dshKernelSpawn } from "./acp-patch";
import { dshBin } from "./index";

/**
 * The dsh kernel over ACP (Agent Client Protocol), one long-lived child.
 *
 *   dsh --profile acp              serve ACP on stdio until the client leaves
 *   initialize                     protocol 1, no authentication
 *   session/new                    { cwd, mcpServers } -> { sessionId, configOptions }
 *   session/resume                 an id that still has a log under DSH_HOME/sessions
 *   session/set_config_option      "model" = JSON.stringify([provider, model])
 *   session/prompt                 resolves when the turn settles
 *   session/cancel                 a notification, not a request
 *   session/update                 committed text, thoughts, tool lifecycle
 *   session/request_permission     the kernel asks; this client always allows once
 *
 * ACP multiplexes sessions, so the whole app shares one kernel process and the
 * model catalog is the live one that kernel mounted.
 */
const PROTOCOL_VERSION = 1;

export interface AcpSessionState {
  sessionId: string;
  configOptions?: AcpConfigOption[];
}

export interface AcpConfigOption {
  id: string;
  currentValue?: string;
  options?: Array<{ group?: string; name?: string; options?: Array<{ value: string; name?: string }> }>;
}

export interface AcpUpdateMessage {
  sessionId: string;
  update: Record<string, unknown>;
}

type UpdateListener = (message: AcpUpdateMessage) => void;
type ExitListener = (reason: string) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class AcpClient {
  private child: ChildProcess | null = null;
  private spawnSignature = "";
  private _generation = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly updates = new Set<UpdateListener>();
  private readonly exits = new Set<ExitListener>();
  private stderr = "";
  private handshake: Promise<void> | null = null;
  private stopping = false;

  /** Spawn the kernel if it is not running. */
  private start(): ChildProcess {
    const launch = dshKernelSpawn();
    if (this.child && this.spawnSignature !== launch.signature) this.stop();
    if (this.child) return this.child;
    this.stopping = false;
    this.spawnSignature = launch.signature;
    const child = spawn(dshBin(), launch.args, {
      cwd: homedir(),
      stdio: ["pipe", "pipe", "pipe"],
      env: launch.env,
    });
    this.child = child;
    this._generation += 1;
    this.stderr = "";
    child.stdout?.setEncoding("utf8");
    createInterface({ input: child.stdout! }).on("line", (line) => this.receive(line));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    child.on("error", (error) => {
      if (this.child === child) this.die(`dsh could not start: ${error.message}`);
    });
    child.on("close", (code) => {
      if (this.child === child) this.die(`dsh exited with code ${code}`);
    });
    return child;
  }

  /** Bumped on every spawn, so callers can cache per kernel process. */
  get generation(): number {
    return this._generation;
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const method = typeof message.method === "string" ? message.method : null;
    if (method) {
      // A server-to-client request carries an id; a notification does not.
      if (message.id !== undefined) {
        this.answer(message.id, method);
        return;
      }
      if (method === "session/update") {
        const params = message.params as { sessionId?: unknown; update?: unknown } | undefined;
        if (typeof params?.sessionId !== "string") return;
        const update = (params.update ?? {}) as Record<string, unknown>;
        for (const listener of [...this.updates]) listener({ sessionId: params.sessionId, update });
      }
      return;
    }
    const id = typeof message.id === "number" ? message.id : -1;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    const error = message.error as { message?: string } | undefined;
    if (error) pending.reject(new Error(error.message || "dsh refused the request"));
    else pending.resolve(message.result);
  }

  /** The kernel's only client request is a tool permission; the web allows once. */
  private answer(id: unknown, method: string): void {
    const stdin = this.child?.stdin;
    if (!stdin) return;
    const frame = method === "session/request_permission"
      ? { jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId: "allow-once" } } }
      : { jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported: ${method}` } };
    stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private die(reason: string): void {
    if (!this.child) return;
    this.child = null;
    this.handshake = null;
    const detail = this.stderr.trim().split("\n").pop();
    const error = new Error(detail ? `${reason}: ${detail}` : reason);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.stopping) return;
    for (const listener of [...this.exits]) listener(error.message);
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const child = this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** The handshake, once per kernel process. */
  ready(): Promise<void> {
    // A settings write changes the patches; the next request boots the new tree.
    if (this.child && this.spawnSignature !== dshKernelSpawn().signature) this.stop();
    if (this.handshake) return this.handshake;
    const attempt = this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }).then(() => undefined).catch((error: Error) => {
      this.handshake = null;
      throw error;
    });
    this.handshake = attempt;
    return attempt;
  }

  onUpdate(listener: UpdateListener): () => void {
    this.updates.add(listener);
    return () => {
      this.updates.delete(listener);
    };
  }

  onExit(listener: ExitListener): void {
    this.exits.add(listener);
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  stop(): void {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    this.handshake = null;
    const error = new Error("dsh was restarted");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    child?.kill("SIGTERM");
    // The close handler is skipped while stopping, so tell the runtime here:
    // its ACP session ids belonged to the process that just went away.
    if (child) for (const listener of [...this.exits]) listener(error.message);
  }
}

const CLIENT: symbol = Symbol.for("pi-web.dshAcp");

/** Route handlers are bundled separately; one kernel has to be shared. */
export function dshKernel(): AcpClient {
  const holder = globalThis as Record<symbol, AcpClient | undefined>;
  return (holder[CLIENT] ??= new AcpClient());
}

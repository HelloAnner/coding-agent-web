import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

export type Frame = Record<string, unknown>;
export function object(value: unknown): Frame {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Frame : {};
}
export class OmpError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "OmpError"; }
}

/** Both private model pipes and native stdout are bounded JSONL, never a shell/PTY. */
export function readJsonLines(input: Readable, receive: (frame: Frame) => void, fail: (error: Error) => void, limit = 1024 * 1024): void {
  let buffer = Buffer.alloc(0);
  let failed = false;
  input.on("data", (data: Buffer) => {
    if (failed) return;
    try {
      buffer = Buffer.concat([buffer, data]);
      let end: number;
      while ((end = buffer.indexOf(10)) !== -1) {
        if (end + 1 > limit) throw new Error("OMP frame exceeded the transport limit");
        const line = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end));
        buffer = buffer.subarray(end + 1);
        if (!line.trim()) continue;
        const frame: unknown = JSON.parse(line);
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("Invalid OMP frame");
        receive(frame as Frame);
      }
      if (buffer.length > limit) throw new Error("OMP frame exceeded the transport limit");
    } catch (error) { failed = true; fail(error instanceof Error ? error : new Error(String(error))); }
  });
  input.on("error", fail);
  input.on("end", () => { if (!failed && buffer.toString().trim()) fail(new Error("OMP stream ended in an incomplete frame")); });
}

export class OmpFrameDecoder {
  private chunk: { id: string; count: number; bytes: number; next: number; size: number; buffers: Buffer[] } | null = null;
  push(frame: Frame): Frame | null {
    if (frame.type !== "rpc_chunk") {
      if (this.chunk) throw new Error("Interrupted OMP chunk sequence");
      return frame;
    }
    const { chunkId, index, count, byteLength, data } = frame;
    if (typeof chunkId !== "string" || !chunkId || !Number.isSafeInteger(index) || !Number.isSafeInteger(count)
      || Number(count) < 1 || Number(count) > 65536 || Number(index) < 0 || Number(index) >= Number(count)
      || !Number.isSafeInteger(byteLength) || Number(byteLength) < 1 || Number(byteLength) > 64 * 1024 * 1024
      || typeof data !== "string" || data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error("Invalid OMP chunk");
    if (!this.chunk) this.chunk = { id: chunkId, count: Number(count), bytes: Number(byteLength), next: 0, size: 0, buffers: [] };
    const chunk = this.chunk;
    if (chunk.id !== chunkId || chunk.count !== count || chunk.bytes !== byteLength || chunk.next !== index) throw new Error("Out-of-order OMP chunk");
    const bytes = Buffer.from(data, "base64");
    chunk.size += bytes.length;
    if (chunk.size > chunk.bytes) throw new Error("OMP chunk length mismatch");
    chunk.buffers.push(bytes);
    if (++chunk.next !== chunk.count) return null;
    if (chunk.size !== chunk.bytes) throw new Error("OMP chunk length mismatch");
    this.chunk = null;
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunk.buffers)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid reassembled OMP frame");
    return value as Frame;
  }
  finish(): void { if (this.chunk) throw new Error("Incomplete OMP chunk sequence"); }
}

type Waiter = { resolve: (frame: Frame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export class OmpRpc {
  readonly child: ChildProcess;
  readonly listeners = new Set<(frame: Frame) => void>();
  readonly exits = new Set<(error: Error) => void>();
  private readonly pending = new Map<string, Waiter>();
  private readonly decoder = new OmpFrameDecoder();
  private resolveReady!: (frame: Frame) => void;
  private rejectReady!: (error: Error) => void;
  private readonly readyFrame = new Promise<Frame>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
  private stderr = "";
  private failure: Error | null = null;
  private closing = false;
  private maxFrameBytes = 1024 * 1024;

  constructor(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    // Catch before a missing binary can reject prior to start() attaching its await.
    void this.readyFrame.catch(() => {});
    this.child = spawn(binary, args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] });
    readJsonLines(this.child.stdout!, (physical) => {
      const frame = this.decoder.push(physical);
      if (!frame) return;
      if (frame.type === "ready") this.resolveReady(frame);
      for (const listener of this.listeners) listener(frame);
      if (frame.type !== "response" || typeof frame.id !== "string") return;
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.success !== true) pending.reject(new OmpError(String(frame.error ?? "OMP command failed"), frame.code === "session_busy" ? 409 : 400));
      else pending.resolve(object(frame.data));
    }, (error) => this.fail(error));
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (text: string) => { this.stderr = (this.stderr + text).slice(-4000); });
    this.child.stdin!.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(new OmpError(`Could not start omp: ${error.message}`, 503)));
    this.child.on("close", (code) => {
      try { this.decoder.finish(); } catch (error) { this.fail(error as Error); }
      // Native stderr can contain credentials; never publish its raw contents.
      const reason = /No models available/.test(this.stderr) ? "OMP has no available model" : `OMP process exited (${code})`;
      this.fail(new OmpError(reason, 503));
    });
  }
  get alive(): boolean { return !this.failure && !this.closing && Boolean(this.child.stdin?.writable); }
  async start(): Promise<void> {
    const timer = setTimeout(() => this.fail(new OmpError("OMP startup timed out", 504)), 30_000);
    try {
      const ready = await this.readyFrame;
      if (!Array.isArray(ready.supportedProtocolVersions) || !ready.supportedProtocolVersions.includes(2)) throw new OmpError("OMP RPC protocol v2 is required", 503);
      if (typeof ready.maxFrameBytes === "number") this.maxFrameBytes = Math.min(this.maxFrameBytes, ready.maxFrameBytes);
      await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
    } catch (error) { this.fail(error as Error); throw error; }
    finally { clearTimeout(timer); }
  }
  write(frame: Frame): void {
    if (!this.alive) throw this.failure ?? new Error("OMP is not connected");
    const text = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(text) > this.maxFrameBytes) throw new OmpError("OMP input exceeds 1 MiB; shorten the message or compress attachments", 413);
    this.child.stdin!.write(text);
  }
  request(frame: Frame, id: string = randomUUID()): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new OmpError(`OMP ${String(frame.type)} timed out`, 504)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ ...frame, id }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.rejectReady(error);
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
    for (const listener of this.exits) { try { listener(error); } catch { /* cleanup must continue */ } }
    this.child.kill("SIGTERM");
    this.close();
  }
  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.child.stdin?.end();
    setTimeout(() => { if (this.child.exitCode === null) this.child.kill("SIGTERM"); }, 2000).unref();
    setTimeout(() => { if (this.child.exitCode === null) this.child.kill("SIGKILL"); }, 5000).unref();
  }
}

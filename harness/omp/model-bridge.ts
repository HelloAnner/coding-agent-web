import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { Context, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { ompModelMetadata, selectedOmpModel, type ProjectModels } from "./models";
import { object, OmpError, readJsonLines, type Frame, type OmpRpc } from "./rpc";

export const OMP_MODEL_API = "coding-agent-web-models";

/** Restore the actual provider API before Pi performs signature/replay compatibility checks. */
export function piModelContext(raw: unknown): Context {
  const context = object(raw);
  if (!Array.isArray(context.messages)) throw new OmpError("Invalid OMP model context");
  return {
    ...(typeof context.systemPrompt === "string" ? { systemPrompt: context.systemPrompt }
      : Array.isArray(context.systemPrompt) && context.systemPrompt.every((part) => typeof part === "string") ? { systemPrompt: context.systemPrompt.join("\n\n") } : {}),
    ...(Array.isArray(context.tools) ? { tools: context.tools as Context["tools"] } : {}),
    messages: context.messages.map((rawMessage) => {
      const message = object(rawMessage);
      if (message.role === "assistant" && message.api === OMP_MODEL_API) {
        const { piWebApi, ...rest } = message;
        if (typeof piWebApi !== "string") throw new OmpError("OMP model history has no original provider API");
        return { ...rest, api: piWebApi };
      }
      return message;
    }) as Context["messages"],
  };
}

/** Private inherited pipes: no HTTP listener, temporary credentials, or copied auth files. */
export class OmpModelBridge {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly requests = new Map<string, AbortController>();
  private readonly updates = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  constructor(private readonly rpc: OmpRpc, private source: ProjectModels) {
    this.output = rpc.child.stdio[3] as Writable;
    this.input = rpc.child.stdio[4] as Readable;
    readJsonLines(this.input, (frame) => {
      if (typeof frame.id !== "string") throw new Error("Invalid OMP model request id");
      if (frame.type === "models_ready") {
        const update = this.updates.get(frame.id);
        if (update) { clearTimeout(update.timer); this.updates.delete(frame.id); update.resolve(); }
      } else if (frame.type === "cancel") this.requests.get(frame.id)?.abort();
      else if (frame.type === "request") void this.stream(frame);
      else throw new Error("Unknown OMP model pipe frame");
    }, (error) => rpc.fail(error), 64 * 1024 * 1024);
    this.output.on("error", (error) => rpc.fail(error));
    this.input.on("end", () => { if (!this.closed) rpc.fail(new Error("OMP model pipe ended unexpectedly")); });
    rpc.exits.add(() => this.close());
  }
  private write(frame: Frame): void {
    if (!this.closed && this.output.writable) this.output.write(JSON.stringify(frame) + "\n");
  }
  async configure(source = this.source): Promise<void> {
    this.source = source;
    const id = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.updates.delete(id); reject(new Error("OMP model registration timed out")); }, 30_000);
      this.updates.set(id, { resolve, reject, timer });
      this.write({ type: "models", id, models: ompModelMetadata(source) });
    });
  }
  private async stream(frame: Frame): Promise<void> {
    const id = String(frame.id);
    if (this.requests.has(id)) { this.rpc.fail(new Error("Duplicate OMP model request id")); return; }
    const controller = new AbortController();
    this.requests.set(id, controller);
    try {
      const source = this.source;
      const model = selectedOmpModel(source, String(frame.provider), String(frame.modelId));
      const liveModel = source.runtime.getModel(model.provider, model.id);
      if (!liveModel) throw new Error("Provider is not registered in the Pi model runtime");
      const rawOptions = object(frame.options);
      const options: ModelsSimpleStreamOptions = {
        signal: controller.signal,
        transport: source.settings.getTransport(),
        thinkingBudgets: source.settings.getThinkingBudgets(),
        ...(typeof rawOptions.reasoning === "string" ? { reasoning: rawOptions.reasoning as ModelsSimpleStreamOptions["reasoning"] } : {}),
        ...(typeof rawOptions.temperature === "number" ? { temperature: rawOptions.temperature } : {}),
        ...(typeof rawOptions.maxTokens === "number" ? { maxTokens: rawOptions.maxTokens } : {}),
        ...(typeof rawOptions.sessionId === "string" ? { sessionId: rawOptions.sessionId } : {}),
      };
      // Pi's provider handles api/baseUrl/headers, live !commands, OAuth refresh,
      // sampling/compat overrides, ambient auth, and custom provider implementations.
      let terminal = false;
      for await (const event of source.runtime.streamSimple(liveModel, piModelContext(frame.context), options)) {
        if (this.closed || controller.signal.aborted) break;
        if (event.type === "done" || event.type === "error") terminal = true;
        if (event.type === "error") {
          // Remote error bodies can echo request credentials. Keep status, never raw bodies.
          const status = event.error.errorMessage?.match(/\b(?:401|403|404|408|413|429|5\d\d)\b/)?.[0];
          event.error.errorMessage = `${model.provider}/${model.id}: model request failed${status ? ` (HTTP ${status})` : ""}. Check Pi model configuration and authentication.`;
        }
        this.write({ id, event });
      }
      if (!terminal && !controller.signal.aborted) this.write({ id, error: "Pi model stream ended without a terminal response" });
    } catch (error) {
      this.write({ id, error: error instanceof OmpError ? error.message : "Pi model request failed. Check Settings → Models and provider authentication." });
    } finally { this.requests.delete(id); }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
    for (const update of this.updates.values()) { clearTimeout(update.timer); update.reject(new Error("OMP model pipe closed")); }
    this.updates.clear();
    this.output.end();
  }
}

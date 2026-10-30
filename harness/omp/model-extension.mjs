// Loaded by the native OMP CLI, not imported by Next.js or the browser.
// fd 3 receives model metadata/events; fd 4 sends model requests/cancellation.
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";

const API = "coding-agent-web-models";

export default async function webModels(omp) {
  const input = createInterface({ input: createReadStream(null, { fd: 3, autoClose: false }) });
  const output = createWriteStream(null, { fd: 4, autoClose: false });
  const pending = new Map();
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => rejectReady(new Error("Web model configuration timed out")), 30_000);
  const send = (frame) => output.write(JSON.stringify(frame) + "\n");
  const fail = (request, message, aborted = false) => {
    request.stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: {
      role: "assistant", content: [], api: API, provider: request.model.provider, model: request.model.id,
      timestamp: Date.now(), stopReason: aborted ? "aborted" : "error", errorMessage: message,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } });
    request.stream.end();
    request.cleanup();
  };
  const streamSimple = (model, context, options = {}) => {
    const id = crypto.randomUUID();
    const stream = createAssistantMessageEventStream();
    const abort = () => {
      if (!pending.delete(id)) return;
      send({ type: "cancel", id });
      fail(request, "Aborted", true);
    };
    const request = { stream, model, cleanup: () => options.signal?.removeEventListener("abort", abort) };
    pending.set(id, request);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    else send({ type: "request", id, provider: model.provider, modelId: model.id, context,
      options: { reasoning: options.reasoning, temperature: options.temperature, maxTokens: options.maxTokens, sessionId: options.sessionId, toolChoice: options.toolChoice } });
    return stream;
  };
  const register = (frame) => {
    const providers = new Map();
    for (const model of frame.models) {
      if (!providers.has(model.provider)) providers.set(model.provider, []);
      providers.get(model.provider).push(model);
    }
    for (const [provider, models] of providers) omp.registerProvider(provider, {
      api: API, apiKey: "web-private-model-pipe", baseUrl: "http://127.0.0.1", models, streamSimple,
    });
    send({ type: "models_ready", id: frame.id });
    resolveReady();
  };
  input.on("line", (line) => {
    try {
      const frame = JSON.parse(line);
      if (frame.type === "models") { register(frame); return; }
      const request = pending.get(frame.id);
      if (!request) return;
      if (frame.error) { pending.delete(frame.id); fail(request, frame.error); return; }
      const event = frame.event;
      // Keep OMP on this transport while preserving the real API for lossless Pi replay.
      for (const key of ["partial", "message", "error"]) if (event[key]?.role === "assistant") {
        event[key].piWebApi = event[key].api;
        event[key].api = API;
      }
      request.stream.push(event);
      if (event.type === "done" || event.type === "error") {
        pending.delete(frame.id);
        request.cleanup();
        request.stream.end();
      }
    } catch (error) {
      rejectReady(error);
      for (const request of pending.values()) fail(request, "Invalid web model frame");
      pending.clear();
    }
  });
  const disconnect = () => {
    clearTimeout(timer);
    rejectReady(new Error("Web model pipe closed"));
    for (const request of pending.values()) fail(request, "Web model pipe closed");
    pending.clear();
  };
  input.on("close", disconnect);
  input.on("error", disconnect);
  output.on("error", disconnect);
  try { await ready; } finally { clearTimeout(timer); }
}

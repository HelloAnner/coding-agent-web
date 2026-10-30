import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentMessage, AssistantContentBlock, ImageContent, TextContent } from "../../lib/types";
import { mergeSessionStats } from "../../lib/session-stats";
import { ompDataDir, ompSessionsRoot, OMP_ID } from "./index";
import { object, OmpError, type Frame } from "./rpc";

export type OmpMessage = AgentMessage & { nativeId: string };
function image(block: Frame, blobs: string | undefined): ImageContent | null {
  let data = typeof block.data === "string" ? block.data : undefined;
  const mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  if (data?.startsWith("blob:sha256:")) {
    if (!blobs || !/^blob:sha256:[0-9a-f]{64}$/.test(data)) return null;
    try {
      const file = realpathSync(path.join(blobs, data.slice(12)));
      if (!file.startsWith(realpathSync(blobs) + path.sep) || statSync(file).size > 8 * 1024 * 1024) return null;
      data = readFileSync(file, "utf8");
    } catch { return null; }
  }
  if (data && mime?.startsWith("image/")) return { type: "image", source: { type: "base64", data, media_type: mime } };
  const source = object(block.source);
  return source.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string"
    ? { type: "image", source: { type: "base64", data: source.data, media_type: source.media_type } } : null;
}
export function ompContent(raw: unknown, blobs?: string): AssistantContentBlock[] {
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((rawBlock): AssistantContentBlock[] => {
    const block = object(rawBlock);
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block.type === "thinking" && typeof block.thinking === "string") return [{ type: "thinking", thinking: block.thinking }];
    if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") return [{ type: "toolCall", toolCallId: block.id, toolName: block.name, input: object(block.arguments) }];
    if (block.type === "image") {
      const value = image(block, blobs);
      return value ? [value] : [{ type: "text", text: "[OMP image attachment unavailable]" }];
    }
    return [];
  });
}
export function ompMessage(raw: unknown, id: string, blobs?: string): OmpMessage | null {
  const message = object(raw);
  const content = ompContent(message.content, blobs);
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;
  if (message.role === "assistant") return { role: "assistant", nativeId: id, content,
    provider: String(message.provider ?? ""), model: String(message.model ?? ""), timestamp,
    stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
    errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
    ...(message.usage ? { usage: message.usage as Extract<AgentMessage, { role: "assistant" }>["usage"] } : {}),
  };
  const visible = content.filter((block): block is TextContent | ImageContent => block.type === "text" || block.type === "image");
  if (message.role === "user") return { role: "user", nativeId: id, timestamp, content: typeof message.content === "string" ? message.content : visible };
  if (message.role === "toolResult" && typeof message.toolCallId === "string") return { role: "toolResult", nativeId: id, timestamp, content: visible, toolCallId: message.toolCallId, toolName: String(message.toolName ?? ""), isError: message.isError === true, details: message.details };
  if (message.role === "custom" && message.display !== false) return { role: "custom", nativeId: id, timestamp, content: visible, customType: String(message.customType ?? "omp"), display: true };
  if (message.role === "bashExecution") return { role: "bashExecution", nativeId: id, timestamp, command: String(message.command ?? ""), output: String(message.output ?? ""), exitCode: typeof message.exitCode === "number" ? message.exitCode : undefined, cancelled: message.cancelled === true };
  return null;
}

export function validateOmpPath(webId: string, file: string): string {
  if (!OMP_ID.test(webId)) throw new OmpError("Invalid OMP session id");
  const root = realpathSync(path.join(ompSessionsRoot(), webId));
  const real = realpathSync(file);
  if (!root.startsWith(realpathSync(ompSessionsRoot()) + path.sep) || !real.startsWith(root + path.sep) || path.extname(real) !== ".jsonl") throw new OmpError("OMP session path escapes its conversation", 403);
  return real;
}

export function parseOmpTranscript(text: string, blobs?: string) {
  const records: Frame[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    try { records.push(object(JSON.parse(line))); }
    catch { if (index === lines.length - 1 && !text.endsWith("\n")) break; throw new OmpError("OMP session history is damaged"); }
  }
  if (records[0]?.type === "title") records.shift();
  const header = records.shift();
  if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") throw new OmpError("OMP session history has no valid header");
  const entries = records.filter((entry) => typeof entry.id === "string");
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: Frame[] = [];
  const visited = new Set<unknown>();
  for (let entry = entries.at(-1); entry; entry = byId.get(entry.parentId)) {
    if (visited.has(entry.id)) throw new OmpError("OMP session history contains a parent cycle");
    visited.add(entry.id); branch.push(entry);
    if (entry.parentId === null) break;
    if (!byId.has(entry.parentId)) throw new OmpError("OMP session history has a missing parent");
  }
  const messages: OmpMessage[] = [];
  let model: { provider: string; modelId: string } | null = null;
  let thinkingLevel = "off";
  for (const entry of branch.reverse()) {
    if (entry.type === "model_change" && (!entry.role || entry.role === "default") && typeof entry.model === "string") {
      const slash = entry.model.indexOf("/");
      if (slash > 0) model = { provider: entry.model.slice(0, slash), modelId: entry.model.slice(slash + 1) };
    }
    if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") thinkingLevel = entry.thinkingLevel;
    if (entry.type === "reset_boundary") messages.length = 0;
    const message = entry.type === "message" ? ompMessage(entry.message, String(entry.id), blobs)
      : entry.type === "custom_message" ? ompMessage({ ...entry, role: "custom" }, String(entry.id), blobs)
        : (entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string"
          ? { role: "custom" as const, nativeId: String(entry.id), customType: entry.type, display: true, content: entry.summary } : null;
    if (message) {
      messages.push(message);
      if (message.role === "assistant" && message.provider && message.model) model = { provider: message.provider, modelId: message.model };
    }
  }
  return { header, messages, model, thinkingLevel, leafId: String(entries.at(-1)?.id ?? "") || null, stats: mergeSessionStats(undefined, [], messages) };
}
export function readOmpTranscript(webId: string, file: string) {
  const real = validateOmpPath(webId, file);
  // ponytail: one bounded native journal per read; add a paged reader if long chats reach this ceiling.
  if (statSync(real).size > 64 * 1024 * 1024) throw new OmpError("OMP history exceeds the 64 MiB reader limit", 413);
  return { path: real, ...parseOmpTranscript(readFileSync(real, "utf8"), path.join(ompDataDir(), "blobs")) };
}

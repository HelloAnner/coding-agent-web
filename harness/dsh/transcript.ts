import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, ImageContent, TextContent } from "@/lib/types";
import { dshHome } from "./index";

/**
 * The kernel's own session log -> the message list this app renders.
 *
 * `<DSH_HOME>/sessions/--<cwd>--/<id>/session.v<N>.jsonl[.zstd]` is one durable
 * event per line. The compressed form appends one Zstandard frame per flush, so
 * a whole file is several frames back to back. Only these events are a chat:
 *
 *   user/message       source.kind === "user"; the rest are kernel envelopes
 *   assistant/message  reasoning, text, and tool-call blocks, one per step
 *   tool/result        the model-facing result of one call
 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const PROVIDER = "dsh";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (isObject(part) && typeof part.text === "string" ? part.text : "")).join("");
}

/** Tool-call arguments are a JSON string in the log. */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (isObject(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isObject(parsed)) return parsed;
    } catch {
      return { arguments: raw };
    }
  }
  return {};
}

/**
 * The kernel keeps image bytes in `DSH_HOME/attachments/v1/objects/<aa>/<hex>`
 * and writes a content-addressed reference into the log. Read it back so a
 * reloaded chat still shows the image.
 */
function imageContent(block: Record<string, unknown>): ImageContent | null {
  const attachment = isObject(block.attachment) ? block.attachment : block;
  const id = typeof attachment.attachmentId === "string" ? attachment.attachmentId : "";
  const match = /^sha256:([0-9a-f]{64})$/.exec(id);
  if (!match) return null;
  const mediaType = typeof attachment.mediaType === "string" ? attachment.mediaType : "image/png";
  const file = path.join(dshHome(), "attachments", "v1", "objects", match[1].slice(0, 2), match[1]);
  try {
    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: readFileSync(file).toString("base64") },
    };
  } catch {
    return null;
  }
}

/** A user message is text, or text mixed with images once either is present. */
function userContent(content: unknown): string | (TextContent | ImageContent)[] | null {
  if (typeof content === "string") return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  const blocks: (TextContent | ImageContent)[] = [];
  for (const part of content) {
    if (!isObject(part)) continue;
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      const image = imageContent(part);
      if (image) blocks.push(image);
    }
  }
  if (blocks.length === 0) return null;
  return blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks;
}

/**
 * Join the frames of one log. Splitting on the frame magic is enough because
 * the kernel only appends whole frames; a torn final frame is dropped.
 * ponytail: a false magic inside compressed bytes would cost the tail. Use the
 * kernel's persistence backend if that ever shows up in a real log.
 */
export function decompressFrames(buffer: Buffer): Buffer {
  const offsets: number[] = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) offsets.push(i);
  }
  if (offsets.length <= 1) {
    try {
      return zstdDecompressSync(buffer);
    } catch {
      return Buffer.alloc(0);
    }
  }
  const parts: Buffer[] = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const frame = buffer.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : buffer.length);
    try {
      parts.push(zstdDecompressSync(frame));
    } catch {
      /* a frame still being written */
    }
  }
  return Buffer.concat(parts);
}

/** The newest generation the kernel wrote for one session. */
function logFile(sessionDir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(sessionDir);
  } catch {
    return null;
  }
  const logs = names
    .map((name) => ({ name, version: /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name) }))
    .filter((entry): entry is { name: string; version: RegExpExecArray } => entry.version !== null)
    .map((entry) => ({ name: entry.name, version: Number(entry.version[1] ?? 0) }));
  if (logs.length === 0) return null;
  logs.sort((a, b) => b.version - a.version || Number(b.name.endsWith(".zstd")) - Number(a.name.endsWith(".zstd")));
  return path.join(sessionDir, logs[0].name);
}

export interface DshTranscript {
  messages: AgentMessage[];
  /** True when the kernel has a log for this session directory. */
  exists: boolean;
  path: string | null;
  model: string | null;
}

/** Read one kernel session. A chat that has not run a turn yet has no log. */
export function readDshTranscript(sessionDir: string): DshTranscript {
  const file = logFile(sessionDir);
  if (!file) return { messages: [], exists: false, path: null, model: null };

  let text: string;
  try {
    const raw = readFileSync(file);
    text = (file.endsWith(".zstd") ? decompressFrames(raw) : raw).toString("utf8");
  } catch {
    return { messages: [], exists: false, path: file, model: null };
  }

  const messages: AgentMessage[] = [];
  const toolNames = new Map<string, string>();
  let model: string | null = null;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const data = isObject(record.data) ? record.data : null;
    const time = typeof record.time === "number" ? record.time : undefined;
    if (!data) continue;

    switch (record.type) {
      case "user/message": {
        const source = isObject(data.source) ? data.source : null;
        if (source?.kind !== "user") break;
        const content = userContent(data.content);
        if (!content) break;
        messages.push({ role: "user", content, ...(time ? { timestamp: time } : {}) });
        break;
      }
      case "assistant/message": {
        const message = isObject(data.message) ? data.message : null;
        if (!message) break;
        const source = isObject(message.source) ? message.source : null;
        if (typeof source?.model === "string" && source.model) model = source.model;
        const content: AssistantContentBlock[] = [];
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (!isObject(block)) continue;
          if (block.type === "reasoning" && typeof block.text === "string" && block.text.trim()) {
            content.push({ type: "thinking", thinking: block.text });
          } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            content.push({ type: "text", text: block.text });
          } else if (block.type === "image") {
            const image = imageContent(block);
            if (image) content.push(image);
          } else if (block.type === "tool-call" && typeof block.id === "string") {
            const name = typeof block.name === "string" ? block.name : "tool";
            toolNames.set(block.id, name);
            content.push({ type: "toolCall", toolCallId: block.id, toolName: name, input: parseArguments(block.arguments) });
          }
        }
        if (content.length === 0) break;
        const assistant: AssistantMessage = {
          role: "assistant",
          content,
          model: model ?? PROVIDER,
          provider: PROVIDER,
          ...(time ? { timestamp: time } : {}),
        };
        messages.push(assistant);
        break;
      }
      case "tool/result": {
        const message = isObject(data.message) ? data.message : null;
        const toolCallId = typeof message?.toolCallId === "string" ? message.toolCallId : "";
        if (!toolCallId) break;
        messages.push({
          role: "toolResult",
          toolCallId,
          toolName: toolNames.get(toolCallId),
          content: [{ type: "text", text: textOf(message?.content) }],
          ...(message?.isError === true ? { isError: true } : {}),
          ...(time ? { timestamp: time } : {}),
        });
        break;
      }
      default:
        break;
    }
  }

  return { messages, exists: true, path: file, model };
}

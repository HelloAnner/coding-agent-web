import type { AgentMessage, AssistantContentBlock, AssistantMessage, ImageContent, TextContent } from "@/lib/types";

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
export function nativeText(value: unknown): string {
  return typeof value === "string" ? value : records(value).map((part) => typeof part.text === "string" ? part.text : "").join("");
}
export interface NativeEvent { type: string; seq: number; time: number; data: unknown; surfaceOp?: unknown }
export interface NativeSnapshot {
  type: "snapshot";
  header: { id: string; cwd?: string };
  cursor: number;
  records: { type: "event"; event: NativeEvent }[];
  hasMore: boolean;
  projections: { asOfSeq: number; values: Record<string, unknown> };
}

function argumentsOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return record(value);
  try { return record(JSON.parse(value)); } catch { return { arguments: value }; }
}

/** Wire references are read through the native Attachment service, never through arbitrary local paths. */
export async function nativeContent(value: unknown, image: (id: string) => Promise<ImageContent | null>): Promise<(TextContent | ImageContent)[]> {
  if (typeof value === "string") return [{ type: "text", text: value }];
  const content: (TextContent | ImageContent)[] = [];
  for (const part of records(value)) {
    if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
    else if (part.type === "image") {
      const id = record(part.attachment).attachmentId ?? part.attachmentId;
      const loaded = typeof id === "string" ? await image(id) : null;
      content.push(loaded ?? { type: "text", text: "[dsh image unavailable]" });
    }
  }
  return content;
}

/** A durable native record projected for the shared renderer; no second transcript is persisted. */
export async function nativeMessage(event: NativeEvent, image: (id: string) => Promise<ImageContent | null>): Promise<AgentMessage | null> {
  const data = record(event.data);
  const message = record(data.message);
  const source = record(message.source);
  if (event.type === "user/message" && record(data.source).kind === "user") {
    const content = await nativeContent(data.content, image);
    return { role: "user", content: content.length === 1 && content[0].type === "text" ? content[0].text : content, timestamp: event.time };
  }
  if (event.type === "assistant/message" || event.type === "assistant/attempt") {
    const content: AssistantContentBlock[] = [];
    for (const part of records(message.content)) {
      if (part.type === "reasoning" && typeof part.text === "string") content.push({ type: "thinking", thinking: part.text });
      else if (part.type === "tool-call" && typeof part.id === "string" && typeof part.name === "string") content.push({ type: "toolCall", toolCallId: part.id, toolName: part.name, input: argumentsOf(part.arguments) });
      else content.push(...await nativeContent([part], image));
    }
    if (!content.length) return null;
    const usage = record(data.usage);
    return { role: "assistant", content, model: typeof source.model === "string" ? source.model : "dsh", provider: typeof source.provider === "string" ? source.provider : "dsh", timestamp: event.time,
      ...(typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number" ? { usage: { input: usage.inputTokens, output: usage.outputTokens } } : {}),
      ...(event.type === "assistant/attempt" ? { stopReason: "error" } : {}),
    } as AssistantMessage;
  }
  if (event.type === "tool/result" && typeof message.toolCallId === "string") {
    return { role: "toolResult", toolCallId: message.toolCallId, content: await nativeContent(message.content, image), isError: message.isError === true, timestamp: event.time };
  }
  return null;
}

/** Apply native surface replacements before projecting history (e.g. compaction/rewrite). */
export function nativeSurface(events: NativeEvent[]): NativeEvent[] {
  const surface: NativeEvent[] = [];
  for (const event of events) {
    const op = record(event.surfaceOp);
    if (op.op === "replace" && typeof op.startSeq === "number" && typeof op.endSeq === "number") {
      const start = surface.findIndex((item) => item.seq >= (op.startSeq as number));
      if (start !== -1) {
        const end = surface.findIndex((item) => item.seq > (op.endSeq as number));
        surface.splice(start, (end === -1 ? surface.length : end) - start, event);
        continue;
      }
    }
    if (event.type === "user/message" || event.type === "assistant/message" || event.type === "tool/result") surface.push(event);
  }
  return surface;
}

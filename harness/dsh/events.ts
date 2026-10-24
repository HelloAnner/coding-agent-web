import type { AgentEventLike } from "@/lib/agent-event-wire";
import type { AgentMessage, AssistantContentBlock, AssistantMessage } from "@/lib/types";

/**
 * ACP `session/update` -> the agent-event vocabulary this app's chat renders.
 *
 *   agent_message_chunk   -> message_update text_start / text_delta / text_end
 *   agent_thought_chunk   -> message_update thinking_*
 *   tool_call             -> toolcall_start + toolcall_end, tool_execution_start
 *   tool_call_update      -> tool_execution_end + a toolResult message
 *   (turn settles)        -> message_end, agent_end, agent_settled
 *
 * The kernel commits whole assistant messages, so a chunk is one committed
 * block, not one token. A new `messageId` closes the previous bubble: dsh keeps
 * one assistant message per model step, exactly like a pi step.
 */
const PROVIDER = "dsh";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!isObject(content)) return "";
  if (content.type === "text" && typeof content.text === "string") return content.text;
  return "";
}

/** ACP tool results arrive as `[{ type: "content", content: { type: "text" } }]`. */
function toolResultText(content: unknown): string {
  if (!Array.isArray(content)) return textOf(content);
  return content.map((part) => (isObject(part) ? textOf(part.content) : "")).join("");
}

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

export class DshEventMapper {
  private readonly content: AssistantContentBlock[] = [];
  private openBlock: { kind: "text" | "thinking"; index: number } | null = null;
  private assistantOpen = false;
  /** The kernel's id for the committed assistant message being rendered. */
  private messageId: string | null = null;
  private readonly toolNames = new Map<string, string>();
  private readonly finishedTools = new Set<string>();

  constructor(
    private readonly model: string,
    private readonly emit: (event: AgentEventLike) => void,
  ) {}

  /** Feed one `session/update`. Unknown variants are ignored on purpose. */
  push(update: Record<string, unknown>): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (isObject(update.content) && update.content.type === "image") this.image(update);
        else this.chunk("text", update);
        return;
      case "agent_thought_chunk":
        this.chunk("thinking", update);
        return;
      case "tool_call":
        this.toolCall(update);
        return;
      case "tool_call_update":
        this.toolCallUpdate(update);
        return;
      default:
        return;
    }
  }

  /** Close whatever is still open. Safe to call twice. */
  finish(stopReason?: string): void {
    this.closeBlock();
    this.closeAssistant(stopReason);
  }

  private ensureAssistant(): void {
    if (this.assistantOpen) return;
    this.assistantOpen = true;
    this.emit({
      type: "message_start",
      message: { role: "assistant", content: [], model: this.model, provider: PROVIDER } as AssistantMessage,
    });
  }

  private chunk(kind: "text" | "thinking", update: Record<string, unknown>): void {
    const delta = textOf(update.content);
    if (!delta) return;
    const messageId = typeof update.messageId === "string" ? update.messageId : "";
    if (messageId && this.messageId && messageId !== this.messageId) this.closeAssistant();
    if (messageId) this.messageId = messageId;
    this.ensureAssistant();
    if (this.openBlock?.kind !== kind) {
      this.closeBlock();
      this.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
      this.openBlock = { kind, index: this.content.length - 1 };
      this.emit({
        type: "message_update",
        assistantMessageEvent: { type: kind === "text" ? "text_start" : "thinking_start", contentIndex: this.openBlock.index },
      });
    }
    const block = this.content[this.openBlock.index];
    if (block.type === "text") block.text += delta;
    else if (block.type === "thinking") block.thinking += delta;
    this.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: kind === "text" ? "text_delta" : "thinking_delta",
        contentIndex: this.openBlock.index,
        delta,
      },
    });
  }

  /** A committed image block. It renders with the message_end, not as a delta. */
  private image(update: Record<string, unknown>): void {
    const content = isObject(update.content) ? update.content : null;
    const data = typeof content?.data === "string" ? content.data : "";
    if (!data) return;
    const messageId = typeof update.messageId === "string" ? update.messageId : "";
    if (messageId && this.messageId && messageId !== this.messageId) this.closeAssistant();
    if (messageId) this.messageId = messageId;
    this.ensureAssistant();
    this.closeBlock();
    this.content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: typeof content?.mimeType === "string" ? content.mimeType : "image/png",
        data,
      },
    });
  }

  private closeBlock(): void {
    const open = this.openBlock;
    if (!open) return;
    this.openBlock = null;
    const block = this.content[open.index];
    this.emit({
      type: "message_update",
      assistantMessageEvent: open.kind === "text"
        ? { type: "text_end", contentIndex: open.index, content: block.type === "text" ? block.text : "" }
        : { type: "thinking_end", contentIndex: open.index, content: block.type === "thinking" ? block.thinking : "" },
    });
  }

  private toolCall(update: Record<string, unknown>): void {
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
    if (!toolCallId) return;
    const toolName = typeof update.title === "string" && update.title ? update.title : "tool";
    this.ensureAssistant();
    this.closeBlock();
    this.toolNames.set(toolCallId, toolName);
    const input = parseArguments(update.rawInput);
    this.content.push({ type: "toolCall", toolCallId, toolName, input });
    const contentIndex = this.content.length - 1;
    this.emit({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex, id: toolCallId, toolName },
    });
    this.emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex,
        toolCall: { id: toolCallId, name: toolName, arguments: input },
      },
    });
    this.emit({ type: "tool_execution_start", toolCallId, toolName });
  }

  private toolCallUpdate(update: Record<string, unknown>): void {
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
    const status = typeof update.status === "string" ? update.status : "";
    if (!toolCallId || this.finishedTools.has(toolCallId)) return;
    if (status !== "completed" && status !== "failed") return;

    this.finishedTools.add(toolCallId);
    const toolName = this.toolNames.get(toolCallId) ?? "tool";
    const isError = status === "failed";
    this.emit({ type: "tool_execution_end", toolCallId, toolName, isError });
    // pi appends the assistant message, then its tool results.
    this.closeAssistant();
    const result: AgentMessage = {
      role: "toolResult",
      toolCallId,
      toolName,
      content: [{ type: "text", text: toolResultText(update.content) }],
      isError,
    };
    this.emit({ type: "message_start", message: result });
    this.emit({ type: "message_end", message: result });
  }

  private closeAssistant(stopReason?: string): void {
    if (!this.assistantOpen) return;
    this.closeBlock();
    this.assistantOpen = false;
    this.messageId = null;
    const message: AssistantMessage = {
      role: "assistant",
      content: this.content.length > 0 ? [...this.content] : [{ type: "text", text: "" }],
      model: this.model,
      provider: PROVIDER,
      ...(stopReason ? { stopReason } : {}),
      timestamp: Date.now(),
    };
    this.content.length = 0;
    this.emit({ type: "message_end", message });
  }
}

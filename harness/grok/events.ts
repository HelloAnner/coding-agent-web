import type { AgentEventLike } from "@/lib/agent-event-wire";
import type { AgentMessage, AssistantContentBlock, AssistantMessage } from "@/lib/types";

/**
 * Grok's headless NDJSON (`--output-format streaming-json`) -> the agent-event
 * vocabulary this app's chat already renders.
 *
 *   text               -> message_update text_start / text_delta / text_end
 *   thought            -> message_update thinking_*
 *   tool_call          -> message_update toolcall_start + toolcall_end, tool_execution_start
 *   tool_call_update   -> tool_execution_update / tool_execution_end + a toolResult message
 *   end                -> message_end (if anything is open), agent_end, agent_settled
 *
 * One grok run is one prompt; the assistant message that grok keeps in its own
 * history is one model call, so this closes a message when its tool calls
 * finish instead of keeping the whole run in one bubble.
 */
const PROVIDER = "grok";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deepest useful string under the keys grok's tool outputs use. */
function outputText(value: unknown, depth = 0): string {
  if (typeof value === "string") return value;
  if (!isObject(value) || depth > 3) return "";
  for (const key of ["output_for_prompt", "content", "text", "stdout", "message"]) {
    const found = outputText(value[key], depth + 1);
    if (found.trim()) return found;
  }
  for (const child of Object.values(value)) {
    const found = outputText(child, depth + 1);
    if (found.trim()) return found;
  }
  return "";
}

function usageOf(record: Record<string, unknown>): AssistantMessage["usage"] | undefined {
  const usage = isObject(record.usage) ? record.usage : null;
  if (!usage) return undefined;
  const num = (key: string) => (typeof usage[key] === "number" ? usage[key] as number : 0);
  return {
    input: num("input_tokens"),
    output: num("output_tokens"),
    cacheRead: num("cache_read_input_tokens"),
    cacheWrite: num("cache_creation_input_tokens"),
    // Grok reports one total; pi carries per-token prices. Keep the total only.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (isObject(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isObject(parsed)) return parsed;
    } catch {
      /* a streamed call whose arguments are still invalid JSON */
    }
  }
  return {};
}

export class GrokEventMapper {
  private readonly content: AssistantContentBlock[] = [];
  private openBlock: { kind: "text" | "thinking"; index: number } | null = null;
  private assistantOpen = false;
  private readonly toolNames = new Map<string, string>();
  private readonly finishedTools = new Set<string>();
  private usage: AssistantMessage["usage"];
  private stopReason: string | undefined;

  constructor(
    private readonly model: string,
    private readonly emit: (event: AgentEventLike) => void,
  ) {}

  /** Feed one NDJSON line. Unknown record types are ignored on purpose. */
  push(record: Record<string, unknown>): void {
    switch (record.type) {
      case "text":
        this.appendBlock("text", typeof record.data === "string" ? record.data : "");
        return;
      case "thought":
        this.appendBlock("thinking", typeof record.data === "string" ? record.data : "");
        return;
      case "usage":
        this.usage = usageOf(record) ?? this.usage;
        return;
      case "tool_call":
        this.toolCall(record);
        return;
      case "tool_call_update":
        this.toolCallUpdate(record);
        return;
      case "end":
        if (typeof record.stopReason === "string") this.stopReason = record.stopReason;
        this.usage = usageOf(record) ?? this.usage;
        return;
      default:
        return;
    }
  }

  /** Close whatever is still open. Safe to call twice. */
  finish(aborted = false): void {
    this.closeBlock();
    this.closeAssistant(aborted ? "aborted" : this.stopReason);
  }

  private ensureAssistant(): void {
    if (this.assistantOpen) return;
    this.assistantOpen = true;
    this.emit({
      type: "message_start",
      message: { role: "assistant", content: [], model: this.model, provider: PROVIDER } as AssistantMessage,
    });
  }

  private appendBlock(kind: "text" | "thinking", delta: string): void {
    if (!delta) return;
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

  private toolCall(record: Record<string, unknown>): void {
    const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "";
    const toolName = typeof record.toolName === "string" ? record.toolName : typeof record.title === "string" ? record.title : "tool";
    if (!toolCallId) return;
    this.ensureAssistant();
    this.closeBlock();
    this.toolNames.set(toolCallId, toolName);
    const input = parseArguments(record.rawInput);
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

  private toolCallUpdate(record: Record<string, unknown>): void {
    const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : "";
    if (!toolCallId || this.finishedTools.has(toolCallId)) return;
    const toolName = this.toolNames.get(toolCallId) ?? "tool";
    const status = typeof record.status === "string" ? record.status : null;
    const text = outputText(record.rawOutput);

    if (status === null) {
      // The call's input was just accepted; nothing to render yet.
      return;
    }
    if (status === "completed" || status === "failed") {
      this.finishedTools.add(toolCallId);
      this.emit({ type: "tool_execution_end", toolCallId, toolName, isError: status === "failed" });
      // pi appends the assistant message, then its tool results.
      this.closeAssistant(this.stopReason);
      const result: AgentMessage = {
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text }],
        isError: status === "failed",
      };
      this.emit({ type: "message_start", message: result });
      this.emit({ type: "message_end", message: result });
      return;
    }
    if (text) {
      this.emit({
        type: "tool_execution_update",
        toolCallId,
        toolName,
        partialResult: { content: [{ type: "text", text }] },
      });
    }
  }

  private closeAssistant(stopReason: string | undefined): void {
    if (!this.assistantOpen) return;
    this.closeBlock();
    this.assistantOpen = false;
    const message: AssistantMessage = {
      role: "assistant",
      content: this.content.length > 0 ? [...this.content] : [{ type: "text", text: "" }],
      model: this.model,
      provider: PROVIDER,
      ...(stopReason ? { stopReason } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
      timestamp: Date.now(),
    };
    this.content.length = 0;
    this.usage = undefined;
    this.emit({ type: "message_end", message });
  }
}

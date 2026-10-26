import type { AgentEventLike } from "../../lib/agent-event-wire";
import type { AssistantMessage } from "../../lib/types";
import { object } from "./index";
import { claudeAssistantContent, claudeRecordMessages, claudeStopReason, claudeUsage, type ClaudeMessage } from "./transcript";

/** Native CLI events projected onto the chat's existing wire vocabulary. */
export class ClaudeEventMapper {
  message: (AssistantMessage & { nativeId: string }) | null = null;
  readonly toolNames = new Map<string, string>();
  readonly runningTools = new Set<string>();
  private blockIndex = 0;
  private readonly jsonInputs = new Map<number, string>();
  private readonly startedTools = new Set<string>();
  private readonly finishedTools = new Set<string>();
  private compacting = false;
  private lastAssistantId = "";
  private lastAssistant: (AssistantMessage & { nativeId: string }) | null = null;

  constructor(private readonly emit: (event: AgentEventLike) => void) {}

  push(record: Record<string, unknown>): void {
    const parent = typeof record.parent_tool_use_id === "string" ? record.parent_tool_use_id : null;
    if (parent) {
      if (record.type === "assistant" && this.runningTools.has(parent)) {
        const content = claudeAssistantContent(object(record.message).content).filter((block) => block.type === "text" || block.type === "thinking");
        const text = content.map((block) => block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : "").join("\n");
        if (text) this.emit({ type: "tool_execution_update", toolCallId: parent, toolName: this.toolNames.get(parent) ?? "Agent", partialResult: { content: [{ type: "text", text }] } });
      }
      return;
    }
    if (record.type === "stream_event") { this.stream(object(record.event)); return; }
    if (record.type === "assistant") {
      const raw = object(record.message);
      const id = String(raw.id ?? record.uuid ?? "");
      const content = claudeAssistantContent(raw.content);
      if (!this.message) {
        const prior = id === this.lastAssistantId ? this.lastAssistant : null;
        const combined = prior ? [...prior.content] : [];
        for (const block of content) if (!combined.some((existing) => JSON.stringify(existing) === JSON.stringify(block))) combined.push(block);
        this.message = { role: "assistant", nativeId: id, content: combined, model: String(raw.model ?? "claude-code"), provider: "claude-code", timestamp: Date.now(), stopReason: claudeStopReason(raw.stop_reason) ?? prior?.stopReason, usage: claudeUsage(raw.usage) };
        this.emit({ type: "message_start", message: this.message });
        this.endAssistant();
      } else {
        if (content.length > 1) this.message.content = content;
        else if (content.length) this.message.content[this.blockIndex] = content[0];
        this.message.stopReason = claudeStopReason(raw.stop_reason) ?? this.message.stopReason;
        this.message.usage = claudeUsage(raw.usage) ?? this.message.usage;
        this.startTools();
      }
      return;
    }
    if (record.type === "user") {
      for (const result of claudeRecordMessages(record, this.toolNames)) {
        if (result.role !== "toolResult" || this.finishedTools.has(result.toolCallId)) continue;
        this.finishedTools.add(result.toolCallId);
        this.runningTools.delete(result.toolCallId);
        this.emit({ type: "tool_execution_end", toolCallId: result.toolCallId, toolName: result.toolName, isError: result.isError });
        this.emit({ type: "message_end", message: result });
      }
      return;
    }
    if (record.type === "system" && record.subtype === "api_retry") {
      this.emit({ type: "auto_retry_start", attempt: record.attempt, maxAttempts: record.max_retries, errorMessage: record.error });
    }
    if (record.type === "system" && record.subtype === "status") {
      if (record.status === "compacting" && !this.compacting) {
        this.compacting = true;
        this.emit({ type: "auto_compaction_start" });
      } else if (record.status !== "compacting" && this.compacting) {
        this.compacting = false;
        this.emit({ type: "auto_compaction_end", result: null });
      }
    }
  }

  private stream(event: Record<string, unknown>): void {
    const index = typeof event.index === "number" ? event.index : 0;
    if (event.type === "message_start") {
      this.endAssistant();
      const raw = object(event.message);
      this.jsonInputs.clear();
      this.message = { role: "assistant", nativeId: String(raw.id ?? ""), content: [], model: String(raw.model ?? "claude-code"), provider: "claude-code", usage: claudeUsage(raw.usage), timestamp: Date.now() };
      this.emit({ type: "message_start", message: this.message });
      return;
    }
    if (!this.message) return;
    if (event.type === "content_block_start") {
      this.blockIndex = index;
      const raw = object(event.content_block);
      const block = claudeAssistantContent([raw])[0];
      if (!block) return;
      this.message.content[index] = block;
      if (block.type === "toolCall") {
        this.toolNames.set(block.toolCallId, block.toolName);
        this.emitDelta({ type: "toolcall_start", contentIndex: index, id: block.toolCallId, toolName: block.toolName });
      } else this.emitDelta({ type: block.type === "thinking" ? "thinking_start" : "text_start", contentIndex: index });
    } else if (event.type === "content_block_delta") {
      const delta = object(event.delta);
      const block = this.message.content[index];
      if (delta.type === "text_delta" && block?.type === "text" && typeof delta.text === "string") {
        block.text += delta.text;
        this.emitDelta({ type: "text_delta", contentIndex: index, delta: delta.text });
      } else if (delta.type === "thinking_delta" && block?.type === "thinking" && typeof delta.thinking === "string") {
        block.thinking += delta.thinking;
        this.emitDelta({ type: "thinking_delta", contentIndex: index, delta: delta.thinking });
      } else if (delta.type === "input_json_delta" && block?.type === "toolCall" && typeof delta.partial_json === "string") {
        this.jsonInputs.set(index, (this.jsonInputs.get(index) ?? "") + delta.partial_json);
        this.emitDelta({ type: "toolcall_delta", contentIndex: index, id: block.toolCallId, toolName: block.toolName, delta: delta.partial_json });
      }
    } else if (event.type === "content_block_stop") {
      const block = this.message.content[index];
      if (block?.type === "toolCall") {
        const json = this.jsonInputs.get(index);
        if (json) { try { block.input = object(JSON.parse(json)); } catch { /* the complete assistant frame repairs it */ } }
        this.emitDelta({ type: "toolcall_end", contentIndex: index, toolCall: { id: block.toolCallId, name: block.toolName, arguments: block.input } });
        this.startTools();
      } else if (block?.type === "text" || block?.type === "thinking") {
        this.emitDelta({ type: block.type === "text" ? "text_end" : "thinking_end", contentIndex: index, content: block.type === "text" ? block.text : block.thinking });
      }
    } else if (event.type === "message_delta") {
      const delta = object(event.delta);
      const stopReason = claudeStopReason(delta.stop_reason);
      if (stopReason) this.message.stopReason = stopReason;
      if (event.usage && this.message.usage) this.message.usage.output = Number(object(event.usage).output_tokens ?? this.message.usage.output);
    } else if (event.type === "message_stop") this.endAssistant();
  }

  private emitDelta(assistantMessageEvent: Record<string, unknown>): void {
    this.emit({ type: "message_update", assistantMessageEvent });
  }

  private startTools(): void {
    for (const block of this.message?.content ?? []) {
      if (block.type !== "toolCall") continue;
      this.toolNames.set(block.toolCallId, block.toolName);
      if (this.startedTools.has(block.toolCallId)) continue;
      this.startedTools.add(block.toolCallId);
      this.runningTools.add(block.toolCallId);
      this.emit({ type: "tool_execution_start", toolCallId: block.toolCallId, toolName: block.toolName });
    }
  }

  private endAssistant(): void {
    if (!this.message) return;
    this.startTools();
    const message = { ...this.message, content: this.message.content.filter(Boolean) } as ClaudeMessage;
    this.lastAssistantId = message.nativeId;
    this.lastAssistant = message as AssistantMessage & { nativeId: string };
    this.message = null;
    this.emit({ type: "message_end", message });
  }

  finish(aborted = false): void {
    if (this.message && aborted) this.message.stopReason = "aborted";
    this.endAssistant();
    for (const id of this.runningTools) this.emit({ type: "tool_execution_end", toolCallId: id, toolName: this.toolNames.get(id), isError: true });
    this.runningTools.clear();
  }
}

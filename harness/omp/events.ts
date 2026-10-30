import type { AgentEventLike } from "../../lib/agent-event-wire";
import type { AssistantMessage, ExtensionUiRequest } from "../../lib/types";
import { ompMessage, type OmpMessage } from "./transcript";
import type { Frame } from "./rpc";

const UI_METHODS = new Set(["select", "confirm", "input", "editor", "notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);
export class OmpEvents {
  streamingMessage: AssistantMessage | null = null;
  readonly tools = new Map<string, AgentEventLike>();
  private serial = 0;
  private messageId = "";
  constructor(private readonly runId: string, private readonly emit: (event: AgentEventLike) => void, private readonly append: (message: OmpMessage) => void) {}
  push(frame: Frame): void {
    if (frame.type === "message_start") this.messageId = `${this.runId}:${++this.serial}`;
    if (frame.type === "message_start" || frame.type === "message_update" || frame.type === "message_end") {
      const message = ompMessage(frame.message, this.messageId);
      if (!message) return;
      if (message.role === "assistant") this.streamingMessage = frame.type === "message_end" ? null : message;
      if (frame.type === "message_end") {
        this.append(message);
        if (message.role === "assistant" && message.stopReason === "error") this.emit({ type: "prompt_error", errorMessage: message.errorMessage || "OMP model request failed" });
      }
      this.emit({ ...frame, type: String(frame.type), message });
      return;
    }
    if (frame.type === "tool_execution_start" && typeof frame.toolCallId === "string") this.tools.set(frame.toolCallId, frame as AgentEventLike);
    if (frame.type === "tool_execution_end" && typeof frame.toolCallId === "string") this.tools.delete(frame.toolCallId);
    if (frame.type === "agent_start" || String(frame.type).startsWith("tool_execution_") || String(frame.type).startsWith("auto_retry_") || String(frame.type).startsWith("auto_compaction_")) this.emit(frame as AgentEventLike);
    if (frame.type === "extension_error") this.emit({ type: "prompt_error", errorMessage: "An OMP extension failed. Check the native extension configuration." });
    if (frame.type === "notice") this.emit({ type: "extension_ui_request", id: `${this.runId}:notice:${++this.serial}`, method: "notify", message: "OMP reported a runtime or session persistence notice. Check native session storage before closing this chat.", notifyType: "warning" });
  }
  finish(): void { this.streamingMessage = null; this.tools.clear(); }
}

export function ompUiRequest(frame: Frame): ExtensionUiRequest | null {
  if (typeof frame.id !== "string" || !UI_METHODS.has(String(frame.method))) return null;
  if ((frame.method === "select" || frame.method === "confirm" || frame.method === "input" || frame.method === "editor") && typeof frame.title !== "string") return null;
  if (frame.method === "select" && (!Array.isArray(frame.options) || !frame.options.every((option) => typeof option === "string"))) return null;
  return { ...frame, ...(typeof frame.timeout === "number" ? { expiresAt: Date.now() + frame.timeout } : {}) } as unknown as ExtensionUiRequest;
}

import { randomUUID } from "node:crypto";
import type { NotesAgentEvent, NotesChatMessage } from "../types";
import { createNotesSession } from "./profile";
import { listNotesSkills } from "./skills";

/**
 * The notes agent: one pi session per server process, rooted at the notes
 * vault, with pi's `read`/`ls` plus the vault's own two tools and the skills in
 * notes/skills. The transcript the panel shows is kept here too, so a reload of
 * the page finds the conversation again; a restart starts a fresh one.
 *
 * The session is in-memory: notes conversations are not pi coding sessions, so
 * they never show up in the Coding sidebar's session list.
 */

type Session = Awaited<ReturnType<typeof createNotesSession>>["session"];

function resultText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  const text = content
    .map((block) => (typeof block === "object" && block !== null && (block as { type?: string }).type === "text"
      ? String((block as { text?: unknown }).text ?? "")
      : ""))
    .join("\n");
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

function argsText(args: unknown): string {
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

declare global {
  // The standalone panel's history is separate from every background digest.
  var __piWebNotesHistory: NotesChatMessage[] | undefined;
}

function history(): NotesChatMessage[] {
  globalThis.__piWebNotesHistory ??= [];
  return globalThis.__piWebNotesHistory;
}

export class NotesAgent {
  private readonly listeners = new Set<(event: NotesAgentEvent) => void>();
  private currentAssistantId: string | null = null;
  private busy = false;
  private unsubscribe: (() => void) | null = null;

  private constructor(
    private readonly session: Session,
    readonly modelLabel: string | null,
  ) {
    this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
  }

  static async create(): Promise<NotesAgent> {
    const { session, modelLabel } = await createNotesSession();
    return new NotesAgent(session, modelLabel);
  }

  get messages(): NotesChatMessage[] {
    return history();
  }

  get isBusy(): boolean {
    return this.busy;
  }

  onEvent(listener: (event: NotesAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string): Promise<void> {
    if (this.busy) throw new Error("上一条消息还在处理中");
    this.busy = true;
    this.currentAssistantId = null;
    const message: NotesChatMessage = { id: randomUUID(), role: "user", text };
    history().push(message);
    this.emit({ type: "message", message });
    try {
      await this.session.prompt(text);
    } catch (error) {
      this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.busy = false;
      this.emit({ type: "done" });
    }
  }

  async abort(): Promise<void> {
    if (!this.busy) return;
    await this.session.abort();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
    this.session.dispose();
  }

  private emit(event: NotesAgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A closed stream must not stop the run; the transcript still records it.
      }
    }
  }

  private assistant(): NotesChatMessage | null {
    return history().find((message) => message.id === this.currentAssistantId) ?? null;
  }

  private startAssistant(): NotesChatMessage {
    const message: NotesChatMessage = { id: randomUUID(), role: "assistant", text: "" };
    history().push(message);
    this.currentAssistantId = message.id;
    this.emit({ type: "assistant_start", id: message.id });
    return message;
  }

  private handleEvent(event: { type: string; [key: string]: unknown }): void {
    if (event.type === "message_start") {
      const role = (event.message as { role?: unknown } | undefined)?.role;
      if (role === "assistant") this.startAssistant();
      return;
    }
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
      if (typeof delta?.delta !== "string") return;
      if (delta.type === "text_delta") {
        const message = this.assistant() ?? this.startAssistant();
        message.text += delta.delta;
        this.emit({ type: "text", delta: delta.delta });
      } else if (delta.type === "thinking_delta") {
        const message = this.assistant() ?? this.startAssistant();
        message.thinking = `${message.thinking ?? ""}${delta.delta}`;
        this.emit({ type: "thinking", delta: delta.delta });
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      const message = this.assistant() ?? this.startAssistant();
      const tool = {
        id: String(event.toolCallId),
        name: String(event.toolName),
        args: argsText(event.args),
        status: "running" as const,
      };
      message.tools = [...(message.tools ?? []), tool];
      this.emit({ type: "tool_start", tool });
      return;
    }
    if (event.type === "tool_execution_end") {
      const id = String(event.toolCallId);
      const status = event.isError === true ? "error" as const : "done" as const;
      const output = resultText(event.result);
      for (const message of history()) {
        const tool = message.tools?.find((item) => item.id === id);
        if (!tool) continue;
        tool.status = status;
        tool.output = output;
        break;
      }
      this.emit({ type: "tool_end", id, status, output });
    }
  }
}

declare global {
  // Survives a Next dev reload; one session for the standalone notes panel.
  var __piWebNotesAgent: { promise: Promise<NotesAgent>; agent: NotesAgent | null } | undefined;
}

/** The process's notes agent, built on first use. */
export function getNotesAgent(): Promise<NotesAgent> {
  if (!globalThis.__piWebNotesAgent) {
    const entry: { promise: Promise<NotesAgent>; agent: NotesAgent | null } = {
      promise: NotesAgent.create(),
      agent: null,
    };
    entry.promise.then(
      (agent) => { entry.agent = agent; },
      () => {
        // A failed build is not kept: the next prompt tries again.
        if (globalThis.__piWebNotesAgent === entry) globalThis.__piWebNotesAgent = undefined;
      },
    );
    globalThis.__piWebNotesAgent = entry;
  }
  return globalThis.__piWebNotesAgent.promise;
}

/** An existing agent without building one: GET must stay cheap. */
export function peekNotesAgent(): NotesAgent | null {
  return globalThis.__piWebNotesAgent?.agent ?? null;
}

/** Skills the agent can load, for the panel and the settings dialog. */
export { listNotesSkills };

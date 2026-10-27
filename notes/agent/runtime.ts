import { createAgentSessionFromServices, createAgentSessionServices, getAgentDir, SessionManager, SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { NotesAgentEvent, NotesAgentModelSettings, NotesChatMessage } from "../types";
import { notesRoot } from "../files";
import { readNotesSettings } from "./settings";
import { listNotesSkills, notesSkillsDir } from "./skills";
import { NOTES_SYSTEM_PROMPT } from "./system-prompt";
import { NOTES_BOARD_TOOL, NOTES_WRITE_TOOL, notesAgentTools } from "./tools";

/**
 * The notes agent: one pi session per server process, rooted at the notes
 * vault, with pi's `read`/`ls` plus the vault's own two tools and the skills in
 * notes/skills. The transcript the panel shows is kept here too, so a reload of
 * the page finds the conversation again; a restart starts a fresh one.
 *
 * The session is in-memory: notes conversations are not pi coding sessions, so
 * they never show up in the Coding sidebar's session list.
 */

export const NOTES_AGENT_PROVIDER = "notes";

type Session = Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];

/** Only what the agent may call: reading the vault and writing notes/boards. */
const AGENT_TOOLS = ["read", "ls", NOTES_WRITE_TOOL, NOTES_BOARD_TOOL];

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

/**
 * The notes model from the settings dialog, registered as its own provider so
 * it never touches models.json. Empty baseUrl or model means "use pi's own
 * default model", which is what a fresh install already has.
 */
function notesModel(runtime: ModelRuntime, settings: NotesAgentModelSettings) {
  if (!settings.baseUrl || !settings.model) return undefined;
  runtime.registerProvider(NOTES_AGENT_PROVIDER, {
    name: "Notes Agent",
    baseUrl: settings.baseUrl,
    // Local OpenAI-compatible servers often need no key; pi refuses a provider without one.
    apiKey: settings.apiKey || "not-needed",
    api: settings.api,
    models: [{
      id: settings.model,
      name: settings.model,
      api: settings.api,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: false,
      contextWindow: settings.contextWindow,
      maxTokens: settings.maxTokens,
    }],
  });
  return runtime.getModel(NOTES_AGENT_PROVIDER, settings.model);
}

declare global {
  // The conversation outlives the session object: a settings change rebuilds
  // the session, and the panel keeps what was said before it.
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
    const vault = notesRoot();
    const settings = readNotesSettings();
    const skillsDir = notesSkillsDir();
    const services = await createAgentSessionServices({
      cwd: vault,
      agentDir: getAgentDir(),
      // The notes agent has no project settings of its own: nothing here may
      // write to the user's global pi settings.
      settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: {
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: NOTES_SYSTEM_PROMPT,
        // pi's global APPEND_SYSTEM.md is coding rules (git, AGENTS.md); the
        // notes agent has its own prompt and must not inherit them.
        appendSystemPrompt: [],
        additionalSkillPaths: [skillsDir],
        // Only the notes agent's own skills: the user's coding skills are for
        // coding sessions, and their catalog would bloat every notes prompt.
        skillsOverride: (base) => ({
          skills: base.skills.filter((skill) => skill.filePath.startsWith(skillsDir)),
          diagnostics: base.diagnostics,
        }),
      },
    });
    const model = notesModel(services.modelRuntime, settings.agent);
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(vault),
      tools: AGENT_TOOLS,
      customTools: notesAgentTools(settings.board),
      ...(model ? { model } : {}),
    });
    return new NotesAgent(session, model ? `${model.provider}/${model.id}` : null);
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
  // Survives a Next dev reload; one session, rebuilt only when settings change.
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

/**
 * Drop the session after a settings change, so the next prompt uses the new
 * model. A model change also clears the conversation: the new session cannot
 * see it, so keeping it on screen would claim context the model lacks.
 */
export function resetNotesAgent(options: { clearHistory?: boolean } = {}): Promise<void> {
  const existing = globalThis.__piWebNotesAgent;
  globalThis.__piWebNotesAgent = undefined;
  if (options.clearHistory) globalThis.__piWebNotesHistory = [];
  return existing ? existing.promise.then((agent) => agent.dispose(), () => undefined) : Promise.resolve();
}

/** Skills the agent can load, for the panel and the settings dialog. */
export { listNotesSkills };

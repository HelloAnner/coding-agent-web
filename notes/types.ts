/** Shared between the notes API and its UI; no Node imports here. */

export type NotesFileKind = "note" | "board";

/** One row in the sidebar: a directory, a Markdown note, or a whiteboard. */
export interface NotesNode {
  name: string;
  /** Slash-separated path relative to the notes root; "" is the root. */
  path: string;
  type: "dir" | NotesFileKind;
  children?: NotesNode[];
}

export type NotesSaveState = "saved" | "saving" | "error";

/** Where a whiteboard was left: pan offset and zoom, kept in the database. */
export interface NotesBoardView {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

/** The open editor's save controls: a rename/move flushes, a delete discards. */
export interface NotesEditorControl {
  flush: () => Promise<boolean>;
  discard: () => void;
}

/** One row of the notes database: directories and files, with absolute paths. */
export interface NotesIndexRow {
  /** Slash-separated path relative to the notes root. */
  path: string;
  /** Relative path of the containing directory; "" for the root. */
  parent: string;
  name: string;
  type: "dir" | NotesFileKind;
  /** Absolute path on this machine, as sent to a coding harness. */
  absPath: string;
}

/** What the chat @ menu needs: files only, no directories. */
export interface NotesMention {
  name: string;
  /** Slash-separated path relative to the notes root. */
  path: string;
  absPath: string;
  kind: NotesFileKind;
}

/* ------------------------------- agent ---------------------------------- */

/**
 * The notes agent's own model. `baseUrl` empty means "use whatever the pi
 * install already has configured", which is the default.
 */
export interface NotesAgentModelSettings {
  baseUrl: string;
  apiKey: string;
  /** Model id, used as-is by the provider. */
  model: string;
  /** pi-ai Api id: openai-completions, anthropic-messages, ... */
  api: string;
  contextWindow: number;
  maxTokens: number;
}

/** Defaults for every element drawn on a whiteboard from now on. */
export interface NotesBoardSettings {
  /** Excalidraw FONT_FAMILY value (Virgil 1, Helvetica 2, Cascadia 3, Excalifont 5, ...). */
  fontFamily: number;
  fontSize: number;
}

export interface NotesSettings {
  agent: NotesAgentModelSettings;
  board: NotesBoardSettings;
}

/** One skill file under notes/skills, as the panel lists it. */
export interface NotesAgentSkill {
  name: string;
  description: string;
  /** Absolute path of SKILL.md on this machine. */
  path: string;
}

/** A tool the agent ran for one assistant turn, as the panel shows it. */
export interface NotesAgentToolRun {
  id: string;
  name: string;
  /** JSON arguments, one line. */
  args: string;
  status: "running" | "done" | "error";
  output?: string;
}

/** One chat bubble. The panel renders these; the server keeps the same shape. */
export interface NotesChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  tools?: NotesAgentToolRun[];
}

/** GET /api/notes/agent */
export interface NotesAgentState {
  messages: NotesChatMessage[];
  busy: boolean;
  /** Model the agent will use, for the panel header. */
  model: string | null;
  skills: NotesAgentSkill[];
}

/* ------------------------------ scheduler -------------------------------- */

/**
 * One timed notes job. Every run builds a fresh pi session from this
 * definition, so two tasks can differ in system prompt, skills and tools while
 * sharing the process's single model runtime.
 */
export interface NotesTaskDefinition {
  /** Stable id; used by the list and manual-run endpoints. */
  id: string;
  /** Human label, for logs and the task list. */
  title: string;
  /** The message the agent receives when the task fires. */
  prompt: string;
  /** Run every N seconds, counted from the previous run. */
  everySeconds?: number;
  /** Run every N minutes, counted from the previous run. */
  everyMinutes?: number;
  /** Run once a day at local "HH:MM". */
  dailyAt?: string;
  /** false keeps the definition out of the pool. Default: enabled. */
  enabled?: boolean;
  /** Replaces NOTES_SYSTEM_PROMPT for this task. */
  systemPrompt?: string;
  /** Skill names under notes/skills; omitted loads all, [] loads none. */
  skills?: string[];
  /** Tool allowlist; defaults to read / ls / notes_write / notes_board / notes_manage / notes_sessions. */
  tools?: string[];
  /** Abort a run after this many minutes. Default: 15. */
  timeoutMinutes?: number;
  /**
   * Decides this fire's prompt; null means there is nothing to do and no
   * session is built at all. `after` runs once the turn is over, whatever the
   * outcome, which is where a task records what it just covered.
   */
  prepare?: () => NotesTaskPreparation | null | Promise<NotesTaskPreparation | null>;
}

export interface NotesTaskPreparation {
  prompt: string;
  after?: (status: NotesTaskStatus) => void | Promise<void>;
}

export type NotesTaskStatus = "idle" | "queued" | "running" | "ok" | "error" | "timeout" | "skipped";

/** The outcome of one run, kept in memory for the task list. */
export interface NotesTaskRun {
  /** Start time, epoch milliseconds. */
  at: number;
  durationMs: number;
  status: NotesTaskStatus;
  error?: string;
  /** The assistant's final text, capped. */
  text?: string;
}

/** GET /api/notes/tasks: a definition plus where its run state stands. */
export interface NotesTaskView extends Omit<NotesTaskDefinition, "prepare"> {
  status: NotesTaskStatus;
  /** Next scheduled fire time, epoch ms; null when it will not run again. */
  nextRunAt: number | null;
  lastRun?: NotesTaskRun;
}

/** One line of POST /api/notes/agent's NDJSON stream. */
export type NotesAgentEvent =
  | { type: "message"; message: NotesChatMessage }
  | { type: "assistant_start"; id: string }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; tool: NotesAgentToolRun }
  | { type: "tool_end"; id: string; status: "done" | "error"; output: string }
  | { type: "error"; message: string }
  | { type: "done" };

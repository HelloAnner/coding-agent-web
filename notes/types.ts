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

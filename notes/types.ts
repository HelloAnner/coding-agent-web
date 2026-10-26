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

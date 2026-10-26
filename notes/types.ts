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

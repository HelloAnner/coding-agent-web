"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ChevronIcon, FolderIcon, PlusIcon, TrashIcon } from "./SidebarIcons";
import { useI18n } from "@/hooks/useI18n";
import type { NotesFileKind, NotesNode } from "@/notes/types";

export interface NotesTreeHandle {
  /** Opens the name form; `dir` is the folder the note goes into ("" is the root). */
  startCreate: (dir?: string) => void;
}

interface Props {
  activePath?: string | null;
  refreshKey?: number;
  onOpenNote: (path: string, name: string, kind: NotesFileKind) => void;
  /** Runs before a move or delete, so the open editor's edits are on disk. */
  onBeforeNoteChange?: () => Promise<boolean>;
  /** A note or folder moved: open tabs follow it. */
  onNoteMoved?: (from: string, to: string) => void;
  /** A note or folder was deleted: its open tabs close. */
  onNotesRemoved?: (path: string) => void;
}

function NoteIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" />
    </svg>
  );
}

function BoardIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 14 3-3 3 3 4-4" />
    </svg>
  );
}

/** `2026/plan.md` → `plan`, as a tab label shows it. */
function notesTitle(name: string): string {
  return name.replace(/\.(md|excalidraw)$/i, "");
}

function parentOf(relative: string): string {
  return relative.split("/").slice(0, -1).join("/");
}

function directoryPaths(nodes: readonly NotesNode[]): string[] {
  return nodes.flatMap((node) => node.type === "dir" ? [node.path, ...directoryPaths(node.children ?? [])] : []);
}

async function mutateNotes(body: Record<string, unknown>): Promise<{ ok: boolean; body: { node?: NotesNode; path?: string; error?: string } }> {
  const response = await fetch("/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => ({})) as { node?: NotesNode; path?: string; error?: string };
  return { ok: response.ok, body: parsed };
}

/** The notes vault's tree: folders fold, a note or board opens beside the chat. */
export const NotesTree = forwardRef<NotesTreeHandle, Props>(function NotesTree({
  activePath,
  refreshKey,
  onOpenNote,
  onBeforeNoteChange,
  onNoteMoved,
  onNotesRemoved,
}, ref) {
  const { t } = useI18n();
  const [tree, setTree] = useState<NotesNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState<{ dir: string } | null>(null);
  const [draftName, setDraftName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Folders start open once; after that the user's choices stay.
  const openedOnce = useRef(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/notes", { cache: "no-store" });
      const body = await response.json() as { tree?: NotesNode[]; error?: string };
      if (!response.ok || !body.tree) throw new Error(body.error || t("sidebar.notesLoadFailed"));
      setTree(body.tree);
      setError(null);
      if (!openedOnce.current) {
        openedOnce.current = true;
        setExpanded(new Set(directoryPaths(body.tree)));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("sidebar.notesLoadFailed"));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const toggleFolder = (path: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  const startCreate = useCallback((dir = "") => {
    setCreating({ dir });
    setDraftName("");
    setCreateError(null);
    if (dir) setExpanded((current) => new Set(current).add(dir));
  }, []);

  useImperativeHandle(ref, () => ({ startCreate }), [startCreate]);

  const cancelCreate = () => {
    setCreating(null);
    setDraftName("");
    setCreateError(null);
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!creating) return;
    const name = draftName.trim();
    if (!name) return;
    const dir = creating.dir;
    setCreateError(null);
    try {
      const { ok, body } = await mutateNotes({ action: "create", dir, name, kind: "note" });
      if (!ok || !body.node) throw new Error(body.error || t("sidebar.notesCreateFailed"));
      cancelCreate();
      await load();
      onOpenNote(body.node.path, notesTitle(body.node.name), "note");
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : t("sidebar.notesCreateFailed"));
    }
  };

  const moveInto = async (targetDir: string) => {
    const source = dragPath;
    setDragPath(null);
    setDropTarget(null);
    if (!source || parentOf(source) === targetDir) return;
    setActionError(null);
    try {
      if ((await onBeforeNoteChange?.()) === false) return;
      const { ok, body } = await mutateNotes({ action: "move", path: source, dir: targetDir });
      if (!ok || !body.path) throw new Error(body.error || t("sidebar.notesMoveFailed"));
      await load();
      if (targetDir) setExpanded((current) => new Set(current).add(targetDir));
      onNoteMoved?.(source, body.path);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("sidebar.notesMoveFailed"));
    }
  };

  const removeNode = async (node: NotesNode) => {
    const isDir = node.type === "dir";
    const name = isDir ? node.name : notesTitle(node.name);
    if (!window.confirm(t(isDir ? "sidebar.notesDeleteDirConfirm" : "sidebar.notesDeleteConfirm", { name }))) return;
    setActionError(null);
    try {
      if ((await onBeforeNoteChange?.()) === false) return;
      const { ok, body } = await mutateNotes({ action: "remove", path: node.path });
      if (!ok) throw new Error(body.error || t("sidebar.notesDeleteFailed"));
      await load();
      onNotesRemoved?.(node.path);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("sidebar.notesDeleteFailed"));
    }
  };

  const renderNode = (node: NotesNode, depth: number): ReactNode => {
    const isDir = node.type === "dir";
    const open = expanded.has(node.path);
    return (
      <div key={node.path}>
        <div
          className={`session-tree-row session-tree-session dashboard-tree-row notes-tree-row${activePath === node.path ? " is-selected" : ""}${dragPath === node.path ? " is-dragging" : ""}${isDir && dropTarget === node.path ? " is-drop-target" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          data-notes-path={node.path}
          draggable={!isDir}
          onDragStart={!isDir ? (event) => {
            setDragPath(node.path);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", node.path);
          } : undefined}
          onDragEnd={() => {
            setDragPath(null);
            setDropTarget(null);
          }}
          onDragOver={isDir ? (event) => {
            if (!dragPath) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
            setDropTarget(node.path);
          } : (event) => {
            if (dragPath) event.stopPropagation();
          }}
          onDrop={isDir ? (event) => {
            if (!dragPath) return;
            event.preventDefault();
            event.stopPropagation();
            void moveInto(node.path);
          } : undefined}
        >
          {isDir ? (
            <button
              type="button"
              className="notes-tree-toggle"
              aria-label={open ? t("sidebar.notesCollapseFolder") : t("sidebar.notesExpandFolder")}
              aria-expanded={open}
              onClick={() => toggleFolder(node.path)}
            >
              <ChevronIcon size={11} strokeWidth={3} className={`session-tree-chevron${open ? " is-open" : ""}`} />
            </button>
          ) : (
            <span className="notes-tree-toggle" aria-hidden="true">{node.type === "board" ? <BoardIcon /> : <NoteIcon />}</span>
          )}
          <button
            type="button"
            className="session-tree-main"
            title={node.path}
            onClick={() => {
              if (isDir) {
                toggleFolder(node.path);
                return;
              }
              onOpenNote(node.path, notesTitle(node.name), node.type === "board" ? "board" : "note");
            }}
          >
            {isDir && <FolderIcon size={12} className="notes-tree-folder" />}
            <span className="session-tree-title">{isDir ? node.name : notesTitle(node.name)}</span>
          </button>
          {isDir && (
            <button
              type="button"
              className="notes-row-plus"
              title={t("sidebar.notesNewNoteIn", { name: node.name })}
              aria-label={t("sidebar.notesNewNoteIn", { name: node.name })}
              onClick={(event) => {
                event.stopPropagation();
                startCreate(node.path);
              }}
            >
              <PlusIcon size={12} />
            </button>
          )}
          <button
            type="button"
            className="notes-row-delete"
            title={t("sidebar.notesDelete")}
            aria-label={t("sidebar.notesDelete")}
            onClick={(event) => {
              event.stopPropagation();
              void removeNode(node);
            }}
          >
            <TrashIcon size={12} />
          </button>
        </div>
        {isDir && open && (node.children ?? []).map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div
      className={`session-tree dashboard-tree notes-tree${dragPath && dropTarget === "" ? " is-drop-root" : ""}`}
      style={{ height: "100%" }}
      onDragOver={(event) => {
        if (!dragPath) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropTarget("");
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropTarget(null);
      }}
      onDrop={(event) => {
        if (!dragPath) return;
        event.preventDefault();
        void moveInto("");
      }}
    >
      {creating && (
        <form className="notes-create" onSubmit={(event) => void submitCreate(event)}>
          <div className="notes-create-head">
            <span>{t("sidebar.notesNewNote")}</span>
            <span className="notes-create-target">{creating.dir || t("sidebar.tabNotes")}</span>
          </div>
          <input
            autoFocus
            value={draftName}
            aria-label={t("sidebar.notesNewNote")}
            placeholder={t("sidebar.notesNoteTitle")}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") cancelCreate();
            }}
          />
          {createError && <div className="notes-create-error">{createError}</div>}
          <div className="notes-create-actions">
            <button type="button" onClick={cancelCreate}>{t("sidebar.notesCancel")}</button>
            <button type="submit" disabled={!draftName.trim()}>{t("sidebar.notesCreate")}</button>
          </div>
        </form>
      )}
      <div className="session-tree-scroll">
        <div className="session-tree-inner">
          {tree === null && !error && <div className="session-tree-message">{t("sidebar.notesLoading")}</div>}
          {error && <div className="session-tree-message is-error">{error}</div>}
          {actionError && <div className="session-tree-message is-error">{actionError}</div>}
          {tree !== null && tree.length === 0 && (
            <div className="session-tree-message">{t("sidebar.notesEmpty")}</div>
          )}
          {tree?.map((node) => renderNode(node, 0))}
        </div>
      </div>
    </div>
  );
});

"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronIcon, FolderIcon } from "./SidebarIcons";
import { useI18n } from "@/hooks/useI18n";
import type { NotesFileKind, NotesNode } from "@/notes/types";

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

function directoryPaths(nodes: readonly NotesNode[]): string[] {
  return nodes.flatMap((node) => node.type === "dir" ? [node.path, ...directoryPaths(node.children ?? [])] : []);
}

/** The notes vault's tree: folders fold, a note or board opens beside the chat. */
export function NotesTree({
  activePath,
  refreshKey,
  onOpenNote,
}: {
  activePath?: string | null;
  refreshKey?: number;
  onOpenNote: (path: string, name: string, kind: NotesFileKind) => void;
}) {
  const { t } = useI18n();
  const [tree, setTree] = useState<NotesNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
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

  const renderNode = (node: NotesNode, depth: number): ReactNode => {
    const isDir = node.type === "dir";
    const open = expanded.has(node.path);
    return (
      <div key={node.path}>
        <div
          className={`session-tree-row session-tree-session dashboard-tree-row notes-tree-row${activePath === node.path ? " is-selected" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          {isDir ? (
            <button
              type="button"
              className="notes-tree-toggle"
              aria-label={open ? t("sidebar.notesCollapseFolder") : t("sidebar.notesExpandFolder")}
              aria-expanded={open}
              onClick={() => setExpanded((current) => {
                const next = new Set(current);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              })}
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
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(node.path)) next.delete(node.path);
                  else next.add(node.path);
                  return next;
                });
                return;
              }
              onOpenNote(node.path, notesTitle(node.name), node.type === "board" ? "board" : "note");
            }}
          >
            {isDir && <FolderIcon size={12} className="notes-tree-folder" />}
            <span className="session-tree-title">{isDir ? node.name : notesTitle(node.name)}</span>
          </button>
        </div>
        {isDir && open && (node.children ?? []).map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="session-tree dashboard-tree notes-tree" style={{ height: "100%" }}>
      <div className="session-tree-scroll">
        <div className="session-tree-inner">
          {tree === null && !error && <div className="session-tree-message">{t("sidebar.notesLoading")}</div>}
          {error && <div className="session-tree-message is-error">{error}</div>}
          {tree !== null && tree.length === 0 && (
            <div className="session-tree-message">{t("sidebar.notesEmpty")}</div>
          )}
          {tree?.map((node) => renderNode(node, 0))}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState, type Ref, type ReactNode } from "react";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { NotesTree, type NotesTreeHandle } from "./NotesTree";
import { DismissButton } from "./DismissButton";
import { getFileName } from "@/lib/file-paths";
import {
  loadShowIgnoredFiles,
  saveShowIgnoredFiles,
  type FileTreeSource,
} from "@/lib/sidebar-prefs";
import type { NotesFileKind } from "@/notes/types";
import { useI18n } from "@/hooks/useI18n";
import {
  ChangesIcon,
  CheckIcon,
  EyeIcon,
  FolderIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  TerminalIcon,
  UploadIcon,
} from "./SidebarIcons";

interface FileManagerAvailability {
  supported: boolean;
  reason: string | null;
  platform: string;
}

// Server error codes with a translation; any other code is shown verbatim.
const FILE_MANAGER_ERROR_KEYS: Record<string, string> = {
  remote: "sidebar.openInExplorerRemoteOnly",
  "unsupported-platform": "sidebar.openInExplorerUnsupported",
};

function ToolbarIconButton({
  ref,
  onClick,
  title,
  disabled,
  pressed,
  expanded,
  controls,
  done,
  children,
}: {
  ref?: Ref<HTMLButtonElement>;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  controls?: string;
  done?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-controls={controls}
      className={`sidebar-tool-button${pressed || expanded ? " is-active" : ""}${done ? " is-done" : ""}`}
    >
      {children}
    </button>
  );
}

interface Props {
  cwd: string | null;
  /** The tree on show: the project's files, or the notes vault (owned by the shell, per session). */
  source: FileTreeSource;
  onSourceChange: (source: FileTreeSource) => void;
  /** The conversation whose notes tree position is remembered. */
  sessionKey?: string | null;
  activeFilePath?: string | null;
  activeNotePath?: string | null;
  refreshKey?: number;
  onOpenFile: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  onOpenNote: (path: string, name: string, kind: NotesFileKind) => void;
  onBeforeNoteChange?: () => Promise<boolean>;
  onNoteMoved?: (from: string, to: string) => void;
  onNotesRemoved?: (path: string) => void;
  onOpenTerminal?: (cwd: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  /** Refreshes the tree and the viewer's Git state together. */
  onRefresh?: () => void;
  /** A phone's way back to the viewer (the tree covers it there). */
  onBack?: () => void;
  /** Folds the column away, leaving the viewer the whole panel. */
  onCollapse?: () => void;
}

/**
 * The project's files, as the right panel's first column: the folder name,
 * the actions on it, and the tree. A click on a file opens it in the panel's
 * viewer column.
 */
export function FileBrowserPane({ cwd, source, onSourceChange, sessionKey, activeFilePath, activeNotePath, refreshKey, onOpenFile, onOpenNote, onBeforeNoteChange, onNoteMoved, onNotesRemoved, onOpenTerminal, onAtMention, onAtMentions, onRefresh, onBack, onCollapse }: Props) {
  const { t } = useI18n();
  const [notesRefreshKey, setNotesRefreshKey] = useState(0);
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [changesCount, setChangesCount] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  const [showIgnoredFiles, setShowIgnoredFiles] = useState(false);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const [fileManager, setFileManager] = useState<FileManagerAvailability | null>(null);
  const [fileManagerError, setFileManagerError] = useState<string | null>(null);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);
  const notesTreeRef = useRef<NotesTreeHandle>(null);

  useEffect(() => {
    if (refreshKey !== undefined) setExplorerKey((key) => key + 1);
  }, [refreshKey]);

  useEffect(() => () => {
    if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
  }, []);

  useEffect(() => {
    setShowIgnoredFiles(loadShowIgnoredFiles());
  }, []);

  useEffect(() => {
    setFileManagerError(null);
  }, [cwd]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/open-in-explorer")
      .then((res) => res.ok ? res.json() as Promise<FileManagerAvailability> : null)
      .then((data) => { if (!cancelled && data) setFileManager(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const openInFileManager = useCallback(async (): Promise<void> => {
    if (!cwd) return;
    try {
      const res = await fetch("/api/open-in-explorer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      if (res.ok) {
        setFileManagerError(null);
        return;
      }
      const data = await res.json().catch(() => ({})) as { error?: string };
      setFileManagerError(data.error ?? `HTTP ${res.status}`);
    } catch (error) {
      setFileManagerError(error instanceof Error ? error.message : String(error));
    }
  }, [cwd]);

  const fileManagerLabel = t(
    fileManager?.platform === "darwin"
      ? "sidebar.openInFinder"
      : fileManager?.platform === "win32"
        ? "sidebar.openInExplorer"
        : "sidebar.openInFileManager",
  );
  const fileManagerUnavailable = fileManager?.supported === false;
  const fileManagerErrorMessage = fileManagerError
    ? t(FILE_MANAGER_ERROR_KEYS[fileManagerError] ?? fileManagerError)
    : null;
  const refresh = () => {
    if (onRefresh) onRefresh();
    else setExplorerKey((key) => key + 1);
    setNotesRefreshKey((key) => key + 1);
    setExplorerRefreshDone(true);
    if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
    explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
  };

  return (
    <div
      className="file-browser-pane"
      style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0, background: "var(--bg-panel)" }}
    >
      <div
        className="file-browser-head"
        style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          height: 36,
          padding: "0 8px",
          gap: 6,
          borderBottom: "1px solid var(--border)",
        }}
      >
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            title={t("files.hidePanel")}
            aria-label={t("files.hidePanel")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 24, height: 24, padding: 0, marginLeft: -4, flexShrink: 0,
              background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
        )}
        <span
          title={source === "notes" ? t("sidebar.tabNotes") : (cwd ?? undefined)}
          style={{
            minWidth: 0,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--text)",
          }}
        >
          {source === "notes"
            ? t("sidebar.tabNotes")
            : (cwd ? getFileName(cwd) || cwd : t("sidebar.selectProject"))}
        </span>
        <div role="tablist" aria-label={t("sidebar.treeSource")} style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
          {(["project", "notes"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={source === option}
              onClick={() => onSourceChange(option)}
              style={{
                height: 22, padding: "0 7px", border: "none", borderRadius: 5, cursor: "pointer",
                background: source === option ? "var(--bg-selected)" : "transparent",
                color: source === option ? "var(--text)" : "var(--text-dim)",
                fontSize: 11, fontWeight: 500,
              }}
            >
              {t(option === "notes" ? "sidebar.tabNotes" : "sidebar.tabFiles")}
            </button>
          ))}
        </div>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            title={t("sidebar.collapseTree")}
            aria-label={t("sidebar.collapseTree")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 24, height: 24, padding: 0, marginRight: -4, flexShrink: 0,
              background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0, padding: "2px 6px", borderBottom: "1px solid var(--border)" }}>
        {source === "notes" ? (
          <>
        <ToolbarIconButton
          onClick={() => notesTreeRef.current?.startCreate()}
          title={t("sidebar.notesNewBoard")}
        >
          <PlusIcon size={14} />
        </ToolbarIconButton>
        <ToolbarIconButton
          onClick={refresh}
          title={t("sidebar.refreshNotes")}
          done={explorerRefreshDone}
        >
          {explorerRefreshDone ? <CheckIcon size={14} /> : <RefreshIcon size={14} />}
        </ToolbarIconButton>
          </>
        ) : (
          <>
        <ToolbarIconButton
          onClick={() => { if (cwd) onOpenTerminal?.(cwd); }}
          disabled={!cwd || !onOpenTerminal}
          title={t("terminal.open")}
        >
          <TerminalIcon size={14} />
        </ToolbarIconButton>
        <ToolbarIconButton
          onClick={() => void openInFileManager()}
          disabled={!cwd || fileManagerUnavailable}
          title={fileManagerUnavailable
            ? t(fileManager?.reason === "remote" ? "sidebar.openInExplorerRemoteOnly" : "sidebar.openInExplorerUnsupported")
            : fileManagerLabel}
        >
          <FolderIcon size={14} />
        </ToolbarIconButton>
        <ToolbarIconButton
          onClick={() => fileExplorerRef.current?.openUploadPicker()}
          disabled={!cwd || explorerUploadBusy}
          title={t("sidebar.uploadFilesTitle")}
        >
          <UploadIcon size={14} />
        </ToolbarIconButton>
        <ToolbarIconButton
          onClick={refresh}
          disabled={!cwd}
          title={t("sidebar.refreshExplorer")}
          done={explorerRefreshDone}
        >
          {explorerRefreshDone ? <CheckIcon size={14} /> : <RefreshIcon size={14} />}
        </ToolbarIconButton>
        <ToolbarIconButton
          onClick={() => {
            const next = !showIgnoredFiles;
            setShowIgnoredFiles(next);
            saveShowIgnoredFiles(next);
          }}
          disabled={!cwd}
          title={t("sidebar.showIgnoredFiles")}
          pressed={showIgnoredFiles}
        >
          <EyeIcon size={14} />
        </ToolbarIconButton>
        <ToolbarIconButton
          onClick={() => setChangesCollapsed((collapsed) => !collapsed)}
          disabled={!cwd || changesCount === 0}
          title={t("sidebar.changedFiles", { count: changesCount })}
          pressed={changesCount > 0 && !changesCollapsed}
        >
          <ChangesIcon size={14} />
        </ToolbarIconButton>
        <ToolbarIconButton
          onClick={() => setFileSearchOpen((open) => !open)}
          disabled={!cwd}
          title={t("sidebar.searchFiles")}
          expanded={fileSearchOpen}
          controls="file-search-input"
        >
          <SearchIcon size={14} />
        </ToolbarIconButton>
          </>
        )}
      </div>
      {source === "project" && cwd && fileManagerErrorMessage && (
        <div role="alert" className="sidebar-files-error">
          <span className="sidebar-files-error-text">{fileManagerErrorMessage}</span>
          <DismissButton onClick={() => setFileManagerError(null)} title={t("files.dismissError")} />
        </div>
      )}
      <div className="sidebar-files-scroll scrollbar-subtle" style={{ flex: 1, minHeight: 0 }}>
        {source === "notes" ? (
          <NotesTree
            ref={notesTreeRef}
            activePath={activeNotePath}
            stateKey={sessionKey}
            refreshKey={notesRefreshKey}
            onOpenNote={onOpenNote}
            onBeforeNoteChange={onBeforeNoteChange}
            onNoteMoved={onNoteMoved}
            onNotesRemoved={onNotesRemoved}
          />
        ) : cwd && (
          <FileExplorer
            activeFilePath={activeFilePath}
            ref={fileExplorerRef}
            cwd={cwd}
            onOpenFile={onOpenFile}
            refreshKey={explorerKey}
            onAtMention={onAtMention}
            onAtMentions={onAtMentions}
            onUploadBusyChange={setExplorerUploadBusy}
            changesCollapsed={changesCollapsed}
            onChangesCountChange={setChangesCount}
            fileSearchOpen={fileSearchOpen}
            onFileSearchOpenChange={setFileSearchOpen}
            showHidden={showIgnoredFiles}
          />
        )}
      </div>
    </div>
  );
}

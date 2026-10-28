"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppSwitcher } from "@/components/AppSwitcher";
import { ChevronIcon, FolderIcon, PlusIcon, TrashIcon } from "@/components/SidebarIcons";
import { SidebarMenu, type SidebarMenuAnchor } from "@/components/SidebarMenu";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { WebApp } from "@/lib/apps";
import type { NotesBoardSettings, NotesEditorControl, NotesNode, NotesSaveState, NotesSettings, NotesTaskView } from "@/notes/types";
import { NoteEditor } from "./NoteEditor";
import { NotesAgentPanel } from "./NotesAgentPanel";
import { NotesSettingsDialog } from "./NotesSettingsDialog";
import { Whiteboard } from "./Whiteboard";

type CreateKind = "note" | "board" | "dir";

const CREATE_ITEMS: readonly { kind: CreateKind; label: string; hint: string }[] = [
  { kind: "note", label: "新建笔记", hint: "Markdown" },
  { kind: "board", label: "新建白板", hint: "Excalidraw" },
  { kind: "dir", label: "新建目录", hint: "文件夹" },
];

const SAVE_LABELS: Record<NotesSaveState, string> = {
  saved: "已保存",
  saving: "保存中…",
  error: "保存失败",
};

/** What a whiteboard uses until /api/notes/settings answers (Cascadia 20). */
const DEFAULT_BOARD: NotesBoardSettings = { fontFamily: 3, fontSize: 20 };

function SettingsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M20 7h-9M14 17H5" /><circle cx="7" cy="7" r="3" /><circle cx="17" cy="17" r="3" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v3M6 9h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z" />
      <path d="M9 14h.01M15 14h.01" />
    </svg>
  );
}

function baseName(relative: string): string {
  return relative.split("/").pop() ?? relative;
}

function parentPath(relative: string): string {
  return relative.split("/").slice(0, -1).join("/");
}

function titleOf(name: string): string {
  return name.replace(/\.(md|excalidraw)$/i, "");
}

/** The name as the user edits it: folders verbatim, files without extension. */
function renameLabel(node: NotesNode): string {
  return node.type === "dir" ? node.name : titleOf(node.name);
}

function findNode(nodes: readonly NotesNode[], path: string): NotesNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
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

/**
 * The notes app inside the shell: folder tree on the left, the selected note
 * or whiteboard on the right. Both other apps stay mounted beside it, so a
 * switch is instant. The tree mirrors data/notes one file per row.
 */
export function NotesApp({
  active,
  currentApp,
  onSwitchApp,
}: {
  active: boolean;
  currentApp: WebApp;
  onSwitchApp: (app: WebApp) => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();

  const [tree, setTree] = useState<NotesNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // "" is the root itself (no file open), a node path is a folder or file.
  const [selectedPath, setSelectedPath] = useState<string | null>("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Desktop: the tree is a panel that can be put away, like the shell's sidebar.
  const [treeHidden, setTreeHidden] = useState(false);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ anchor: SidebarMenuAnchor; dir: string | null; returnTo: HTMLElement | null } | null>(null);
  const [creating, setCreating] = useState<{ kind: CreateKind; dir: string } | null>(null);
  const [draftName, setDraftName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameCancelled = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<NotesSaveState>("saved");
  // The manual tidy run: one button, then a poll until the queue drains.
  const [tidying, setTidying] = useState(false);
  const [tidyNote, setTidyNote] = useState<string | null>(null);
  const [settings, setSettings] = useState<NotesSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  // Bumped when the agent rewrote a file: the open editor reloads from disk.
  const [vaultKey, setVaultKey] = useState(0);
  // Every selection goes through selectPath, which updates this ref at once.
  const selectedPathRef = useRef<string | null>(selectedPath);
  const plusRef = useRef<HTMLButtonElement>(null);
  const initialPath = useRef(searchParams.get("path"));
  // The open editor registers its flush; a rename waits for it so the file
  // does not move while the last keystrokes are still only in memory.
  const editorRef = useRef<NotesEditorControl | null>(null);
  const registerEditor = useCallback((control: NotesEditorControl | null) => {
    editorRef.current = control;
  }, []);

  const selectedNode = useMemo(
    () => (selectedPath ? findNode(tree, selectedPath) : null),
    [selectedPath, tree],
  );
  const selectedFile = selectedNode && selectedNode.type !== "dir" ? selectedNode : null;
  const boardOpen = selectedFile?.type === "board";
  const board = settings?.board ?? DEFAULT_BOARD;

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/notes", { cache: "no-store" });
      const body = await response.json() as { tree?: NotesNode[]; error?: string };
      if (!response.ok || !body.tree) throw new Error(body.error || "读取目录失败");
      setTree(body.tree);
      setLoadError(null);
      return body.tree;
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "读取目录失败");
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  /** Merge boards, retitle, and tidy the tree in one agent run. */
  const tidyVault = useCallback(async () => {
    if (tidying) return;
    setTidying(true);
    setTidyNote(null);
    try {
      const started = await fetch("/api/notes/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "notes-tidy" }),
      });
      if (!started.ok) {
        const body = await started.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || "整理任务启动失败");
      }
      // The run keeps going on the server; follow it so the tree refreshes as
      // soon as the last board lands.
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const state = await fetch("/api/notes/tasks", { cache: "no-store" })
          .then((response) => response.json() as Promise<{ tasks?: NotesTaskView[] }>)
          .catch(() => null);
        const task = state?.tasks?.find((item) => item.id === "notes-tidy");
        if (!task) break;
        if (task.status === "queued" || task.status === "running") continue;
        setTidyNote(task.lastRun?.text || task.lastRun?.error || null);
        break;
      }
      await refresh();
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "整理任务启动失败");
    } finally {
      setTidying(false);
    }
  }, [refresh, tidying]);

  // The tree is read when the app comes into view, not at shell startup, and
  // again on every return: files can change outside the app.
  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  // Settings can change while another app is in front (another tab), so they
  // are read on every return, like the tree.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    fetch("/api/notes/settings", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { settings?: NotesSettings };
        if (alive && response.ok && body.settings) setSettings(body.settings);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [active]);

  // A reload or a shared link carries the open file in ?path=.
  useEffect(() => {
    if (loading) return;
    const wanted = initialPath.current;
    if (!wanted) return;
    initialPath.current = null;
    const node = findNode(tree, wanted);
    if (node && node.type !== "dir") selectPath(node.path);
  }, [loading, tree]);

  // Expand the folders a newly opened file lives in.
  useEffect(() => {
    if (!selectedFile) return;
    const parts = parentPath(selectedFile.path).split("/").filter(Boolean);
    if (!parts.length) return;
    setExpanded((current) => {
      const next = new Set(current);
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        next.add(acc);
      }
      return next;
    });
  }, [selectedFile]);

  useEffect(() => {
    setTitleDraft(selectedFile ? titleOf(selectedFile.name) : "");
    setActionError(null);
    setSaveState("saved");
  }, [selectedFile]);

  useEffect(() => {
    if (!active) setSidebarOpen(false);
  }, [active]);

  const handleSaveState = useCallback((state: NotesSaveState) => setSaveState(state), []);

  // Update the ref with the state: an in-flight rename must see the newest
  // selection even before React has rendered it.
  const selectPath = (path: string) => {
    selectedPathRef.current = path;
    setSelectedPath(path);
  };

  // The tree has no root row: clicking its empty space targets the root.
  const clearSelection = () => {
    selectPath("");
    router.replace("/notes", { scroll: false });
  };

  const selectFile = (node: NotesNode) => {
    selectPath(node.path);
    if (node.type === "dir") {
      setExpanded((current) => new Set(current).add(node.path));
      setSidebarOpen(false);
      router.replace("/notes", { scroll: false });
      return;
    }
    setSidebarOpen(false);
    router.replace(`/notes?path=${encodeURIComponent(node.path)}`, { scroll: false });
  };

  const openMenu = () => {
    const button = plusRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    setMenu({
      dir: null,
      returnTo: button,
      anchor: {
        kind: "rect",
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        align: "end",
      },
    });
  };

  // A directory row's + creates there, independent of what is selected.
  const openFolderMenu = (dir: string, button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    setMenu({
      dir,
      returnTo: button,
      anchor: {
        kind: "rect",
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        align: "end",
      },
    });
  };

  const startCreate = (kind: CreateKind, dir: string) => {
    setCreating({ kind, dir });
    setDraftName("");
    setCreateError(null);
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!creating) return;
    const name = draftName.trim();
    if (!name) return;
    const { kind, dir } = creating;
    setCreateError(null);
    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: kind === "dir" ? "mkdir" : "create",
          dir,
          name,
          kind: kind === "dir" ? undefined : kind,
        }),
      });
      const body = await response.json() as { node?: NotesNode; error?: string };
      if (!response.ok || !body.node) throw new Error(body.error || "创建失败");
      const node = body.node;
      setCreating(null);
      setDraftName("");
      await refresh();
      setExpanded((current) => {
        const next = new Set(current);
        if (dir) next.add(dir);
        if (kind === "dir") next.add(node.path);
        return next;
      });
      selectPath(node.path);
      router.replace(
        kind === "dir" ? "/notes" : `/notes?path=${encodeURIComponent(node.path)}`,
        { scroll: false },
      );
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "创建失败");
    }
  };

  const renameNode = async (node: NotesNode, name: string): Promise<boolean> => {
    const isDir = node.type === "dir";
    const next = name.trim();
    if (!next || next === renameLabel(node)) return true;
    setActionError(null);
    const wasOpen = selectedFile?.path === node.path;
    try {
      // Only the open file can have pending edits.
      if (wasOpen) {
        const saved = await editorRef.current?.flush();
        if (saved === false) return false;
      }
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", path: node.path, name: next }),
      });
      const body = await response.json() as { path?: string; error?: string };
      if (!response.ok || !body.path) throw new Error(body.error || "重命名失败");
      const nextPath = body.path;
      const selected = selectedPathRef.current;
      // The user may have clicked another file while the request was in
      // flight; their newer selection wins over the renamed one.
      if (wasOpen && selected === node.path) {
        selectPath(nextPath);
        setTitleDraft(titleOf(baseName(nextPath)));
        router.replace(`/notes?path=${encodeURIComponent(nextPath)}`, { scroll: false });
      } else if (isDir && selected?.startsWith(`${node.path}/`)) {
        // The open note now lives under the new folder path.
        selectPath(nextPath + selected.slice(node.path.length));
        router.replace(
          `/notes?path=${encodeURIComponent(nextPath + selected.slice(node.path.length))}`,
          { scroll: false },
        );
      }
      if (isDir) {
        setExpanded((current) => new Set([...current].map((p) => (
          p === node.path || p.startsWith(`${node.path}/`)
            ? nextPath + p.slice(node.path.length)
            : p
        ))));
      }
      await refresh();
      return true;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "重命名失败");
      return false;
    }
  };

  const commitTitle = async () => {
    if (!selectedFile) return;
    const next = titleDraft.trim();
    if (!next || next === titleOf(selectedFile.name)) {
      setTitleDraft(titleOf(selectedFile.name));
      return;
    }
    const renamed = await renameNode(selectedFile, next);
    if (!renamed) setTitleDraft(titleOf(selectedFile.name));
  };

  const startRename = (node: NotesNode) => {
    setRenamingPath(node.path);
    setRenameDraft(renameLabel(node));
    setActionError(null);
  };

  const finishInlineRename = async (node: NotesNode) => {
    if (renamingPath !== node.path) return;
    setRenamingPath(null);
    await renameNode(node, renameDraft);
  };

  const moveFile = async (targetDir: string) => {
    const source = dragPath ? findNode(tree, dragPath) : null;
    setDragPath(null);
    setDropTarget(null);
    if (!source || source.type === "dir" || parentPath(source.path) === targetDir) return;
    setActionError(null);
    try {
      // The open editor's pending edits belong to the old path: save first.
      const saved = await editorRef.current?.flush();
      if (saved === false) return;
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "move", path: source.path, dir: targetDir }),
      });
      const body = await response.json() as { path?: string; error?: string };
      if (!response.ok || !body.path) throw new Error(body.error || "移动失败");
      await refresh();
      setExpanded((current) => {
        const next = new Set(current);
        let acc = "";
        for (const part of targetDir.split("/").filter(Boolean)) {
          acc = acc ? `${acc}/${part}` : part;
          next.add(acc);
        }
        return next;
      });
      if (selectedPath === source.path) {
        selectPath(body.path);
        router.replace(`/notes?path=${encodeURIComponent(body.path)}`, { scroll: false });
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "移动失败");
    }
  };

  const removeNode = async (node: NotesNode) => {
    const question = node.type === "dir"
      ? `删除目录「${node.name}」和里面的全部笔记与白板？`
      : `删除「${titleOf(node.name)}」？`;
    if (!window.confirm(question)) return;
    setActionError(null);
    try {
      const removed = selectedPath === node.path
        || (node.type === "dir" && !!selectedPath?.startsWith(`${node.path}/`));
      // Save the open editor before its file disappears, then drop anything
      // the delete click itself queued (blurring the canvas can report a
      // change) once the delete has landed.
      if (removed) await editorRef.current?.flush();
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", path: node.path }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "删除失败");
      if (removed) editorRef.current?.discard();
      await refresh();
      if (removed) {
        selectPath("");
        router.replace("/notes", { scroll: false });
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "删除失败");
    }
  };

  // The agent writes straight to the vault: the tree is stale, and the open
  // file must be read again or the next save would overwrite what it wrote.
  const handleVaultChanged = useCallback((paths: string[]) => {
    void refresh();
    if (!selectedPath || !paths.includes(selectedPath)) return;
    setVaultKey((key) => key + 1);
  }, [refresh, selectedPath]);

  const renderNode = (node: NotesNode, depth: number) => {
    const isDir = node.type === "dir";
    const open = expanded.has(node.path);
    const selected = selectedPath === node.path;
    const children = node.children ?? [];
    const label = isDir ? node.name : titleOf(node.name);
    return (
      <div key={node.path}>
        <div
          className={`session-tree-row session-tree-session dashboard-tree-row notes-tree-row${selected ? " is-selected" : ""}${dragPath === node.path ? " is-dragging" : ""}${isDir && dropTarget === node.path ? " is-drop-target" : ""}`}
          style={{ paddingLeft: 2 + depth * 14 }}
          data-notes-path={node.path}
          draggable={!isDir && renamingPath !== node.path}
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
            void moveFile(node.path);
          } : undefined}
        >
          {isDir ? (
            <button
              type="button"
              className="notes-tree-toggle"
              aria-label={open ? "收起子目录" : "展开子目录"}
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
          {renamingPath === node.path ? (
            <input
              className="notes-rename-input"
              autoFocus
              value={renameDraft}
              aria-label="重命名"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setRenameDraft(event.target.value)}
              onBlur={() => {
                const cancelled = renameCancelled.current;
                renameCancelled.current = false;
                if (cancelled) {
                  setRenamingPath(null);
                  setRenameDraft("");
                  return;
                }
                void finishInlineRename(node);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  renameCancelled.current = true;
                  event.currentTarget.blur();
                }
              }}
            />
          ) : (
            <>
              <button
                type="button"
                className="session-tree-main"
                title={`${node.path}（双击重命名）`}
                onClick={() => selectFile(node)}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  startRename(node);
                }}
              >
                {isDir && <FolderIcon size={12} className="notes-tree-folder" />}
                <span className="session-tree-title">{label}</span>
              </button>
              {isDir && (
                <button
                  type="button"
                  className="notes-row-plus"
                  title="在此目录新建"
                  aria-label={`在 ${node.name} 下新建`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openFolderMenu(node.path, event.currentTarget);
                  }}
                >
                  <PlusIcon size={12} />
                </button>
              )}
              <button
                type="button"
                className="notes-row-delete"
                title="删除"
                aria-label={`删除 ${label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void removeNode(node);
                }}
              >
                <TrashIcon size={12} />
              </button>
            </>
          )}
        </div>
        {isDir && open && children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div
      className={`dashboard-app notes-app${treeHidden ? " is-tree-hidden" : ""}`}
      role="region"
      aria-label="Notes"
      aria-hidden={!active}
      hidden={!active}
    >
      <aside className={`dashboard-sidebar${sidebarOpen ? " is-open" : ""}`} aria-label="Notes">
        <div className="sidebar-header">
          <AppSwitcher current={currentApp} onSwitch={onSwitchApp} />
          <span className="sidebar-header-spacer" />
          <button
            type="button"
            className={`sidebar-search-toggle${tidying ? " is-active" : ""}`}
            title={tidying ? "整理中…合并白板、理顺标题、收拾目录" : tidyNote ?? "整理笔记库：合并白板、理顺标题、收拾目录"}
            aria-label="整理笔记库"
            aria-busy={tidying}
            disabled={tidying}
            onClick={() => void tidyVault()}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
              <circle cx="12" cy="12" r="3.2" />
            </svg>
          </button>
          <button
            ref={plusRef}
            type="button"
            className={`sidebar-search-toggle${menu ? " is-active" : ""}`}
            title="新建"
            aria-label="新建"
            aria-haspopup="menu"
            aria-expanded={menu !== null}
            onClick={() => (menu ? setMenu(null) : openMenu())}
          >
            <PlusIcon size={16} />
          </button>
          <button
            type="button"
            className="sidebar-search-toggle notes-collapse-button"
            title="收起目录"
            aria-label="收起目录"
            onClick={() => setTreeHidden(true)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
        </div>

        {creating && (
          <form className="notes-create" onSubmit={(event) => void submitCreate(event)}>
            <div className="notes-create-head">
              <span>
                {creating.kind === "dir" && creating.dir
                  ? "新建子目录"
                  : CREATE_ITEMS.find((item) => item.kind === creating.kind)?.label}
              </span>
              <span className="notes-create-target">在 {creating.dir || "根目录"}</span>
            </div>
            <input
              autoFocus
              value={draftName}
              aria-label="名称"
              placeholder={creating.kind === "dir" ? "目录名称" : creating.kind === "board" ? "白板名称" : "笔记标题"}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setCreating(null);
                  setDraftName("");
                }
              }}
            />
            {createError && <div className="notes-create-error">{createError}</div>}
            <div className="notes-create-actions">
              <button type="button" onClick={() => { setCreating(null); setDraftName(""); }}>取消</button>
              <button type="submit" disabled={!draftName.trim()}>创建</button>
            </div>
          </form>
        )}

        <div
          className={`session-tree dashboard-tree notes-tree${dragPath && dropTarget === "" ? " is-drop-root" : ""}`}
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
            void moveFile("");
          }}
          onClick={(event) => {
            if (!(event.target instanceof HTMLElement)) return;
            if (event.target.closest("[data-notes-path]")) return;
            clearSelection();
          }}
        >
          <div className="session-tree-scroll">
            <div className="session-tree-inner">
              {loading && <div className="session-tree-message">加载中…</div>}
              {!loading && loadError && <div className="session-tree-message is-error">{loadError}</div>}
              {!loading && !loadError && tree.length === 0 && (
                <div className="session-tree-message">还没有笔记，点右上角 + 新建</div>
              )}
              {!loadError && tree.map((node) => renderNode(node, 0))}
            </div>
          </div>
        </div>

        <div className="dashboard-sidebar-footer notes-footer">
          <button
            type="button"
            className={`notes-footer-button${agentOpen ? " is-active" : ""}`}
            aria-pressed={agentOpen}
            title="笔记 agent"
            onClick={() => setAgentOpen((open) => !open)}
          >
            <AgentIcon />
            <span>Agent</span>
          </button>
          <button
            type="button"
            className="notes-footer-button"
            title="笔记设置"
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon />
            <span>设置</span>
          </button>
        </div>
      </aside>

      {sidebarOpen && (
        <button
          type="button"
          className="dashboard-sidebar-backdrop"
          aria-label="收起目录"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="dashboard-main">
        {/* A whiteboard is the canvas: no name, no save status, no bar on desktop. */}
        <header className={`dashboard-topbar${boardOpen ? " notes-board-topbar" : ""}${treeHidden ? " is-tree-shown" : ""}`}>
          <button
            type="button"
            className={`dashboard-menu-button${treeHidden ? " is-visible" : ""}`}
            aria-label="展开目录"
            onClick={() => (isMobile ? setSidebarOpen(true) : setTreeHidden(false))}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          {!boardOpen && (selectedFile ? (
            <>
              <span className="notes-crumb">{parentPath(selectedFile.path) || "根目录"}</span>
              <input
                className="notes-title-input"
                value={titleDraft}
                aria-label="标题"
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => void commitTitle()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    setTitleDraft(titleOf(selectedFile.name));
                    event.currentTarget.blur();
                  }
                }}
              />
              <span className={`notes-save notes-save-${saveState}`}>{SAVE_LABELS[saveState]}</span>
            </>
          ) : (
            <span className="dashboard-board-title">Notes</span>
          ))}
          {!boardOpen && actionError && <span className="notes-action-error">{actionError}</span>}
        </header>
        <div className="notes-content">
          {selectedFile ? (
            selectedFile.type === "board" ? (
              <Whiteboard
                key={`${selectedFile.path}:${vaultKey}:${board.fontFamily}:${board.fontSize}`}
                path={selectedFile.path}
                board={board}
                onSaveState={handleSaveState}
                onFlushReady={registerEditor}
              />
            ) : (
              <NoteEditor key={`${selectedFile.path}:${vaultKey}`} path={selectedFile.path} onSaveState={handleSaveState} onFlushReady={registerEditor} />
            )
          ) : (
            <div className="dashboard-empty">
              {selectedNode?.type === "dir"
                ? "点目录行的 + 在这里新建笔记、白板或子目录"
                : selectedPath === "" ? "点 + 在根目录新建，或从左侧选择" : "从左侧选择，或点 + 新建"}
            </div>
          )}
          <NotesAgentPanel
            open={agentOpen}
            contextPath={selectedFile?.path ?? null}
            onClose={() => setAgentOpen(false)}
            onOpenSettings={() => setSettingsOpen(true)}
            onVaultChanged={handleVaultChanged}
          />
        </div>
      </main>

      <SidebarMenu
        open={menu !== null}
        anchor={menu?.anchor ?? null}
        sheet={isMobile}
        ariaLabel="新建"
        title={menu?.dir ? `在 ${menu.dir} 新建` : "在根目录新建"}
        cancelLabel="取消"
        returnFocusTo={menu?.returnTo ?? plusRef.current}
        width={200}
        items={CREATE_ITEMS.map((item) => ({
          type: "item" as const,
          id: item.kind,
          label: item.kind === "dir" && menu?.dir ? "新建子目录" : item.label,
          note: item.hint,
          onSelect: () => startCreate(item.kind, menu?.dir ?? ""),
        }))}
        onClose={() => setMenu(null)}
      />

      <NotesSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={setSettings}
      />
    </div>
  );
}

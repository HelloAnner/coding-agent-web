"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppSwitcher } from "@/components/AppSwitcher";
import { ChevronIcon, FolderIcon, PlusIcon, TrashIcon } from "@/components/SidebarIcons";
import { SidebarMenu, type SidebarMenuAnchor } from "@/components/SidebarMenu";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { WebApp } from "@/lib/apps";
import type { NotesEditorControl, NotesNode, NotesSaveState } from "@/notes/types";
import { NoteEditor } from "./NoteEditor";
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

function baseName(relative: string): string {
  return relative.split("/").pop() ?? relative;
}

function parentPath(relative: string): string {
  return relative.split("/").slice(0, -1).join("/");
}

function titleOf(name: string): string {
  return name.replace(/\.(md|excalidraw)$/i, "");
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
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<SidebarMenuAnchor | null>(null);
  const [creating, setCreating] = useState<CreateKind | null>(null);
  const [draftName, setDraftName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameCancelled = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<NotesSaveState>("saved");
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
  const targetDir = selectedNode?.type === "dir"
    ? selectedNode.path
    : selectedNode
      ? parentPath(selectedNode.path)
      : "";

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

  // The tree is read when the app comes into view, not at shell startup, and
  // again on every return: files can change outside the app.
  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

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
    setMenuAnchor({
      kind: "rect",
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      align: "end",
    });
  };

  const startCreate = (kind: CreateKind) => {
    setCreating(kind);
    setDraftName("");
    setCreateError(null);
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!creating) return;
    const name = draftName.trim();
    if (!name) return;
    setCreateError(null);
    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: creating === "dir" ? "mkdir" : "create",
          dir: targetDir,
          name,
          kind: creating === "dir" ? undefined : creating,
        }),
      });
      const body = await response.json() as { node?: NotesNode; error?: string };
      if (!response.ok || !body.node) throw new Error(body.error || "创建失败");
      const node = body.node;
      setCreating(null);
      setDraftName("");
      await refresh();
      if (creating === "dir") {
        setExpanded((current) => new Set(current).add(node.path));
        selectPath(node.path);
        router.replace("/notes", { scroll: false });
      } else {
        if (targetDir) setExpanded((current) => new Set(current).add(targetDir));
        selectPath(node.path);
        router.replace(`/notes?path=${encodeURIComponent(node.path)}`, { scroll: false });
      }
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "创建失败");
    }
  };

  const renameNode = async (node: NotesNode, name: string): Promise<boolean> => {
    if (node.type === "dir") return false;
    const next = name.trim();
    if (!next || next === titleOf(node.name)) return true;
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
      // The user may have clicked another file while the request was in
      // flight; their newer selection wins over the renamed one.
      if (wasOpen && selectedPathRef.current === node.path) {
        selectPath(nextPath);
        setTitleDraft(titleOf(baseName(nextPath)));
        router.replace(`/notes?path=${encodeURIComponent(nextPath)}`, { scroll: false });
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
    if (node.type === "dir") return;
    setRenamingPath(node.path);
    setRenameDraft(titleOf(node.name));
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
          style={{ paddingLeft: 20 + depth * 14 }}
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
              aria-label={open ? "收起目录" : "展开目录"}
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
                title={isDir ? node.path : `${node.path}（双击重命名）`}
                onClick={() => selectFile(node)}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  startRename(node);
                }}
              >
                {isDir && <FolderIcon size={12} className="notes-tree-folder" />}
                <span className="session-tree-title">{label}</span>
              </button>
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
      className="dashboard-app notes-app"
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
            ref={plusRef}
            type="button"
            className={`sidebar-search-toggle${menuAnchor ? " is-active" : ""}`}
            title="新建"
            aria-label="新建"
            aria-haspopup="menu"
            aria-expanded={menuAnchor !== null}
            onClick={() => (menuAnchor ? setMenuAnchor(null) : openMenu())}
          >
            <PlusIcon size={16} />
          </button>
        </div>

        {creating && (
          <form className="notes-create" onSubmit={(event) => void submitCreate(event)}>
            <div className="notes-create-head">
              <span>{CREATE_ITEMS.find((item) => item.kind === creating)?.label}</span>
              <span className="notes-create-target">在 {targetDir || "根目录"}</span>
            </div>
            <input
              autoFocus
              value={draftName}
              aria-label="名称"
              placeholder={creating === "dir" ? "目录名称" : creating === "board" ? "白板名称" : "笔记标题"}
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

        <div className="dashboard-sidebar-footer">
          <span>新建于 {targetDir || "根目录"}</span>
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
        <header className="dashboard-topbar">
          <button
            type="button"
            className="dashboard-menu-button"
            aria-label="展开目录"
            onClick={() => setSidebarOpen(true)}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          {selectedFile ? (
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
          )}
          {actionError && <span className="notes-action-error">{actionError}</span>}
        </header>
        <div className="notes-content">
          {selectedFile ? (
            selectedFile.type === "board" ? (
              <Whiteboard key={selectedFile.path} path={selectedFile.path} onSaveState={handleSaveState} onFlushReady={registerEditor} />
            ) : (
              <NoteEditor key={selectedFile.path} path={selectedFile.path} onSaveState={handleSaveState} onFlushReady={registerEditor} />
            )
          ) : (
            <div className="dashboard-empty">
              {selectedNode?.type === "dir"
                ? "在这个目录下新建笔记或白板"
                : selectedPath === "" ? "点 + 在根目录新建，或从左侧选择" : "从左侧选择，或点 + 新建"}
            </div>
          )}
        </div>
      </main>

      <SidebarMenu
        open={menuAnchor !== null}
        anchor={menuAnchor}
        sheet={isMobile}
        ariaLabel="新建"
        title="新建"
        cancelLabel="取消"
        returnFocusTo={plusRef.current}
        width={200}
        items={CREATE_ITEMS.map((item) => ({
          type: "item" as const,
          id: item.kind,
          label: item.label,
          note: item.hint,
          onSelect: () => startCreate(item.kind),
        }))}
        onClose={() => setMenuAnchor(null)}
      />
    </div>
  );
}

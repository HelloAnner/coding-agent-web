"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { subscribeNotesWatch } from "@/lib/notes-watch";
import type { NotesBoardSettings, NotesBoardView, NotesEditorControl, NotesSaveState } from "@/notes/types";

const Canvas = dynamic(() => import("./WhiteboardCanvas"), {
  ssr: false,
  loading: () => <div className="dashboard-empty">加载白板…</div>,
});

const AUTOSAVE_MS = 700;
const VIEW_SAVE_MS = 600;

/** A stored board: fetch its scene, autosave Excalidraw's serialized JSON. */
export function Whiteboard({
  path,
  board,
  onSaveState,
  onFlushReady,
}: {
  path: string;
  board: NotesBoardSettings;
  onSaveState: (state: NotesSaveState) => void;
  onFlushReady: (control: NotesEditorControl | null) => void;
}) {
  const { isDark } = useTheme();
  const [content, setContent] = useState<string | null>(null);
  const [view, setView] = useState<NotesBoardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when someone else rewrote the file: the canvas only reads its
  // scene on mount, so a new key is what makes it re-parse.
  const [revision, setRevision] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ path: string; scene: string } | null>(null);
  // The last scene on disk. Excalidraw may report the same scene again after a
  // status re-render; skipping it stops save -> re-render -> save loops.
  const lastSaved = useRef<string | null>(null);
  // Pan and zoom are not part of an Excalidraw file, so they live in the
  // database: a debounce keeps a drag from writing on every pointer move.
  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingView = useRef<{ path: string; view: NotesBoardView } | null>(null);
  const lastView = useRef<NotesBoardView | null>(null);

  const save = useCallback(async (target: string, scene: string, keepalive = false): Promise<boolean> => {
    onSaveState("saving");
    try {
      const response = await fetch(`/api/notes/file?path=${encodeURIComponent(target)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: scene }),
        keepalive,
      });
      if (!response.ok) throw new Error("保存失败");
      lastSaved.current = scene;
      onSaveState("saved");
      return true;
    } catch {
      onSaveState("error");
      return false;
    }
  }, [onSaveState]);

  const saveView = useCallback((target: string, next: NotesBoardView, keepalive = false) => {
    // The viewport is a convenience, not user data: a failed write just means
    // the next board opens at the old place.
    void fetch(`/api/notes/view?path=${encodeURIComponent(target)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
      keepalive,
    }).catch(() => {});
  }, []);

  const handleViewChange = useCallback((next: NotesBoardView) => {
    const last = lastView.current;
    if (last && last.scrollX === next.scrollX && last.scrollY === next.scrollY && last.zoom === next.zoom) return;
    lastView.current = next;
    pendingView.current = { path, view: next };
    if (viewTimer.current) clearTimeout(viewTimer.current);
    viewTimer.current = setTimeout(() => {
      viewTimer.current = null;
      const queued = pendingView.current;
      if (!queued) return;
      pendingView.current = null;
      saveView(queued.path, queued.view);
    }, VIEW_SAVE_MS);
  }, [path, saveView]);

  useEffect(() => {
    let alive = true;
    setContent(null);
    setError(null);
    // The board is only mounted once both answers are in: the canvas takes its
    // starting viewport from initialData, not from a later update.
    Promise.all([
      fetch(`/api/notes/file?path=${encodeURIComponent(path)}`, { cache: "no-store" }).then(async (response) => {
        const body = await response.json() as { content?: string; error?: string };
        if (!response.ok) throw new Error(body.error || "读取白板失败");
        return body.content ?? "";
      }),
      fetch(`/api/notes/view?path=${encodeURIComponent(path)}`, { cache: "no-store" })
        .then(async (response) => response.ok
          ? (await response.json() as { view?: NotesBoardView | null }).view ?? null
          : null)
        .catch(() => null),
    ])
      .then(([text, stored]) => {
        if (!alive) return;
        lastSaved.current = text;
        lastView.current = stored;
        setView(stored);
        setContent(text);
        onSaveState("saved");
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : "读取白板失败");
      });
    return () => {
      alive = false;
    };
  }, [path, onSaveState]);

  // The file can change under us (an agent rewriting the board). Our own
  // saves echo back through the same stream, so a reload only happens when
  // the file differs from what was last saved. ponytail: unsaved strokes win —
  // a change that lands mid-draw is skipped, not merged; add a conflict
  // prompt if agents start editing boards a person is drawing on.
  useEffect(() => subscribeNotesWatch((paths) => {
    if (paths && !paths.includes(path)) return;
    void (async () => {
      // Nothing is loaded yet: the initial read has the newest file anyway.
      if (pending.current || lastSaved.current === null) return;
      try {
        const response = await fetch(`/api/notes/file?path=${encodeURIComponent(path)}`, { cache: "no-store" });
        if (!response.ok) return;
        const text = (await response.json() as { content?: string }).content;
        if (typeof text !== "string" || text === lastSaved.current) return;
        lastSaved.current = text;
        // Keep the viewport the user is looking at, not the one on disk.
        setView((current) => lastView.current ?? current);
        setContent(text);
        setRevision((value) => value + 1);
      } catch {
        // Keep the board as it is; the next change tries again.
      }
    })();
  }), [path]);

  // A board leaves the screen (file switch, app switch, reload) with up to
  // one debounce window of edits: send them with keepalive on the way out.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    const latest = pending.current;
    if (latest) void save(latest.path, latest.scene, true);
    if (viewTimer.current) clearTimeout(viewTimer.current);
    const queued = pendingView.current;
    if (queued) saveView(queued.path, queued.view, true);
  }, [save, saveView]);

  // A rename runs this first: the board must be current before its path moves.
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const latest = pending.current;
    if (!latest) return true;
    pending.current = null;
    return save(latest.path, latest.scene);
  }, [save]);

  const discard = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pending.current = null;
  }, []);

  useEffect(() => {
    onFlushReady({ flush, discard });
    return () => onFlushReady(null);
  }, [discard, flush, onFlushReady]);

  // Closing or reloading the tab skips React's unmount; send the last window.
  useEffect(() => {
    const flushOnHide = () => {
      const latest = pending.current;
      if (latest) void save(latest.path, latest.scene, true);
      const queued = pendingView.current;
      if (queued) saveView(queued.path, queued.view, true);
    };
    window.addEventListener("pagehide", flushOnHide);
    return () => window.removeEventListener("pagehide", flushOnHide);
  }, [save, saveView]);

  const handleChange = useCallback((scene: string) => {
    if (scene === lastSaved.current) {
      // Back to what the file already holds (an undo, or Excalidraw reporting
      // the same scene again): drop a queued save instead of writing the
      // intermediate scene over it.
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      pending.current = null;
      onSaveState("saved");
      return;
    }
    pending.current = { path, scene };
    onSaveState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const latest = pending.current;
      if (!latest) return;
      pending.current = null;
      void save(latest.path, latest.scene);
    }, AUTOSAVE_MS);
  }, [onSaveState, path, save]);

  if (error) return <div className="notes-error">{error}</div>;
  if (content === null) return <div className="dashboard-empty">加载白板…</div>;
  return (
    <Canvas
      key={`${path}:${revision}`}
      content={content}
      view={view}
      theme={isDark ? "dark" : "light"}
      board={board}
      onChange={handleChange}
      onViewChange={handleViewChange}
    />
  );
}

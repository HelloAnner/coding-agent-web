"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import type { NotesEditorControl, NotesSaveState } from "@/notes/types";

const Canvas = dynamic(() => import("./WhiteboardCanvas"), {
  ssr: false,
  loading: () => <div className="dashboard-empty">加载白板…</div>,
});

const AUTOSAVE_MS = 700;

/** A stored board: fetch its scene, autosave Excalidraw's serialized JSON. */
export function Whiteboard({
  path,
  onSaveState,
  onFlushReady,
}: {
  path: string;
  onSaveState: (state: NotesSaveState) => void;
  onFlushReady: (control: NotesEditorControl | null) => void;
}) {
  const { isDark } = useTheme();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ path: string; scene: string } | null>(null);
  // The last scene on disk. Excalidraw may report the same scene again after a
  // status re-render; skipping it stops save -> re-render -> save loops.
  const lastSaved = useRef<string | null>(null);

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

  useEffect(() => {
    let alive = true;
    setContent(null);
    setError(null);
    fetch(`/api/notes/file?path=${encodeURIComponent(path)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { content?: string; error?: string };
        if (!response.ok) throw new Error(body.error || "读取白板失败");
        if (alive) {
          setContent(body.content ?? "");
          lastSaved.current = body.content ?? "";
          onSaveState("saved");
        }
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : "读取白板失败");
      });
    return () => {
      alive = false;
    };
  }, [path, onSaveState]);

  // A board leaves the screen (file switch, app switch, reload) with up to
  // one debounce window of edits: send them with keepalive on the way out.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    const latest = pending.current;
    if (latest) void save(latest.path, latest.scene, true);
  }, [save]);

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
    };
    window.addEventListener("pagehide", flushOnHide);
    return () => window.removeEventListener("pagehide", flushOnHide);
  }, [save]);

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
      key={path}
      content={content}
      theme={isDark ? "dark" : "light"}
      onChange={handleChange}
    />
  );
}

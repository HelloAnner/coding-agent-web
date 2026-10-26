"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import type { NotesEditorControl, NotesSaveState } from "@/notes/types";

const AUTOSAVE_MS = 700;

/** A Markdown note: plain text on disk, rendered only in the preview. */
export function NoteEditor({
  path,
  onSaveState,
  onFlushReady,
}: {
  path: string;
  onSaveState: (state: NotesSaveState) => void;
  onFlushReady: (control: NotesEditorControl | null) => void;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ path: string; body: string } | null>(null);

  const save = useCallback(async (target: string, text: string, keepalive = false): Promise<boolean> => {
    onSaveState("saving");
    try {
      const response = await fetch(`/api/notes/file?path=${encodeURIComponent(target)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
        keepalive,
      });
      if (!response.ok) throw new Error("保存失败");
      onSaveState("saved");
      return true;
    } catch {
      onSaveState("error");
      return false;
    }
  }, [onSaveState]);

  useEffect(() => {
    let alive = true;
    setBody(null);
    setError(null);
    fetch(`/api/notes/file?path=${encodeURIComponent(path)}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as { content?: string; error?: string };
        if (!response.ok) throw new Error(data.error || "读取笔记失败");
        if (alive) {
          setBody(data.content ?? "");
          onSaveState("saved");
        }
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : "读取笔记失败");
      });
    return () => {
      alive = false;
    };
  }, [path, onSaveState]);

  // Switching file or app unmounts the editor with up to one debounce window
  // of edits; send them with keepalive so nothing typed is lost.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    const latest = pending.current;
    if (latest) void save(latest.path, latest.body, true);
  }, [save]);

  // A rename runs this first: the file must be current before its path moves.
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const latest = pending.current;
    if (!latest) return true;
    pending.current = null;
    return save(latest.path, latest.body);
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
      if (latest) void save(latest.path, latest.body, true);
    };
    window.addEventListener("pagehide", flushOnHide);
    return () => window.removeEventListener("pagehide", flushOnHide);
  }, [save]);

  const update = (text: string) => {
    setBody(text);
    pending.current = { path, body: text };
    onSaveState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const latest = pending.current;
      if (!latest) return;
      pending.current = null;
      void save(latest.path, latest.body);
    }, AUTOSAVE_MS);
  };

  if (error) return <div className="notes-error">{error}</div>;
  if (body === null) return <div className="dashboard-empty">加载笔记…</div>;

  return (
    <div className="notes-note">
      <div className="notes-note-bar">
        <button
          type="button"
          className={`notes-mode${preview ? "" : " is-active"}`}
          onClick={() => setPreview(false)}
        >
          编辑
        </button>
        <button
          type="button"
          className={`notes-mode${preview ? " is-active" : ""}`}
          onClick={() => setPreview(true)}
        >
          预览
        </button>
        <span className="notes-note-hint">
          {preview ? "Markdown 预览" : "Markdown · ⌘S 立即保存"}
        </span>
      </div>
      {preview ? (
        <article className="notes-preview">
          <MarkdownBody>{body}</MarkdownBody>
        </article>
      ) : (
        <textarea
          className="notes-note-body"
          value={body}
          placeholder="写点什么…"
          spellCheck={false}
          onChange={(event) => update(event.target.value)}
          onBlur={() => void flush()}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void flush();
            }
          }}
        />
      )}
    </div>
  );
}

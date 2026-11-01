"use client";

import { useSyncExternalStore } from "react";
import { boardAppState, DEFAULT_BOARD_SETTINGS } from "@/notes/board-style";
import type { NotesBoardSettings, NotesSettings } from "@/notes/types";

let preferences: NotesBoardSettings | null = null;
let pending: NotesBoardSettings | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Publish without writing again after the settings dialog or a server read. */
export function applyBoardPreferences(next: NotesBoardSettings): boolean {
  if (preferences && JSON.stringify(boardAppState(preferences)) === JSON.stringify(boardAppState(next))) return false;
  preferences = next;
  if (pending) pending = next;
  listeners.forEach((listener) => listener());
  return true;
}

async function flush(): Promise<void> {
  if (!pending || saving) return;
  const next = pending;
  saving = true;
  try {
    const response = await fetch("/api/notes/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board: next }),
      keepalive: true,
    });
    if (!response.ok) throw new Error("保存白板偏好失败");
    const body = await response.json() as { settings: NotesSettings };
    if (pending === next) {
      pending = null;
      applyBoardPreferences(body.settings.board);
    }
  } catch {
    // Keep the latest preferences in memory; retry on focus, edit or unmount.
  } finally {
    saving = false;
    if (pending && pending !== next) void flush();
  }
}

export function saveBoardPreferences(next: NotesBoardSettings): void {
  if (!applyBoardPreferences(next)) return;
  pending = next;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void flush(); }, 300);
}

async function refresh(): Promise<void> {
  if (pending) return;
  if (loading) return loading;
  const before = preferences;
  loading = fetch("/api/notes/settings", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error("读取白板偏好失败");
      const body = await response.json() as { settings: NotesSettings };
      // A late read must not roll back a style changed while it was in flight.
      if (preferences === before && !pending) applyBoardPreferences(body.settings.board);
    })
    .catch(() => { if (!preferences) applyBoardPreferences(DEFAULT_BOARD_SETTINGS); })
    .finally(() => { loading = null; });
  return loading;
}

function flushOnHide(): void { void flush(); }
function refreshOnFocus(): void { void flush(); void refresh(); }

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("pagehide", flushOnHide);
    window.addEventListener("focus", refreshOnFocus);
  }
  void refresh();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener("pagehide", flushOnHide);
      window.removeEventListener("focus", refreshOnFocus);
      if (timer) { clearTimeout(timer); timer = null; }
      void flush();
    }
  };
}

/** One store for Notes and Coding boards; the file is global, not per board. */
export function useBoardPreferences(): NotesBoardSettings | null {
  return useSyncExternalStore(subscribe, () => preferences, () => null);
}

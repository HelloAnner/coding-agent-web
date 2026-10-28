/**
 * The right panel's own state, remembered per conversation: whether the panel
 * is open, which tree it shows (files or notes), whether that column is folded,
 * which tabs are open and which one is active. The notes tree's open folders
 * and scroll position ride along. Switching to another session restores what
 * that session had; a fresh session starts empty.
 *
 * Everything here is plain JSON, so one localStorage map holds it all.
 * Best-effort: unavailable or foreign storage reads as no memory.
 */

import type { FileTreeSource } from "@/lib/sidebar-prefs";
import type { NotesFileKind } from "@/notes/types";
import type { Tab } from "./TabBar";

export interface NoteTab {
  path: string;
  name: string;
  kind: NotesFileKind;
}

/** What one conversation's right panel looked like. */
export interface SessionPanelState {
  open: boolean;
  treeSource: FileTreeSource;
  treeCollapsed: boolean;
  fileTabs: Tab[];
  noteTabs: NoteTab[];
  /** The active tab, restoring even a terminal or subagent tab while it lives. */
  activeTabId: string | null;
}

/** Where the notes tree was left: its folded folders and its scroll offset. */
export interface NotesTreePosition {
  expanded: string[];
  scrollTop: number;
}

type StoredEntry = Partial<SessionPanelState & NotesTreePosition>;

const STORAGE_KEY = "pi-web:session-panel";
/** Sessions kept, newest last: a conversation untouched for a long while is forgotten. */
const MAX_ENTRIES = 60;

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readAll(): Record<string, StoredEntry> {
  const storage = browserStorage();
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
    return isRecord(parsed) ? parsed as Record<string, StoredEntry> : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, StoredEntry>): void {
  const storage = browserStorage();
  if (!storage) return;
  const keys = Object.keys(all);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete all[key];
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable or full — memory is best-effort.
  }
}

/** One session's entry, moved last so the older ones are the ones dropped. */
function patch(sessionId: string, entry: StoredEntry): void {
  const all = readAll();
  const merged: StoredEntry = { ...all[sessionId], ...entry };
  const next: Record<string, StoredEntry> = {};
  for (const [key, value] of Object.entries(all)) if (key !== sessionId) next[key] = value;
  next[sessionId] = merged;
  writeAll(next);
}

function storedFileTabs(value: unknown): Tab[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tab): tab is Tab => isRecord(tab)
    && typeof tab.id === "string"
    && typeof tab.label === "string"
    && typeof tab.filePath === "string");
}

function storedNoteTabs(value: unknown): NoteTab[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tab): tab is NoteTab => isRecord(tab)
    && typeof tab.path === "string"
    && typeof tab.name === "string"
    && (tab.kind === "note" || tab.kind === "board"));
}

export function readSessionPanel(sessionId: string): SessionPanelState | null {
  const entry = readAll()[sessionId];
  if (!isRecord(entry)) return null;
  return {
    open: entry.open === true,
    treeSource: entry.treeSource === "notes" ? "notes" : "project",
    treeCollapsed: entry.treeCollapsed === true,
    fileTabs: storedFileTabs(entry.fileTabs),
    noteTabs: storedNoteTabs(entry.noteTabs),
    activeTabId: typeof entry.activeTabId === "string" ? entry.activeTabId : null,
  };
}

export function saveSessionPanel(sessionId: string, state: SessionPanelState): void {
  patch(sessionId, state);
}

/** A deleted conversation leaves nothing behind. */
export function forgetSessionPanel(sessionId: string): void {
  const all = readAll();
  if (!(sessionId in all)) return;
  delete all[sessionId];
  writeAll(all);
}

export function readNotesTreePosition(sessionId: string): NotesTreePosition | null {
  const entry = readAll()[sessionId];
  if (!isRecord(entry) || !Array.isArray(entry.expanded)) return null;
  const scrollTop = entry.scrollTop;
  return {
    expanded: strings(entry.expanded),
    scrollTop: typeof scrollTop === "number" && Number.isFinite(scrollTop) ? scrollTop : 0,
  };
}

export function saveNotesTreePosition(sessionId: string, position: NotesTreePosition): void {
  patch(sessionId, { expanded: position.expanded, scrollTop: position.scrollTop });
}

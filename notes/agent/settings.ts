import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { NotesBoardSettings, NotesSettings } from "../types";

/**
 * Notes' own settings file: whiteboard defaults only. Model/auth configuration
 * belongs to the source conversation (or pi defaults for the standalone panel).
 * Kept beside the app's SQLite database, not in the vault, so the notes tree
 * holds notes only. Written by the notes settings dialog, read by the agent
 * runtime and the whiteboard.
 */

export const NOTES_SETTINGS_FILE = "notes-settings.json";

/** Excalidraw's built-in families, with the values the scene JSON uses. */
export const BOARD_FONT_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 1, label: "Virgil（手写）" },
  { value: 2, label: "Helvetica（无衬线）" },
  { value: 3, label: "Cascadia（等宽）" },
  { value: 5, label: "Excalifont（默认）" },
  { value: 6, label: "Nunito（圆润）" },
  { value: 7, label: "Lilita One（标题）" },
  { value: 8, label: "Comic Shanns（漫画）" },
  { value: 9, label: "Liberation Sans（正文）" },
];

const BOARD_FONT_VALUES = new Set(BOARD_FONT_OPTIONS.map((option) => option.value));

export const BOARD_FONT_SIZE_MIN = 10;
export const BOARD_FONT_SIZE_MAX = 64;

export function notesDataDir(): string {
  const file = process.env.CODING_AGENT_WEB_DATA || path.join(homedir(), ".coding-agent-web", "data.db");
  return path.dirname(file);
}

export function notesSettingsPath(): string {
  return path.join(notesDataDir(), NOTES_SETTINGS_FILE);
}

export function defaultNotesSettings(): NotesSettings {
  return {
    board: { fontFamily: 3, fontSize: 20 },
  };
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** Whatever is on disk, made complete and inside the ranges the UI offers. */
export function normalizeNotesSettings(raw: unknown): NotesSettings {
  const defaults = defaultNotesSettings();
  if (typeof raw !== "object" || raw === null) return defaults;
  const record = raw as Record<string, unknown>;
  const board = (typeof record.board === "object" && record.board !== null ? record.board : {}) as Record<string, unknown>;
  const fontFamily = positiveInt(board.fontFamily, defaults.board.fontFamily, 1, 99);
  return {
    board: {
      fontFamily: BOARD_FONT_VALUES.has(fontFamily) ? fontFamily : defaults.board.fontFamily,
      fontSize: positiveInt(board.fontSize, defaults.board.fontSize, BOARD_FONT_SIZE_MIN, BOARD_FONT_SIZE_MAX),
    },
  };
}

export function readNotesSettings(): NotesSettings {
  const file = notesSettingsPath();
  if (!existsSync(file)) return defaultNotesSettings();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // A hand-broken file must not take the notes app down; defaults are usable.
    return defaultNotesSettings();
  }
  const settings = normalizeNotesSettings(raw);
  // Retire stored notes credentials as well as the UI; never keep a hidden fallback.
  if (typeof raw === "object" && raw !== null && "agent" in raw) writeNotesSettings(settings);
  return settings;
}

/** Replace settings atomically, keeping legacy files private while removing old credentials. */
export function writeNotesSettings(settings: NotesSettings): NotesSettings {
  settings = normalizeNotesSettings(settings);
  const file = notesSettingsPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.${NOTES_SETTINGS_FILE}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Renamed already.
    }
  }
  return settings;
}

/** Merge only whiteboard preferences; obsolete model/auth fields are ignored. */
export function updateNotesSettings(patch: unknown): NotesSettings {
  const current = readNotesSettings();
  const record = (typeof patch === "object" && patch !== null ? patch : {}) as Record<string, unknown>;
  const board = (typeof record.board === "object" && record.board !== null ? record.board : null) as Partial<NotesBoardSettings> | null;
  return writeNotesSettings(normalizeNotesSettings({
    board: board ? { ...current.board, ...board } : current.board,
  }));
}

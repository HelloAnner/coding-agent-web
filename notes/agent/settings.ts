import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { NotesAgentModelSettings, NotesBoardSettings, NotesSettings } from "../types";

/**
 * Notes' own settings file: the agent's model and the whiteboard defaults.
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
    agent: {
      baseUrl: "",
      apiKey: "",
      model: "",
      api: "openai-completions",
      contextWindow: 128000,
      maxTokens: 8192,
    },
    board: { fontFamily: 3, fontSize: 20 },
  };
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
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
  const agent = (typeof record.agent === "object" && record.agent !== null ? record.agent : {}) as Record<string, unknown>;
  const board = (typeof record.board === "object" && record.board !== null ? record.board : {}) as Record<string, unknown>;
  const fontFamily = positiveInt(board.fontFamily, defaults.board.fontFamily, 1, 99);
  return {
    agent: {
      baseUrl: text(agent.baseUrl, defaults.agent.baseUrl).replace(/\/+$/, ""),
      apiKey: text(agent.apiKey, defaults.agent.apiKey),
      model: text(agent.model, defaults.agent.model),
      api: text(agent.api, defaults.agent.api) || defaults.agent.api,
      contextWindow: positiveInt(agent.contextWindow, defaults.agent.contextWindow, 1000, 10_000_000),
      maxTokens: positiveInt(agent.maxTokens, defaults.agent.maxTokens, 256, 1_000_000),
    },
    board: {
      fontFamily: BOARD_FONT_VALUES.has(fontFamily) ? fontFamily : defaults.board.fontFamily,
      fontSize: positiveInt(board.fontSize, defaults.board.fontSize, BOARD_FONT_SIZE_MIN, BOARD_FONT_SIZE_MAX),
    },
  };
}

export function readNotesSettings(): NotesSettings {
  const file = notesSettingsPath();
  if (!existsSync(file)) return defaultNotesSettings();
  try {
    return normalizeNotesSettings(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    // A hand-broken file must not take the notes app down; defaults are usable.
    return defaultNotesSettings();
  }
}

/** Write the whole file at mode 0600: it holds an API key. */
export function writeNotesSettings(settings: NotesSettings): NotesSettings {
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

/**
 * Merge a partial update from the settings dialog over what is on disk. An
 * empty API key means "keep the stored one": the browser never receives it, so
 * an untouched field comes back empty.
 */
export function updateNotesSettings(patch: unknown): NotesSettings {
  const current = readNotesSettings();
  const record = (typeof patch === "object" && patch !== null ? patch : {}) as Record<string, unknown>;
  const agent = { ...((typeof record.agent === "object" && record.agent !== null ? record.agent : {}) as Partial<NotesAgentModelSettings>) };
  const board = (typeof record.board === "object" && record.board !== null ? record.board : null) as Partial<NotesBoardSettings> | null;
  if (typeof agent.apiKey !== "string" || !agent.apiKey.trim()) delete agent.apiKey;
  return writeNotesSettings(normalizeNotesSettings({
    agent: { ...current.agent, ...agent },
    board: board ? { ...current.board, ...board } : current.board,
  }));
}

/** The settings as the browser may see them: never the stored API key. */
export function publicNotesSettings(settings: NotesSettings): { settings: NotesSettings; apiKeySet: boolean } {
  return {
    settings: { ...settings, agent: { ...settings.agent, apiKey: "" } },
    apiKeySet: settings.agent.apiKey.length > 0,
  };
}

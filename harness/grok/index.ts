import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HarnessModelsError, type HarnessDescriptor } from "../types";
import { grokDefaultModelId, parseGrokModelsCache, type GrokModelRecord } from "./models";

function expandHome(configured: string): string {
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return path.join(homedir(), configured.slice(2));
  return configured;
}

/** Grok home. `GROK_HOME` overrides `~/.grok`. */
export function grokHome(): string {
  const configured = process.env.GROK_HOME;
  if (!configured) return path.join(homedir(), ".grok");
  return expandHome(configured);
}

export function grokModelsCacheFile(): string {
  return path.join(grokHome(), "models_cache.json");
}

export function grokConfigFile(): string {
  return path.join(grokHome(), "config.toml");
}

/**
 * Grok's per-directory session root: `~/.grok/sessions/<url-encoded cwd>`.
 * `encodeURIComponent` is exactly the encoding grok uses (`/` -> `%2F`).
 */
export function grokSessionsRoot(cwd: string): string {
  return path.join(grokHome(), "sessions", encodeURIComponent(cwd));
}

/** The transcript grok keeps for one session. Not written by this app. */
export function grokHistoryFile(cwd: string, sessionId: string): string {
  return path.join(grokSessionsRoot(cwd), sessionId, "chat_history.jsonl");
}

/**
 * Grok encodes the real path, not the symlinked one (`/tmp/x` lands under
 * `/private/tmp/x`), so a session started in a symlinked folder is only found
 * under its resolved spelling.
 */
export function resolveGrokHistoryFile(cwd: string, sessionId: string): string | null {
  const direct = grokHistoryFile(cwd, sessionId);
  if (existsSync(direct)) return direct;
  try {
    const resolved = grokHistoryFile(realpathSync(cwd), sessionId);
    if (resolved !== direct && existsSync(resolved)) return resolved;
  } catch {
    /* the folder is gone; the direct spelling is all we have */
  }
  return null;
}

/** The grok executable. `PI_WEB_GROK_BIN` wins, then the two install layouts. */
export function grokBin(): string {
  const configured = process.env.PI_WEB_GROK_BIN?.trim();
  if (configured) return configured;
  const candidates = [
    path.join(homedir(), ".local", "bin", "grok"),
    path.join(grokHome(), "bin", "grok"),
  ];
  return candidates.find((file) => existsSync(file)) ?? "grok";
}

/**
 * Tool-permission mode for headless turns. It is passed on every run so the web
 * does not depend on the TUI's own `[ui] permission_mode`.
 */
export function grokPermissionMode(): string {
  return process.env.PI_WEB_GROK_PERMISSION_MODE?.trim() || "bypassPermissions";
}

/**
 * Headless `grok -p` takes text only, so attached images are written next to
 * the run and named in the prompt. The marker is stripped again when the
 * transcript is read, so a reload shows the text the user typed.
 */
const ATTACHMENT_MARKER = /\n*\[attached images\][^\n]*\n(?:\S+\n?)*$/i;

export function grokPromptWithImages(text: string, files: string[]): string {
  if (files.length === 0) return text;
  const body = ["[attached images] open each file below before answering", ...files].join("\n");
  return text.trim() ? `${text.trim()}\n\n${body}` : body;
}

export function stripGrokAttachments(text: string): string {
  return text.replace(ATTACHMENT_MARKER, "").trim();
}

export const grokHarness: HarnessDescriptor = {
  id: "grok",
  label: "grok",
  configDir: grokHome,
  readModels() {
    try {
      const file = readGrokModels();
      return { path: file.path, models: file.models };
    } catch {
      throw new HarnessModelsError("Grok's model list was not found", grokModelsCacheFile());
    }
  },
};

export interface GrokModelsFile {
  path: string;
  models: GrokModelRecord[];
}

/** Official model list. Does not start the grok process and does not return credentials. */
export function readGrokModels(cacheFile = grokModelsCacheFile(), configFile = grokConfigFile()): GrokModelsFile {
  const text = readFileSync(cacheFile, "utf8");
  let configText: string | null = null;
  try { configText = readFileSync(configFile, "utf8"); } catch { configText = null; }
  return {
    path: cacheFile,
    models: parseGrokModelsCache(text, grokDefaultModelId(configText, process.env.GROK_DEFAULT_MODEL)),
  };
}

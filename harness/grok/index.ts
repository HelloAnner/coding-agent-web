import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { HarnessDescriptor } from "../types";
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

export const grokHarness: HarnessDescriptor = {
  id: "grok",
  label: "grok",
  configDir: grokHome,
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

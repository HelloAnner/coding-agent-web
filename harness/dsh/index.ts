import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { HarnessDescriptor } from "../types";
import { parseDshToml, updateDshModel, type DshModelRecord, type DshProviderRecord } from "./toml";

/** ds.toml. `DSH_DS_TOML` overrides the default `~/bin/ds/ds.toml`. */
export function dshConfigFile(): string {
  const configured = process.env.DSH_DS_TOML;
  if (configured) return configured;
  return path.join(homedir(), "bin", "ds", "ds.toml");
}

/** Session files. `DSH_HOME` overrides `~/.dsh`. */
export function dshHome(): string {
  return process.env.DSH_HOME || path.join(homedir(), ".dsh");
}

export const dshHarness: HarnessDescriptor = {
  id: "dsh",
  label: "dsh",
  configDir() {
    return path.dirname(dshConfigFile());
  },
};

export interface DshModelsFile {
  path: string;
  providers: DshProviderRecord[];
  models: DshModelRecord[];
}

export function readDshModels(file = dshConfigFile()): DshModelsFile {
  const text = readFileSync(file, "utf8");
  const parsed = parseDshToml(text);
  return { path: file, ...parsed };
}

/** Write a model's name or enabled flag back into ds.toml. Returns false if the key is missing. */
export function writeDshModel(key: string, patch: { name?: string; enabled?: boolean }, file = dshConfigFile()): boolean {
  const text = readFileSync(file, "utf8");
  const next = updateDshModel(text, key, patch);
  if (next === null) return false;
  if (next === text) return true;
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.tmp`);
  writeFileSync(temporary, next, { mode: 0o600 });
  renameSync(temporary, file);
  try { chmodSync(file, 0o600); } catch { /* the file may already be owned with a tighter mode */ }
  return true;
}

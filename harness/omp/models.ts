import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { HarnessModelList } from "../types";
import { ompAgentDir, ompProcessEnv } from "./index";
import { OmpError } from "./rpc";

/** One model the local `omp` binary reports, as its terminal session would use it. */
export interface OmpCatalogModel {
  provider: string; id: string; name: string; input: string[];
  reasoning: boolean; contextWindow: number; maxTokens: number; thinking: string[];
}

const CATALOG_TTL_MS = 15_000;
let cache: { binary: string; agentDir: string; at: number; models: Promise<OmpCatalogModel[]> } | null = null;

export function ompBinary(): string { return process.env.PI_WEB_OMP_BIN?.trim() || "omp"; }

/** Attention: OMP resolves its own providers, auth, models.yml and catalog here, exactly like the CLI. */
export async function readOmpCatalog(): Promise<OmpCatalogModel[]> {
  const binary = ompBinary(), agentDir = ompAgentDir();
  if (cache && cache.binary === binary && cache.agentDir === agentDir && Date.now() - cache.at < CATALOG_TTL_MS) return cache.models;
  const models = promisify(execFile)(binary, ["models", "--json"], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: ompProcessEnv() })
    .then(({ stdout }) => parseOmpCatalog(stdout))
    .catch((error) => { cache = null; throw error instanceof OmpError ? error : new OmpError("omp models could not be read. Check the local omp install and its provider config.", 503); });
  cache = { binary, agentDir, at: Date.now(), models };
  return models;
}

export function parseOmpCatalog(stdout: string): OmpCatalogModel[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new OmpError("omp models --json did not return JSON", 503); }
  const list = (parsed as { models?: unknown })?.models;
  if (!Array.isArray(list)) throw new OmpError("omp models --json returned no model list", 503);
  return list.flatMap((raw) => {
    const model = raw as Record<string, unknown>;
    if (model.kind !== undefined && model.kind !== "chat") return [];
    if (typeof model.provider !== "string" || typeof model.id !== "string") return [];
    return [{
      provider: model.provider, id: model.id, name: typeof model.name === "string" ? model.name : model.id,
      input: Array.isArray(model.input) ? model.input.filter((item): item is string => typeof item === "string") : ["text"],
      reasoning: model.reasoning === true,
      contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : 0,
      maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : 0,
      thinking: Array.isArray(model.thinking) ? model.thinking.filter((item): item is string => typeof item === "string") : [],
    }];
  });
}

/**
 * `modelRoles.default` from the native config, matching what a terminal session starts with.
 * A full selector carries a thinking suffix (`provider/model:level`); the level is dropped here.
 */
export function ompDefaultSelector(configYaml: string | null): string | null {
  if (!configYaml) return null;
  let inRoles = false;
  for (const line of configYaml.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\S/.test(line)) { inRoles = line.trim() === "modelRoles:"; continue; }
    if (!inRoles) continue;
    const match = /^\s+default:\s*(.+)$/.exec(line);
    if (!match) continue;
    const value = match[1].trim().replace(/^["']|["']$/g, "");
    return value ? value.replace(/:[a-z]+$/, "") : null;
  }
  return null;
}

async function defaultSelector(): Promise<string | null> {
  const text = await readFile(path.join(ompAgentDir(), "config.yml"), "utf8").catch(() => null);
  return ompDefaultSelector(text);
}

export async function selectedOmpModel(provider?: string, id?: string): Promise<OmpCatalogModel> {
  if ((provider !== undefined || id !== undefined) && (!provider || !id)) throw new OmpError("Select a provider and model id together");
  const models = await readOmpCatalog();
  const model = provider && id ? models.find((item) => item.provider === provider && item.id === id) : undefined;
  if (provider && id && !model) throw new OmpError(`${provider}/${id} is not in the local omp model list`);
  if (model) return model;
  const fallback = await defaultSelector();
  return models.find((item) => `${item.provider}/${item.id}` === fallback) ?? models[0]
    ?? (() => { throw new OmpError("omp reported no chat models. Configure a provider in the terminal first.", 503); })();
}

export async function listOmpModels(): Promise<HarnessModelList> {
  const [models, fallback] = await Promise.all([readOmpCatalog(), defaultSelector()]);
  return { path: ompAgentDir(), models: models.map((model) => ({
    key: JSON.stringify([model.provider, model.id]), name: model.name, provider: model.provider, model: model.id,
    enabled: true, isDefault: `${model.provider}/${model.id}` === fallback,
  })) };
}

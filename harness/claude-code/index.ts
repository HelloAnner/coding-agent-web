import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { catalogDbPath, readClaudeProjectTrust, writeClaudeProjectTrust } from "../../lib/catalog-db";
import { writePrivateFileAtomicSync } from "../../lib/atomic-file";
import { HarnessModelsError, type HarnessDescriptor } from "../types";

export interface ClaudeProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  configDir: string;
  enabled: boolean;
  env?: Record<string, string>;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode: "manual" | "acceptEdits" | "plan" | "bypassPermissions";
}

export function claudeConfigFile(): string {
  return path.join(path.dirname(path.resolve(catalogDbPath())), "claude-code.json");
}

export function expandClaudePath(value: string): string {
  return value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}

function canonicalProfilePath(directory: string): string {
  let ancestor = path.resolve(directory);
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("Claude Code profile has no accessible parent directory");
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(realpathSync(ancestor), ...missing);
}

function isDefaultProfile(directory: string): boolean {
  return canonicalProfilePath(directory) === canonicalProfilePath(path.join(homedir(), ".claude"));
}

/** Keep the existing per-model directory spelling, without depending on its creator. */
export function claudeProfileSlug(key: string): string {
  const slug = key.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "") || "profile";
  return slug.length > 64 ? `${slug.slice(0, 55)}-${createHash("sha1").update(key).digest("hex").slice(0, 8)}` : slug;
}

export function writeClaudeJson(file: string, value: unknown): void {
  const target = lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() ? realpathSync(file) : file;
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(target, JSON.stringify(value, null, 2) + "\n");
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonFile(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
    return value;
  } catch { throw new Error(`Invalid Claude Code JSON file: ${file}`); }
}

/** The only model source is the web's own file, beside its database. */
export function readClaudeProfiles(): ClaudeProfile[] {
  const file = claudeConfigFile();
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(file, JSON.stringify({
        profiles: [{ id: "default", name: "Local Claude Code", provider: "local", configDir: "~/.claude", permissionMode: "bypassPermissions" }],
      }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const invalid = (reason: string): never => { throw new HarnessModelsError(`${reason}. Edit ${file}`, file, 400); };
  let config: Record<string, unknown>;
  try { config = jsonFile(file); } catch { return invalid("Invalid Claude Code configuration"); }
  if (!Array.isArray(config.profiles)) return invalid("Expected a profiles array");
  const ids = new Set<string>();
  const directories = new Set<string>();
  return config.profiles.map((raw): ClaudeProfile => {
    const item = object(raw);
    const id = typeof item.id === "string" ? item.id : "";
    if (!/^[a-zA-Z0-9._-]{1,160}$/.test(id) || ids.has(id)) return invalid("Profile ids must be unique letters numbers dots underscores or hyphens");
    ids.add(id);
    const provider = typeof item.provider === "string" ? item.provider : "claude-code";
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(provider)) return invalid(`Invalid provider for ${id}`);
    if ((item.model !== undefined && typeof item.model !== "string") || (typeof item.model === "string" && /[\r\n\0]/.test(item.model))) return invalid(`Invalid model for ${id}`);
    const model = typeof item.model === "string" ? item.model.trim() : "";
    const directory = expandClaudePath(typeof item.configDir === "string" ? item.configDir : path.join(homedir(), ".claude-profiles", claudeProfileSlug(id)));
    if (!path.isAbsolute(directory) || /[\r\n\0]/.test(directory)) return invalid(`Invalid configDir for ${id}`);
    const configDir = canonicalProfilePath(directory);
    if (directories.has(configDir)) return invalid("Each model profile must use a separate configDir");
    directories.add(configDir);
    if (item.env !== undefined && (item.env === null || typeof item.env !== "object" || Array.isArray(item.env))) return invalid(`Invalid env for ${id}`);
    const env = item.env === undefined ? undefined : object(item.env);
    if (env && Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0"))) return invalid(`Invalid env for ${id}`);
    if (env && ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_PROJECT_DIR_NAME", "CLAUDE_CODE_SKIP_PROMPT_HISTORY", "CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SAFE_MODE"].some((key) => key in env)) return invalid(`env must not override profile identity or disable native features for ${id}`);
    const effort = item.effort;
    if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(String(effort))) return invalid(`Invalid effort for ${id}`);
    const mode = item.permissionMode ?? "bypassPermissions";
    if (!["manual", "acceptEdits", "plan", "bypassPermissions"].includes(String(mode))) return invalid(`Invalid permissionMode for ${id}`);
    return { id, name: typeof item.name === "string" ? item.name : id, provider, model, configDir,
      enabled: item.enabled !== false, env: env as Record<string, string> | undefined,
      effort: effort as ClaudeProfile["effort"], permissionMode: mode as ClaudeProfile["permissionMode"] };
  });
}

export function resolveClaudeProfile(id?: string, provider?: string, allowDisabled = false): ClaudeProfile {
  const profiles = readClaudeProfiles();
  const profile = id ? profiles.find((entry) => entry.id === id && (!provider || entry.provider === provider)) : profiles.find((entry) => entry.enabled);
  if (!profile || (!allowDisabled && !profile.enabled)) throw new Error(`Claude Code profile is missing or disabled. Edit ${claudeConfigFile()}`);
  return profile;
}

const SHARED = ["skills", "commands", "agents", "output-styles", "rules", "workflows", "hooks", "themes", "keybindings.json", "CLAUDE.md", "plugins"];

/** Only missing profiles are seeded; existing native state and credentials stay put. */
export function prepareClaudeProfile(profile: ClaudeProfile): void {
  mkdirSync(profile.configDir, { recursive: true, mode: 0o700 });
  const defaultDir = path.join(homedir(), ".claude");
  if (!isDefaultProfile(profile.configDir)) {
    for (const name of SHARED) {
      const source = path.join(defaultDir, name);
      const destination = path.join(profile.configDir, name);
      if (!existsSync(source)) continue;
      const directory = statSync(source).isDirectory();
      try { symlinkSync(source, destination, process.platform === "win32" && directory ? "junction" : undefined); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") continue;
        // ponytail: Windows without file-symlink rights gets a one-time copy; Developer Mode enables live links.
        if (process.platform === "win32" && !directory && code === "EPERM") copyFileSync(source, destination, constants.COPYFILE_EXCL);
        else throw error;
      }
    }
    const metadata = path.join(profile.configDir, ".claude.json");
    if (!existsSync(metadata)) {
      const base = jsonFile(path.join(homedir(), ".claude.json"));
      const seed: Record<string, unknown> = {};
      for (const key of ["hasCompletedOnboarding", "lastOnboardingVersion", "mcpServers"]) if (key in base) seed[key] = base[key];
      try { writeFileSync(metadata, JSON.stringify(seed, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
  }
  const file = path.join(profile.configDir, "settings.json");
  const settings = jsonFile(file);
  const previous = JSON.stringify(settings);
  if (!existsSync(file) && !isDefaultProfile(profile.configDir)) {
    const base = jsonFile(path.join(defaultDir, "settings.json"));
    for (const [key, value] of Object.entries(base)) if (!["env", "model", "effortLevel"].includes(key)) settings[key] = value;
  }
  if (profile.env !== undefined) settings.env = profileEnvironment(profile);
  if (profile.effort) settings.effortLevel = profile.effort;
  if (JSON.stringify(settings) !== previous) writeClaudeJson(file, settings);
}

export function resolveClaudeEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => {
    const reference = value.startsWith("env:") ? value.slice(4) : value.startsWith("$") ? value.slice(1) : null;
    if (reference !== null) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference) || !process.env[reference]?.trim()) throw new Error(`Missing environment variable for Claude Code profile: ${reference}`);
      return [key, process.env[reference]!];
    }
    return [key, value];
  }));
}

function profileEnvironment(profile: ClaudeProfile): Record<string, string> {
  const model = profile.model;
  return { ...(model ? {
    ANTHROPIC_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
  } : {}), ...resolveClaudeEnv(profile.env ?? {}) };
}

export function claudeProcessEnv(profile: ClaudeProfile): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (profile.env !== undefined || !isDefaultProfile(profile.configDir)) for (const key of Object.keys(env)) if (key.startsWith("ANTHROPIC_")) delete env[key];
  for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDECODE", "CLAUDE_CODE_SIMPLE", "CLAUDE_CODE_SAFE_MODE", "CLAUDE_CODE_SKIP_PROMPT_HISTORY", "CLAUDE_CODE_PROJECT_DIR_NAME"]) delete env[key];
  if (profile.env !== undefined) Object.assign(env, profileEnvironment(profile));
  // The default directory has a legacy sibling ~/.claude.json, unlike custom profiles.
  if (!isDefaultProfile(profile.configDir)) env.CLAUDE_CONFIG_DIR = profile.configDir;
  return env;
}

function metadataFile(profile: ClaudeProfile): string {
  return isDefaultProfile(profile.configDir) ? path.join(homedir(), ".claude.json") : path.join(profile.configDir, ".claude.json");
}

export function claudeProjectTrusted(profile: ClaudeProfile, cwd: string): boolean {
  const key = realpathSync(cwd);
  return readClaudeProjectTrust(profile.configDir, key) || object(object(jsonFile(metadataFile(profile)).projects)[key]).hasTrustDialogAccepted === true;
}

export function trustClaudeProject(profile: ClaudeProfile, cwd: string): void {
  writeClaudeProjectTrust(profile.configDir, realpathSync(cwd));
}

export const claudeCodeHarness: HarnessDescriptor = {
  id: "claude-code", label: "Claude Code", configDir: claudeConfigFile,
  readModels() {
    return { path: claudeConfigFile(), models: readClaudeProfiles().map((profile) => ({
      key: profile.id, name: profile.name, provider: profile.provider, model: profile.id,
      enabled: profile.enabled, profileDir: profile.configDir, runtimeModel: profile.model,
    })) };
  },
};

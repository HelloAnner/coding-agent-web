import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HarnessDescriptor } from "../types";

export const OMP_ID = /^omp-[a-zA-Z0-9-]{8,100}$/;
export function ompAgentDir(): string { return path.resolve(process.env.PI_WEB_OMP_AGENT_DIR?.trim() || path.join(homedir(), ".omp", "agent")); }
export function ompDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME, "omp");
  return !process.env.PI_WEB_OMP_AGENT_DIR && xdg && existsSync(xdg) ? xdg : ompAgentDir();
}
export function ompSessionsRoot(): string { return path.join(ompDataDir(), "sessions", "web"); }
export function ompConfigIdentity(): string {
  const root = ompAgentDir();
  return existsSync(root) ? realpathSync(root) : root;
}
export function ompProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["PI_PACKAGE_DIR", "PI_PROFILE", "PI_CODING_AGENT_SESSION_DIR", "PI_SMOL_MODEL", "PI_SLOW_MODEL", "PI_PLAN_MODEL"]) delete env[name];
  env.PI_CONFIG_DIR = ".omp";
  env.PI_CODING_AGENT_DIR = ompAgentDir();
  env.OMP_PROFILE = "";
  env.PI_NO_TITLE = "1";
  if (process.env.PI_WEB_OMP_AGENT_DIR) for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) delete env[key];
  return env;
}
export const ompHarness: HarnessDescriptor = {
  id: "omp", label: "omp",
  // Model settings deliberately share Pi's editor and credentials, not OMP YAML.
  configDir: getAgentDir,
  async readChatModels(context) { return (await import("./models")).listOmpModels(context?.cwd); },
};

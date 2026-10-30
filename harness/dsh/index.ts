import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { HarnessDescriptor } from "../types";

/** Session files. `DSH_HOME` overrides `~/.dsh`. */
export function dshHome(): string {
  return process.env.DSH_HOME || path.join(homedir(), ".dsh");
}

/** Every project's session logs, one directory per cwd. */
export function dshSessionsRoot(): string {
  return path.join(dshHome(), "sessions");
}

/**
 * The session directory for one kernel session id. The cwd segment is the
 * kernel's own readable encoding, so look the directory up instead of guessing
 * it; ids are unique across the root.
 */
export function findDshSessionDir(sessionId: string): string | null {
  const root = dshSessionsRoot();
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, sessionId);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* no session has been written yet */
  }
  return null;
}

export const dshHarness: HarnessDescriptor = {
  id: "dsh",
  label: "dsh",
  configDir() {
    return path.join(dshHome(), "profiles", "coding-agent-web");
  },
  /** One native directory for settings and the composer, with no file-list fallback. */
  async readChatModels() {
    const { listDshWebModels } = await import("./web-session");
    return listDshWebModels();
  },
};

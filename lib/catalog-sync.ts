import { claudeTranscriptFile } from "@/harness/claude-code/transcript";
import { resolveClaudeProfile } from "@/harness/claude-code";
import { findDshSessionDir } from "@/harness/dsh";
import { resolveGrokHistoryFile } from "@/harness/grok";
import { listCatalogSessionPaths, relocateCatalogSession, type CatalogSessionPaths } from "./catalog-db";
import { resolveSessionPath } from "./session-reader";

/**
 * Keeps every row of the web's own index pointing at the harness file its
 * conversation lives in:
 *
 *   pi           ~/.pi/agent/sessions/<cwd>/<...>.jsonl
 *   claude-code  <configDir>/projects/<encoded cwd>/<uuid>.jsonl
 *   dsh          ~/.dsh/sessions/<cwd>/<uuid>/   (session.v4.jsonl[.zstd] inside)
 *   grok         ~/.grok/sessions/<encoded cwd>/<id>/chat_history.jsonl
 *
 * The index lists what the web created, so this never adds a row for a session
 * found on disk. It only repairs a row that already exists: an old Claude row
 * that stored its profile directory, or a row written before a dsh turn had
 * flushed its log. Harness files stay authoritative; this only reads them.
 */

export interface CatalogRepairResult {
  repaired: number;
}

/** Point old Claude rows at the transcript file, keeping the profile directory beside it. */
function repairClaudeRows(indexed: Map<string, CatalogSessionPaths>): number {
  let repaired = 0;
  for (const row of indexed.values()) {
    if (row.harness !== "claude-code") continue;
    const profilePath = row.profilePath || row.sessionPath;
    if (!profilePath) continue;
    let file: string | null = null;
    try {
      file = claudeTranscriptFile(profilePath, row.id);
    } catch {
      continue;
    }
    if (!file || (row.sessionPath === file && row.profilePath === profilePath)) continue;
    if (!relocateCatalogSession(row.id, { sessionPath: file, profilePath })) continue;
    row.sessionPath = file;
    row.profilePath = profilePath;
    repaired += 1;
  }
  return repaired;
}

function claudeProfileDir(row: CatalogSessionPaths): string {
  try {
    return resolveClaudeProfile(row.model, row.provider, true).configDir;
  } catch {
    return "";
  }
}

/** A row written before the path was known (a dsh turn that had not flushed yet). */
async function repairEmptyPaths(indexed: Map<string, CatalogSessionPaths>): Promise<number> {
  let repaired = 0;
  for (const row of indexed.values()) {
    if (row.sessionPath) continue;
    let file: string | null = null;
    try {
      if (row.harness === "pi") file = await resolveSessionPath(row.id);
      else if (row.harness === "dsh") file = findDshSessionDir(row.id);
      else if (row.harness === "grok") file = resolveGrokHistoryFile(row.cwd, row.id);
      else if (row.harness === "claude-code") {
        const configDir = row.profilePath || claudeProfileDir(row);
        if (configDir) file = claudeTranscriptFile(configDir, row.id);
      }
    } catch {
      continue;
    }
    if (!file) continue;
    relocateCatalogSession(row.id, {
      sessionPath: file,
      ...(row.harness === "claude-code" ? { profilePath: row.profilePath || claudeProfileDir(row) } : {}),
    });
    row.sessionPath = file;
    repaired += 1;
  }
  return repaired;
}

declare global {
  // One pass per process is enough; a second caller joins the first.
  var __piWebCatalogRepair: Promise<CatalogRepairResult> | undefined;
}

export function repairCatalogSessionPaths(): Promise<CatalogRepairResult> {
  globalThis.__piWebCatalogRepair ??= repair().catch((error: unknown) => {
    globalThis.__piWebCatalogRepair = undefined;
    throw error;
  });
  return globalThis.__piWebCatalogRepair;
}

async function repair(): Promise<CatalogRepairResult> {
  const indexed = new Map(listCatalogSessionPaths().map((row) => [row.id, row]));
  let repaired = repairClaudeRows(indexed);
  repaired += await repairEmptyPaths(indexed);
  return { repaired };
}

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { claudeTranscriptFile, claudeSessionCwd, CLAUDE_UUID, readClaudeTitle } from "@/harness/claude-code/transcript";
import { readClaudeProfiles, resolveClaudeProfile } from "@/harness/claude-code";
import { dshSessionsRoot, findDshSessionDir } from "@/harness/dsh";
import { readDshSessionHeader, readDshTranscript } from "@/harness/dsh/transcript";
import { grokHome, resolveGrokHistoryFile } from "@/harness/grok";
import { readGrokTranscript } from "@/harness/grok/transcript";
import { listCatalogSessionPaths, relocateCatalogSession, upsertCatalogSession, type CatalogSessionPaths } from "./catalog-db";
import { listSessionSummaries, resolveSessionPath } from "./session-reader";

/**
 * The index's own harvester. It reads each harness's own storage and makes the
 * catalogue complete, so every conversation has a row that names the file a
 * reader can open:
 *
 *   pi           ~/.pi/agent/sessions/<cwd>/<...>.jsonl
 *   claude-code  <configDir>/projects/<encoded cwd>/<uuid>.jsonl
 *   dsh          ~/.dsh/sessions/<cwd>/<uuid>/   (session.v4.jsonl[.zstd] inside)
 *   grok         ~/.grok/sessions/<encoded cwd>/<id>/chat_history.jsonl
 *
 * Two jobs, both idempotent:
 *   repair   old rows that stored a Claude profile directory, and rows whose
 *            path is empty, get pointed at their real file
 *   backfill sessions that no web chat ever created (a CLI run, an old chat)
 *            are added once, with the file's own timestamps
 *
 * Harness files stay authoritative: this only reads them.
 */

export interface CatalogSyncResult {
  added: number;
  repaired: number;
}

interface Candidate {
  id: string;
  cwd: string;
  harness: string;
  provider: string;
  model: string;
  title: string;
  sessionPath: string;
  profilePath?: string;
  createdAt?: number;
  updatedAt?: number;
}

function mtime(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

function firstUserText(messages: readonly { role?: string; content?: unknown }[]): string {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const content = message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((block) => (block as { type?: string; text?: string }).type === "text" ? (block as { text?: string }).text ?? "" : "").join(" ")
        : "";
    const line = text.trim().split("\n")[0].slice(0, 100);
    if (line) return line;
  }
  return "";
}

/** pi's own scan, minus subagent transcripts: those belong to a parent chat, not the sidebar. */
async function piCandidates(): Promise<Candidate[]> {
  const sessions = await listSessionSummaries();
  return sessions
    .filter((session) => session.relation?.kind !== "subagent")
    .map((session) => ({
      id: session.id,
      cwd: session.cwd,
      harness: "pi",
      provider: session.modelProvider ?? "",
      model: session.modelId ?? "",
      title: session.name || (session.firstMessage === "(no messages)" ? "" : session.firstMessage.slice(0, 100)),
      sessionPath: session.path,
      createdAt: Date.parse(session.created) || undefined,
      updatedAt: Date.parse(session.modified) || undefined,
    }));
}

/** Every profile's own transcript files, subagent files excluded. */
function claudeCandidates(indexed: Set<string>): Candidate[] {
  let profiles;
  try {
    profiles = readClaudeProfiles();
  } catch {
    return [];
  }
  const candidates: Candidate[] = [];
  for (const profile of profiles) {
    const root = path.join(profile.configDir, "projects");
    let projectDirs;
    try {
      projectDirs = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const directory of projectDirs) {
      if (!directory.isDirectory()) continue;
      let files;
      try {
        files = readdirSync(path.join(root, directory.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        const id = file.name.slice(0, -".jsonl".length);
        if (!CLAUDE_UUID.test(id) || indexed.has(id)) continue;
        const sessionPath = path.join(root, directory.name, file.name);
        const cwd = claudeSessionCwd(profile.configDir, id);
        if (!cwd) continue;
        let title = "";
        try {
          title = readClaudeTitle(profile.configDir, id);
        } catch {
          // No usable text: the row keeps its id as the title.
        }
        candidates.push({
          id,
          cwd,
          harness: "claude-code",
          provider: profile.provider,
          model: profile.id,
          title,
          sessionPath,
          profilePath: profile.configDir,
          updatedAt: mtime(sessionPath),
        });
      }
    }
  }
  return candidates;
}

/** Every `<DSH_HOME>/sessions/<cwd>/<id>/` directory with a readable kernel log. */
function dshCandidates(indexed: Set<string>): Candidate[] {
  const root = dshSessionsRoot();
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: Candidate[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let sessions;
    try {
      sessions = readdirSync(path.join(root, project.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory() || indexed.has(session.name)) continue;
      const sessionPath = path.join(root, project.name, session.name);
      const header = readDshSessionHeader(sessionPath);
      if (!header || header.id !== session.name) continue;
      const transcript = readDshTranscript(sessionPath);
      candidates.push({
        id: header.id,
        cwd: header.cwd,
        harness: "dsh",
        provider: "",
        model: transcript.model ?? "",
        title: firstUserText(transcript.messages),
        sessionPath,
        createdAt: header.createdAt ?? undefined,
        updatedAt: mtime(sessionPath),
      });
    }
  }
  return candidates;
}

/** Grok encodes the cwd in the directory name, so nothing is lost decoding it. */
function grokCandidates(indexed: Set<string>): Candidate[] {
  const root = path.join(grokHome(), "sessions");
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: Candidate[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let cwd: string;
    try {
      cwd = decodeURIComponent(project.name);
    } catch {
      continue;
    }
    if (!path.isAbsolute(cwd)) continue;
    let sessions;
    try {
      sessions = readdirSync(path.join(root, project.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory() || indexed.has(session.name)) continue;
      const sessionPath = resolveGrokHistoryFile(cwd, session.name);
      if (!sessionPath) continue;
      let title = "";
      try {
        title = firstUserText(readGrokTranscript(cwd, session.name).messages);
      } catch {
        // Unreadable history: still indexed by path.
      }
      candidates.push({
        id: session.name,
        cwd,
        harness: "grok",
        provider: "",
        model: "",
        title,
        sessionPath,
        updatedAt: mtime(sessionPath),
      });
    }
  }
  return candidates;
}

/** Point old rows at the transcript file, keeping the profile directory beside it. */
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
        const profile = resolveClaudeProfile(row.model, row.provider, true);
        file = claudeTranscriptFile(profile.configDir, row.id);
      }
    } catch {
      continue;
    }
    if (!file) continue;
    relocateCatalogSession(row.id, {
      sessionPath: file,
      ...(row.harness === "claude-code" ? { profilePath: readClaudeProfileDir(row) } : {}),
    });
    row.sessionPath = file;
    repaired += 1;
  }
  return repaired;
}

function readClaudeProfileDir(row: CatalogSessionPaths): string {
  try {
    return resolveClaudeProfile(row.model, row.provider, true).configDir;
  } catch {
    return row.profilePath;
  }
}

declare global {
  // One harvest per process is enough; a second caller joins the first.
  var __piWebCatalogSync: Promise<CatalogSyncResult> | undefined;
}

export function syncCatalogSessions(): Promise<CatalogSyncResult> {
  globalThis.__piWebCatalogSync ??= harvest().catch((error: unknown) => {
    globalThis.__piWebCatalogSync = undefined;
    throw error;
  });
  return globalThis.__piWebCatalogSync;
}

async function harvest(): Promise<CatalogSyncResult> {
  const indexed = new Map(listCatalogSessionPaths().map((row) => [row.id, row]));
  let repaired = repairClaudeRows(indexed);
  repaired += await repairEmptyPaths(indexed);

  let added = 0;
  // Every scanner skips ids already indexed before it reads a transcript, so a
  // routine boot pays a directory listing, not a full re-parse of every chat.
  const indexedIds = new Set(indexed.keys());
  const candidates: Candidate[] = [
    ...(await piCandidates()),
    ...claudeCandidates(indexedIds),
    ...dshCandidates(indexedIds),
    ...grokCandidates(indexedIds),
  ];
  for (const candidate of candidates) {
    if (indexed.has(candidate.id)) continue;
    try {
      upsertCatalogSession({
        id: candidate.id,
        cwd: candidate.cwd,
        harness: candidate.harness,
        provider: candidate.provider,
        model: candidate.model,
        title: candidate.title,
        sessionPath: candidate.sessionPath,
        profilePath: candidate.profilePath,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      });
    } catch {
      // An id another harness already owns: the index keeps its row.
      continue;
    }
    indexed.set(candidate.id, { ...candidate, profilePath: candidate.profilePath ?? "" });
    added += 1;
  }
  return { added, repaired };
}

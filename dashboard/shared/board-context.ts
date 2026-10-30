"use client";

import type { SessionInfo } from "@/lib/types";
import type { DashboardBoard } from "../boards";

/**
 * What the board chat needs to know about one board's folder. Shared by every
 * board: the board supplies its `dataDir`, this module turns it into a working
 * directory, a draft key and its recent conversations.
 */

const cwdCache = new Map<string, string>();
const sessionCache = new Map<string, SessionInfo | null>();
let recentSessions: Promise<SessionInfo[]> | null = null;

/** The board's fixed folder, absolute, as the server resolved it. */
export async function boardCwd(board: DashboardBoard): Promise<string> {
  const cached = cwdCache.get(board.id);
  if (cached) return cached;
  const response = await fetch(`/api/dashboard/chat?board=${encodeURIComponent(board.id)}`, { cache: "no-store" });
  const body = await response.json() as { cwd?: string; error?: string };
  if (!response.ok || !body.cwd) throw new Error(body.error || `HTTP ${response.status}`);
  cwdCache.set(board.id, body.cwd);
  return body.cwd;
}

/** One draft per board, so a half-written question stays with its board. */
export function boardDraftKey(board: DashboardBoard): string {
  return `dashboard:${board.id}`;
}

/** The conversation this board had open last, within this page session. */
export function readBoardSession(board: DashboardBoard): SessionInfo | null {
  return sessionCache.get(board.id) ?? null;
}

export function rememberBoardSession(board: DashboardBoard, session: SessionInfo | null): void {
  sessionCache.set(board.id, session);
}

/** Recent conversations in the board's folder, newest first. */
export async function boardSessions(board: DashboardBoard, cwd: string, limit = 8): Promise<SessionInfo[]> {
  recentSessions ??= fetch("/api/sessions?summary=1", { cache: "no-store" })
    .then(async (response) => response.ok ? (await response.json() as { sessions?: SessionInfo[] }).sessions ?? [] : [])
    .catch(() => []);
  const sessions = await recentSessions;
  return sessions
    .filter((session) => session.cwd === cwd && !session.parentSessionId)
    .sort((a, b) => b.modified.localeCompare(a.modified))
    .slice(0, limit);
}

export function forgetSessionCache(): void {
  recentSessions = null;
}

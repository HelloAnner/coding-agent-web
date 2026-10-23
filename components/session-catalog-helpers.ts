import type { SessionInfo } from "@/lib/types";

/** Pi writes one jsonl per session: `2026-10-23T03-56-03-390Z_<uuid>.jsonl`. */
const PI_SESSION_FILE = /(?:^|\/)\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-fA-F-]+\.jsonl$/;

export function isPiSessionFile(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  return PI_SESSION_FILE.test(filePath.replaceAll("\\", "/"));
}

/**
 * Harness the composer should show.
 * A fresh composer keeps the pick it already has. An open session uses its own
 * harness. A pi session file stays pi when the index row was stamped with another.
 */
export function composerHarnessFor(
  session: { id?: string; harness?: string; path?: string } | null | undefined,
  freshHarness?: string | null,
): string {
  if (session && (session.id || session.path)) {
    if (isPiSessionFile(session.path)) return "pi";
    if (session.harness) return session.harness;
    return "pi";
  }
  return freshHarness || "pi";
}

/**
 * Overlay a catalogue row onto the session already on screen.
 *
 * Catalogue rows omit optional keys instead of setting them to undefined, so a
 * plain spread can never clear one that stopped being true: a hydrated row drops
 * `detailsPending`, a session that left a worktree drops `branch`/`isWorktree`,
 * and a fork whose parent went away drops `relation`. Reset those from the
 * refreshed row explicitly. Locally applied fields such as an auto-generated
 * title still survive until the next listing carries them.
 */
export function mergeCatalogRow(current: SessionInfo, refreshed: SessionInfo): SessionInfo {
  return {
    ...current,
    ...refreshed,
    detailsPending: refreshed.detailsPending,
    relation: refreshed.relation,
    branch: refreshed.branch,
    isWorktree: refreshed.isWorktree,
  };
}

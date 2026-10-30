import type { SessionInfo } from "@/lib/types";

/**
 * Harness the composer should show.
 * A fresh composer keeps the pick it already has. An open session uses its own
 * harness. OMP and Pi share a filename pattern; only the indexed identity decides.
 */
export function composerHarnessFor(
  session: { id?: string; harness?: string; path?: string } | null | undefined,
  freshHarness?: string | null,
): string {
  if (session && (session.id || session.path)) {
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

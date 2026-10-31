import { configureHttpDispatcher, readHttpIdleTimeoutMs } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { applyCodemodeWorkerDefault } from "@/lib/codemode-workers";

export function registerNodeInstrumentation(): void {
  // Before any session can run a codemode script (lib/codemode-workers.ts).
  applyCodemodeWorkerDefault();

  // The pi CLI applies settings' `httpIdleTimeoutMs` to the same undici
  // body/header timeouts, so a Web UI session gets the timeout the user
  // configured. Without it the built-in five minutes aborts a provider stream
  // that stays quiet for longer, which a CLI session tolerates.
  configureHttpDispatcher(readHttpIdleTimeoutMs());
  import("@/lib/data-backup")
    .then(({ startDataBackup }) => startDataBackup())
    .catch((error: unknown) => console.error("[coding-agent-web] Could not start data backups:", error));
  import("@/lib/usage-refresh")
    .then(({ startUsageRefresh }) => startUsageRefresh())
    .catch(() => {});
  import("@/dashboard/boards/fine-tasks/sync")
    .then(({ startTaskRefresh }) => startTaskRefresh())
    .catch(() => {});
  // Build the Notes index (and its SQLite tables) before the first @ menu.
  import("@/notes/index")
    .then(({ syncNotesIndex }) => syncNotesIndex())
    .catch(() => {});
  // Point the catalogue's rows at the harness files their conversations live
  // in (an old Claude row stored its profile directory; a dsh row can be
  // written before the kernel flushes). It never adds a row for a session the
  // web did not start.
  import("@/lib/catalog-sync")
    .then(({ repairCatalogSessionPaths }) => repairCatalogSessionPaths())
    .catch(() => {});
  // Prompts accepted before the last stop: send again the ones the session file
  // does not already hold, so a restart mid-run does not eat a queued message.
  import("@/lib/prompt-intake")
    .then(({ resumeOpenIntake }) => resumeOpenIntake())
    .catch((error: unknown) => console.error("[coding-agent-web] Could not resume pending prompts:", error));
  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);

  // Next evaluates a route's code on its first request, so the first
  // /api/sessions used to pay for importing the whole pi SDK, seconds on
  // Windows (#964). Start that import now, unawaited so register() stays fast:
  // it overlaps the browser opening, and the routes reuse Node's cached module.
  // A failure is left for the routes' own import to report.
  import("@earendil-works/pi-coding-agent").catch(() => {});
}

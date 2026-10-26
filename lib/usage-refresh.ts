import { collectUsage } from "./usage-collectors";
import { readUsageData, saveUsageError, saveUsageSnapshot } from "./usage-db";

export const USAGE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const globalState = globalThis as typeof globalThis & {
  usageRefresh?: { timer?: ReturnType<typeof setInterval>; inFlight?: Promise<void> };
};
const state = globalState.usageRefresh ??= {};

export function usageData() {
  const data = readUsageData();
  return { ...data, sync: { ...data.sync, running: Boolean(state.inFlight), refreshIntervalMs: USAGE_REFRESH_INTERVAL_MS } };
}

export async function refreshUsage(): Promise<void> {
  if (state.inFlight) return state.inFlight;
  state.inFlight = (async () => {
    try {
      const snapshot = await collectUsage();
      if (!snapshot.complete) {
        saveUsageError("Some session sources could not be read. Previous data has been preserved.", snapshot.diagnostics);
        return;
      }
      saveUsageSnapshot(snapshot);
    } catch {
      // Raw filesystem and parser errors can expose private transcript data.
      saveUsageError("Usage collection failed. Previous data has been preserved.");
    }
  })();
  try { await state.inFlight; } finally { state.inFlight = undefined; }
}

export function startUsageRefresh(): void {
  if (state.timer || process.env.NODE_ENV === "test") return;
  const refreshIfDue = () => {
    try {
      const { sync } = readUsageData();
      if (!sync.lastCollectedAt || Date.now() - sync.lastCollectedAt >= USAGE_REFRESH_INTERVAL_MS) void refreshUsage();
    } catch { /* Storage failures must not prevent app startup. */ }
  };
  state.timer = setInterval(refreshIfDue, USAGE_REFRESH_INTERVAL_MS);
  state.timer.unref();
  refreshIfDue();
}

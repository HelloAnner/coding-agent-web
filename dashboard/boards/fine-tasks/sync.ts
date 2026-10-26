import { readFineTasks, saveFineTaskError, saveFineTasks } from "./db";
import { fetchMyTasks } from "./meegle";
import type { FineTaskSnapshot } from "./types";

export const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const globalState = globalThis as typeof globalThis & {
  fineTaskSync?: { timer?: ReturnType<typeof setInterval>; inFlight?: Promise<void> };
};
const state = globalState.fineTaskSync ??= {};

export function taskSnapshot(): FineTaskSnapshot {
  return { ...readFineTasks(), syncing: Boolean(state.inFlight), refreshIntervalMs: REFRESH_INTERVAL_MS };
}

export async function refreshTasks(): Promise<void> {
  if (state.inFlight) return state.inFlight;
  state.inFlight = (async () => {
    try {
      saveFineTasks(await fetchMyTasks());
    } catch {
      // CLI stderr and task descriptions may contain private data; never expose them.
      saveFineTaskError("Meegle 同步失败，请检查 CLI 登录、网络与访问权限；已保留上次成功的数据。");
    }
  })();
  try { await state.inFlight; } finally { state.inFlight = undefined; }
}

export function startTaskRefresh(): void {
  if (state.timer || process.env.NODE_ENV === "test") return;
  const refreshIfDue = () => {
    try {
      const snapshot = readFineTasks();
      if (!snapshot.lastSyncedAt || Date.now() - snapshot.lastSyncedAt >= REFRESH_INTERVAL_MS) void refreshTasks();
    } catch { /* Routes report storage failures; startup must remain available. */ }
  };
  // Check often enough that CLI runtime does not skip an entire ten-minute tick.
  state.timer = setInterval(refreshIfDue, 30_000);
  state.timer.unref();
  refreshIfDue();
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function slice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} not found`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${endMarker} not found after ${startMarker}`);
  return source.slice(start, end);
}

// Runs the real requestAutoName/handleAutoName callbacks. `active` is what the
// render-synced ref holds: the chat on screen when the request lands.
function runAutoName({ active, selectedId, title = "A new title" }) {
  const state = { urls: [], status: [], refreshBumped: false, selected: [], timers: 0 };
  const context = vm.createContext({
    activeSessionIdRef: { current: active },
    selectedSession: { id: selectedId },
    autoNameStatus: { kind: "idle" },
    autoNameTimerRef: { current: null },
    setActiveTopPanel() {},
    setAutoNameStatus: (value) => state.status.push(value),
    setRefreshKey: (fn) => { state.refreshBumped = fn(0) > 0; },
    setSelectedSession: (fn) => state.selected.push(fn({ id: selectedId, name: "old" })),
    setSessionStats: () => {},
    setTimeout: () => { state.timers += 1; return 1; },
    clearTimeout() {},
    useRef: (value) => ({ current: value }),
    useCallback: (callback) => callback,
    fetch: async (url) => {
      state.urls.push(url);
      return { ok: true, status: 200, json: async () => ({ title }) };
    },
  });
  vm.runInContext(stripTypeScriptTypes(`${slice("  const requestAutoName = useCallback", "  useEffect(() => {\n    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);\n    setAutoNameStatus({ kind: \"idle\" });")}
    void requestAutoName("background-session");
  `), context);
  return state;
}

test("a title request targets the session it was asked for", async () => {
  // The auto trigger runs for a chat the user may have navigated away from.
  const state = runAutoName({ active: "other-session", selectedId: "other-session" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.urls, ["/api/sessions/background-session/auto-name"]);
  // The sidebar still refreshes, but nothing repaints the chat on screen.
  assert.equal(state.refreshBumped, true);
  assert.deepEqual(state.status, []);
  assert.deepEqual(state.selected, []);
});

test("the chat on screen shows the new title", async () => {
  const state = runAutoName({ active: "background-session", selectedId: "background-session" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(state.status), JSON.stringify([{ kind: "naming" }, { kind: "success" }]));
  assert.equal(state.selected[0].name, "A new title");
});

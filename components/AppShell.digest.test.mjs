import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import * as notesWatch from "../lib/notes-watch.ts";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const handleDigestToNotes = useCallback");
const end = source.indexOf("\n  const handleExplorerRefresh", start);
assert.ok(start >= 0 && end > start);

test("a completed write notifies the open board even without a filesystem event", async (t) => {
  // Deliberately never emit an SSE event: completion must refresh the board itself.
  const originalEventSource = globalThis.EventSource;
  globalThis.EventSource = class extends EventTarget { close() {} };
  t.after(() => { globalThis.EventSource = originalEventSource; });
  const changes = [];
  const unsubscribe = notesWatch.subscribeNotesWatch((paths) => changes.push(paths));
  const response = Promise.withResolvers();
  const states = [];
  const requests = [];
  const boardPath = "后端/JAVA/hashcode & equals.excalidraw";
  let ok = true;
  const context = vm.createContext({
    ...notesWatch,
    useCallback: (callback) => callback,
    selectedSessionRef: { current: { id: "session-1", transient: false } },
    digestStatus: { kind: "idle" },
    digestToastIdRef: { current: 0 },
    setDigestDialogOpen() {},
    setDigestToast() {},
    setDigestStatus: (state) => states.push(state),
    translate: (key) => key,
    fetch: async (url, options) => {
      requests.push([url, JSON.parse(options.body)]);
      await response.promise;
      return { ok, json: async () => ok ? { message: "已写入", board: boardPath } : { error: "写入失败" } };
    },
  });
  vm.runInContext(stripTypeScriptTypes(`${source.slice(start, end)}\nglobalThis.writeBoard = handleDigestToNotes;`), context);
  try {
    const writing = context.writeBoard(boardPath, "画出核心关系");
    assert.deepEqual(changes, [], "do not refresh before the write completes");
    response.resolve();
    await writing;
    assert.equal(JSON.stringify(changes), JSON.stringify([[boardPath]]));
    assert.equal(states.at(-1).kind, "success");
    assert.deepEqual(requests, [["/api/notes/digest", { sessionId: "session-1", boardPath, focus: "画出核心关系" }]]);

    ok = false;
    await context.writeBoard(boardPath, "再试一次");
    assert.equal(changes.length, 1, "a failed write must not emit a success notification");
    assert.equal(states.at(-1).kind, "error");
  } finally {
    unsubscribe();
  }
});

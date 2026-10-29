import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
function section(text, start, end) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} … ${end}`);
  return text.slice(from, to);
}
function setters(context, code, calls = []) {
  for (const [name] of code.matchAll(/\bset[A-Z]\w*(?=\()/g)) {
    const key = name[3].toLowerCase() + name.slice(4);
    context[name] = (value) => {
      calls.push(name);
      context[key] = typeof value === "function" ? value(context[key]) : value;
    };
  }
}
const run = (code, context) => vm.runInContext(stripTypeScriptTypes(code), context);

test("title and notes actions are square, labelled icon buttons on desktop too", () => {
  const buttons = section(source, "  const renderChatToolbarActions", "        <ToolbarQuota />");
  assert.doesNotMatch(buttons, /<span>\{label\}<\/span>/);
  assert.equal((buttons.match(/width: TOP_BAR_ICON_BUTTON_SIZE/g) ?? []).length, 2);
  assert.equal((buttons.match(/aria-label=\{label\}/g) ?? []).length, 2);
  assert.match(source, /onClick=\{handleResetSession\}/);
  assert.match(source, /aria-label=\{translate\("session.reset"\)\}/);
});

test("starting over keeps each harness's picks, cwd and layout, without restoring a parked draft", () => {
  const code = section(source, "  const handleNewSession = useCallback", "  // Global keyboard shortcuts")
    + section(source, "  const handleResetSession = () =>", "  const renderChatToolbarActions");
  for (const harness of ["pi", "claude-code", "dsh", "grok"]) {
    const choices = { model: { provider: "own-provider", modelId: "own-model" }, thinkingLevel: "off", toolPreset: "none", toolNames: [] };
    const session = { id: "original", cwd: "/project-worktree", projectKey: "/project", harness, messageCount: 10 };
    const context = vm.createContext({
      useCallback: (fn) => fn,
      selectedSession: session,
      resetSessionConfig: { sessionId: session.id, choices },
      composerHarness: "different-default",
      composerHarnessFor: (session) => session.harness,
      workspaceKeyOf: (session) => session.projectKey,
      crypto: { randomUUID: () => "fresh" },
      invalidateWorkspaceRestore() {},
      newSessionCarryRef: { current: false },
      projectPreferenceRequestRef: { current: 3 },
      harnessRef: { current: "different-default" },
      harnessModelRef: { current: null },
      activeProjectKeyRef: { current: "/project" },
      activeNewSessionDraftKeyRef: { current: null },
      newSessionCwd: null,
      activeCwd: session.cwd,
      isMobile: true,
      sidebarOpen: true,
      rightPanelOpen: true,
      activeFileTabId: "note:board.excalidraw",
      fileTabs: [{ id: "file:readme", viewerState: { scrollTop: 800 } }],
      noteTabs: [{ path: "board.excalidraw" }],
      sessionKey: 5,
      getDraft() { assert.fail("a cleared conversation must start without a parked draft"); },
      rekeyDraft() { assert.fail("the original session's draft stays with it"); },
      router: { replace: (url) => { context.url = url; } },
    });
    setters(context, code);
    run(`${code}\nhandleResetSession();`, context);
    assert.equal(context.selectedSession, null);
    assert.equal(context.sessionKey, 6);
    assert.equal(context.newSessionCwd, session.cwd);
    assert.equal(context.activeNewSessionDraftKeyRef.current, `new:fresh:${session.cwd}`);
    assert.equal(JSON.stringify(context.carriedNewSessionChoices), JSON.stringify({ ...choices, preserveModel: true }));
    assert.equal(context.composerHarness, harness);
    assert.equal(context.harnessModelRef.current, choices.model);
    assert.equal(context.newSessionCarryRef.current, true, "skip folder defaults");
    assert.equal(context.preservedPanelContext.draftId, "fresh");
    assert.equal(context.activeProjectKeyRef.current, "/project");
    assert.equal(context.rightPanelOpen, true);
    assert.equal(context.sidebarOpen, true);
    assert.equal(context.activeFileTabId, "note:board.excalidraw");
    assert.equal(session.messageCount, 10, "the original conversation is untouched");
    assert.equal(context.url, `?cwd=${encodeURIComponent(session.cwd)}`);

    // A config left over from another selection cannot clear this session.
    context.selectedSession = { ...session, id: "other" };
    run("handleResetSession();", context);
    assert.equal(context.selectedSession.id, "other");
    assert.equal(context.sessionKey, 6);

    // LAN HTTP pages do not expose crypto.randomUUID.
    context.selectedSession = session;
    context.crypto = {};
    run("handleResetSession();", context);
    assert.ok(context.newSessionDraftId.length > 10);
    assert.equal(context.sessionKey, 7);
  }
});

test("reset and first-send promotion keep live viewers; a regular switch restores its own panel", () => {
  const code = section(source, "  useEffect(() => {\n    const previous = panelKeyRef.current;", "  // Remembered as the user works");
  const calls = [];
  const saved = [];
  const context = vm.createContext({
    useEffect: (fn) => fn(),
    panelKey: "new:/project",
    panelKeyRef: { current: "session:original" },
    leavingSessionRef: { current: null },
    forgottenSessionsRef: { current: new Set() },
    panelStateRef: { current: { open: true } },
    sessionCwdRef: { current: null },
    fileWorkspaceGenerationRef: { current: 7 },
    terminalTabIdsRef: { current: [] },
    preservePanel: true,
    saveSessionPanel: (id) => saved.push(id),
    readSessionPanel: () => ({ open: false, treeSource: "project", treeCollapsed: false, fileTabs: [], noteTabs: [], activeTabId: null }),
  });
  setters(context, code, calls);
  run(code, context);
  assert.deepEqual(saved, ["original"]);
  assert.deepEqual(calls, [], "no viewer generation, tab or panel state changes");
  context.panelKey = "session:fresh";
  context.sessionCwdRef.current = "/project";
  run(code, context);
  assert.deepEqual(calls, [], "first send must not remount the right panel either");
  context.panelKey = "session:other";
  context.preservePanel = false;
  run(code, context);
  assert.equal(context.fileWorkspaceGenerationRef.current, 8);
  assert.equal(context.rightPanelOpen, false);
  assert.deepEqual(saved, ["original", "fresh"]);
});

test("the notes tree keeps its folders and scroll offset under the new session's memory key", async () => {
  const treeSource = await readFile(new URL("./NotesTree.tsx", import.meta.url), "utf8");
  const code = section(treeSource, "  useEffect(() => {\n    if (!stateKey) return;", "  // The open note or board");
  const saves = [];
  const context = vm.createContext({
    stateKey: "fresh",
    preservePosition: true,
    openedOnce: { current: true },
    scrollRestoredRef: { current: true },
    scrollTopRef: { current: 640 },
    expandedRef: { current: new Set(["kept/folder"]) },
    readNotesTreePosition() { assert.fail("do not restore another tree position on reset"); },
    setExpanded() { assert.fail("do not change folded folders on reset"); },
    saveNotesTreePosition: (id, position) => saves.push([id, position]),
    useEffect: (fn) => { context.cleanup = fn(); },
  });
  run(code, context);
  context.cleanup();
  assert.equal(saves[0][0], "fresh");
  assert.equal(saves[0][1].scrollTop, 640);
  assert.equal(saves[0][1].expanded[0], "kept/folder");
});

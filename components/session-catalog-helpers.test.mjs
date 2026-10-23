import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { composerHarnessFor, isPiSessionFile, mergeCatalogRow } = await jiti.import("./session-catalog-helpers.ts");

function row(overrides = {}) {
  return {
    path: "/s.jsonl", id: "s1", cwd: "/p", created: "2026-01-01", modified: "2026-01-02",
    messageCount: 0, firstMessage: "", transient: false, ...overrides,
  };
}

test("a hydrated row clears the pending marker the first paint set", () => {
  // The catalogue omits detailsPending once details arrive, so a plain spread
  // would leave the selected session marked pending forever.
  const pending = row({ detailsPending: true, messageCount: 0, firstMessage: "" });
  const hydrated = row({ messageCount: 12, firstMessage: "real first message" });
  const merged = mergeCatalogRow(pending, hydrated);
  assert.equal(merged.detailsPending, undefined);
  assert.equal(merged.messageCount, 12);
  assert.equal(merged.firstMessage, "real first message");
});

test("dropped optional keys are cleared, not inherited", () => {
  const current = row({
    relation: { kind: "fork" },
    branch: "feature/x",
    isWorktree: true,
  });
  const merged = mergeCatalogRow(current, row());
  assert.equal(merged.relation, undefined);
  assert.equal(merged.branch, undefined);
  assert.equal(merged.isWorktree, undefined);
});

test("a locally applied title survives until the catalogue carries it", () => {
  // AppShell writes an auto-generated name onto the selected session before the
  // next listing has picked it up off disk.
  const named = row({ name: "auto-generated title" });
  const merged = mergeCatalogRow(named, row());
  assert.equal(merged.name, "auto-generated title");
  // ...and the catalogue wins once it does carry one.
  assert.equal(mergeCatalogRow(named, row({ name: "renamed on disk" })).name, "renamed on disk");
});

test("values the catalogue does carry always win", () => {
  const merged = mergeCatalogRow(row({ modified: "2026-01-02", messageCount: 1 }), row({ modified: "2026-06-01", messageCount: 99, relation: { kind: "subagent", parentSessionId: "p1" } }));
  assert.equal(merged.modified, "2026-06-01");
  assert.equal(merged.messageCount, 99);
  assert.deepEqual(merged.relation, { kind: "subagent", parentSessionId: "p1" });
});

test("an open pi file keeps the pi composer even when the row says grok", () => {
  const path = "/Users/anner/.pi/agent/sessions/--proj--/2026-10-23T03-56-03-390Z_01a166e6-c9bc-76f0-a173-16538635d7a6.jsonl";
  assert.equal(isPiSessionFile(path), true);
  assert.equal(isPiSessionFile("C:\\Users\\anner\\.pi\\agent\\sessions\\proj\\2026-10-23T03-56-03-390Z_01a166e6-c9bc-76f0-a173-16538635d7a6.jsonl"), true);
  assert.equal(isPiSessionFile("/Users/anner/.grok/sessions/%2Fproj/01a166e6-c9bc-76f0-a173-16538635d7a6"), false);
  assert.equal(composerHarnessFor({ id: "01a166e6-c9bc-76f0-a173-16538635d7a6", harness: "grok", path }, "grok"), "pi");
  assert.equal(composerHarnessFor({ id: "g1", harness: "grok", path: "/Users/anner/.grok/sessions/proj/g1" }, "pi"), "grok");
  assert.equal(composerHarnessFor(null, "grok"), "grok");
  assert.equal(composerHarnessFor(null, null), "pi");
});

test("a persisted row clears the transient flag of a fresh session", () => {
  // After a fresh session's first run the sidebar's reload carries its file on
  // disk; that row is what turns on title generation for the selected session.
  const merged = mergeCatalogRow(row({ transient: true, path: "" }), row({ messageCount: 2 }));
  assert.equal(merged.transient, false);
  assert.equal(merged.path, "/s.jsonl");
});

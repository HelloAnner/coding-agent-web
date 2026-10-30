import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = await mkdtemp(path.join(tmpdir(), "pi-web-notes-settings-"));
process.env.CODING_AGENT_WEB_DATA = path.join(dataDir, "data.db");

const { BOARD_FONT_OPTIONS, defaultNotesSettings, normalizeNotesSettings, notesSettingsPath, readNotesSettings, updateNotesSettings } = await import("./settings.ts");
after(() => rm(dataDir, { recursive: true, force: true }));

test("defaults contain only Cascadia 20, not a separate model", () => {
  assert.deepEqual(defaultNotesSettings(), { board: { fontFamily: 3, fontSize: 20 } });
  assert.deepEqual(readNotesSettings(), defaultNotesSettings());
});

test("whiteboard updates merge and remain private", async () => {
  updateNotesSettings({ board: { fontSize: 24 } });
  assert.deepEqual(readNotesSettings().board, { fontFamily: 3, fontSize: 24 });
  updateNotesSettings({ board: { fontSize: 999, fontFamily: 42 } });
  const saved = readNotesSettings();
  assert.deepEqual(saved.board, { fontFamily: 3, fontSize: 64 });
  assert.ok(BOARD_FONT_OPTIONS.some((option) => option.value === saved.board.fontFamily));
  if (process.platform !== "win32") assert.equal((await stat(notesSettingsPath())).mode & 0o777, 0o600);
});

test("legacy model credentials are removed without losing whiteboard preferences", async () => {
  await writeFile(notesSettingsPath(), JSON.stringify({ agent: { apiKey: "retired-secret", model: "old" }, board: { fontFamily: 8, fontSize: 18 } }));
  assert.deepEqual(readNotesSettings(), { board: { fontFamily: 8, fontSize: 18 } });
  assert.deepEqual(JSON.parse(await readFile(notesSettingsPath(), "utf8")), { board: { fontFamily: 8, fontSize: 18 } });
  assert.deepEqual(updateNotesSettings({ agent: { apiKey: "never-save-this", model: "ignored" } }), { board: { fontFamily: 8, fontSize: 18 } });
  assert.doesNotMatch(await readFile(notesSettingsPath(), "utf8"), /secret|apiKey|agent|model/);
});

test("a broken file reads as defaults instead of throwing", async () => {
  await writeFile(notesSettingsPath(), "{ not json");
  assert.deepEqual(readNotesSettings(), defaultNotesSettings());
});

test("normalize retains only valid whiteboard preferences", () => {
  assert.deepEqual(normalizeNotesSettings({ agent: { apiKey: "ignored" }, board: { fontFamily: 8, fontSize: 12.4 } }), { board: { fontFamily: 8, fontSize: 12 } });
});

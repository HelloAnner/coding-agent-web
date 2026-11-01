import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

const dataDir = await mkdtemp(path.join(tmpdir(), "pi-web-notes-settings-"));
process.env.CODING_AGENT_WEB_DATA = path.join(dataDir, "data.db");

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { BOARD_FONT_OPTIONS, defaultNotesSettings, normalizeNotesSettings, notesSettingsPath, readNotesSettings, updateNotesSettings } = await jiti.import("./settings.ts");
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

test("drawing styles share one config, merge with fonts and reject non-style state", async () => {
  await writeFile(notesSettingsPath(), JSON.stringify(defaultNotesSettings()));
  updateNotesSettings({ board: { style: { currentItemBackgroundColor: "transparent", currentItemStrokeColor: "#e03131", currentItemStrokeWidth: 4 } } });
  updateNotesSettings({ board: { fontFamily: 6, fontSize: 28, style: { currentItemFillStyle: "hachure", currentItemEndArrowhead: null } } });
  const expected = {
    fontFamily: 6, fontSize: 28,
    style: { currentItemBackgroundColor: "transparent", currentItemStrokeColor: "#e03131", currentItemFillStyle: "hachure", currentItemStrokeWidth: 4, currentItemEndArrowhead: null },
  };
  assert.deepEqual(readNotesSettings().board, expected);
  assert.deepEqual(JSON.parse(await readFile(notesSettingsPath(), "utf8")).board, expected);
  assert.deepEqual(updateNotesSettings({ board: { style: {
    currentItemBackgroundColor: "url(unsafe)", currentItemStrokeColor: {}, currentItemStrokeWidth: Infinity,
    currentItemOpacity: -1, currentItemFillStyle: "invalid", currentItemRoundness: "invalid",
    currentItemEndArrowhead: "invalid", scrollX: 100, selectedElementIds: { other: true },
  } } }).board, expected);
});

test("a broken file reads as defaults instead of throwing", async () => {
  await writeFile(notesSettingsPath(), "{ not json");
  assert.deepEqual(readNotesSettings(), defaultNotesSettings());
});

test("normalize retains only valid whiteboard preferences", () => {
  assert.deepEqual(normalizeNotesSettings({ agent: { apiKey: "ignored" }, board: { fontFamily: 8, fontSize: 12.4 } }), { board: { fontFamily: 8, fontSize: 12 } });
});

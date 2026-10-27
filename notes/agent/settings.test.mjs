import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dataDir = await mkdtemp(path.join(tmpdir(), "pi-web-notes-settings-"));
process.env.CODING_AGENT_WEB_DATA = path.join(dataDir, "data.db");

const {
  BOARD_FONT_OPTIONS,
  defaultNotesSettings,
  normalizeNotesSettings,
  notesSettingsPath,
  publicNotesSettings,
  readNotesSettings,
  updateNotesSettings,
} = await import("./settings.ts");

after(() => rm(dataDir, { recursive: true, force: true }));

test("defaults are a pi-backed model and Cascadia 20", () => {
  assert.deepEqual(defaultNotesSettings().board, { fontFamily: 3, fontSize: 20 });
  assert.equal(defaultNotesSettings().agent.baseUrl, "");
  assert.deepEqual(readNotesSettings(), defaultNotesSettings());
});

test("a partial update merges and is written at 0600", async () => {
  const saved = updateNotesSettings({ agent: { baseUrl: "https://api.example.com/v1/", model: "notes-xl" } });
  assert.equal(saved.agent.baseUrl, "https://api.example.com/v1");
  assert.equal(saved.agent.model, "notes-xl");
  assert.equal(saved.board.fontSize, 20);
  assert.deepEqual(readNotesSettings(), saved);
  assert.ok(path.basename(notesSettingsPath()).endsWith(".json"));

  updateNotesSettings({ board: { fontSize: 999, fontFamily: 42 } });
  const clamped = readNotesSettings();
  assert.equal(clamped.board.fontSize, 64);
  // An unknown font id falls back to the default rather than breaking the board.
  assert.equal(clamped.board.fontFamily, 3);
  assert.ok(BOARD_FONT_OPTIONS.some((option) => option.value === clamped.board.fontFamily));
});

test("an empty API key keeps the stored one and never leaves the server", () => {
  updateNotesSettings({ agent: { apiKey: "sk-1", model: "m1" } });
  updateNotesSettings({ agent: { apiKey: "", model: "m2" } });
  const stored = readNotesSettings();
  assert.equal(stored.agent.apiKey, "sk-1");
  assert.equal(stored.agent.model, "m2");
  const masked = publicNotesSettings(stored);
  assert.equal(masked.settings.agent.apiKey, "");
  assert.equal(masked.apiKeySet, true);
});

test("a broken file reads as defaults instead of throwing", async () => {
  await writeFile(notesSettingsPath(), "{ not json");
  assert.deepEqual(readNotesSettings(), defaultNotesSettings());
});

test("normalize keeps every value in range", () => {
  const normalized = normalizeNotesSettings({
    agent: { apiKey: "  sk-1  ", contextWindow: 1, maxTokens: 1e12, api: "" },
    board: { fontFamily: 8, fontSize: 12.4 },
  });
  assert.equal(normalized.agent.apiKey, "sk-1");
  assert.equal(normalized.agent.contextWindow, 1000);
  assert.equal(normalized.agent.maxTokens, 1_000_000);
  assert.equal(normalized.agent.api, "openai-completions");
  assert.deepEqual(normalized.board, { fontFamily: 8, fontSize: 12 });
});

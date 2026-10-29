import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(path.join(tmpdir(), "pi-web-notes-profile-"));
const agentDir = path.join(root, "agent");
const vault = path.join(root, "vault");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(root, "sessions");
process.env.CODING_AGENT_WEB_DATA = path.join(root, "data.db");
process.env.CODING_AGENT_WEB_NOTES_DIR = vault;
await mkdir(agentDir, { recursive: true });
await mkdir(path.join(vault, ".pi"), { recursive: true });
const settingsPath = path.join(agentDir, "settings.json");
const globalSettings = JSON.stringify({
  defaultProvider: "notes-test",
  defaultModel: "preferred",
  defaultThinkingLevel: "high",
  modelThinkingLevels: { "notes-test/preferred": "low" },
  defaultTools: ["bash", "write"],
  packages: ["/must-not-load-coding-packages"],
});
await writeFile(settingsPath, globalSettings);
await writeFile(path.join(vault, ".pi", "settings.json"), JSON.stringify({ defaultModel: "fallback" }));
await writeFile(path.join(agentDir, "auth.json"), "{}");
await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
  providers: {
    "notes-test": {
      baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "test-only",
      models: [{ id: "fallback" }, { id: "preferred", reasoning: true }],
    },
  },
}));
after(() => rm(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createNotesSession } = await jiti.import("./profile.ts");
const { sessionDigestPrompt } = await jiti.import("./digest.ts");
const { defaultNotesSettings, writeNotesSettings } = await jiti.import("./settings.ts");

test("a board-only session receives drawing skill bodies without a file reader", async (t) => {
  const { session } = await createNotesSession({
    systemPrompt: sessionDigestPrompt("方案.excalidraw", "画出最终方案"),
    skills: ["whiteboard-style", "whiteboard-drawing"],
    tools: ["notes_board"],
    onlyBoard: "方案.excalidraw",
  });
  t.after(() => session.dispose());
  assert.deepEqual(session.getActiveToolNames(), ["notes_board"]);
  for (const name of ["whiteboard-style", "whiteboard-drawing"]) {
    const body = await readFile(path.join(process.cwd(), "notes", "skills", name, "SKILL.md"), "utf8");
    assert.ok(session.systemPrompt.includes(body), `${name} must be readable in the prompt itself`);
  }
  assert.doesNotMatch(session.systemPrompt, /name: note-writing|<available_skills>/);
});

test("notes inherits global model defaults in memory, not vault or coding resource settings", async (t) => {
  const { session, modelLabel } = await createNotesSession({ tools: [], skills: [] });
  t.after(() => session.dispose());
  assert.equal(session.model?.provider, "notes-test");
  assert.equal(session.model?.id, "preferred");
  assert.equal(modelLabel, "notes-test/preferred");
  assert.equal(session.thinkingLevel, "low");
  assert.deepEqual(session.getActiveToolNames(), []);
  assert.doesNotMatch(session.systemPrompt, /name: whiteboard-/);
  assert.equal(session.settingsManager.getGlobalSettings().packages, undefined);
  assert.equal(session.settingsManager.getGlobalSettings().defaultTools, undefined);
  session.settingsManager.setDefaultModel("memory-only");
  await session.settingsManager.flush();
  assert.equal(await readFile(settingsPath, "utf8"), globalSettings);
});

test("an explicitly configured notes model still takes precedence", async (t) => {
  const settings = defaultNotesSettings();
  settings.agent = { ...settings.agent, baseUrl: "http://127.0.0.1:1/v1", model: "custom", apiKey: "test-only" };
  writeNotesSettings(settings);
  const { session, modelLabel } = await createNotesSession();
  t.after(() => session.dispose());
  assert.equal(session.model?.provider, "notes");
  assert.equal(session.model?.id, "custom");
  assert.equal(modelLabel, "notes/custom");
  assert.match(session.systemPrompt, /<available_skills>/);
  assert.doesNotMatch(session.systemPrompt, /name: whiteboard-style/);
  assert.equal(await readFile(settingsPath, "utf8"), globalSettings);
});

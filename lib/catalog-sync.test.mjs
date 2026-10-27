import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// realpath: macOS reports /var while a realpath'd profile path is /private/var.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "catalog-sync-")));
const previous = {
  data: process.env.CODING_AGENT_WEB_DATA,
  dsh: process.env.DSH_HOME,
  grok: process.env.GROK_HOME,
  pi: process.env.PI_CODING_AGENT_DIR,
};
process.env.CODING_AGENT_WEB_DATA = path.join(root, "data.db");
process.env.DSH_HOME = path.join(root, "dsh");
process.env.GROK_HOME = path.join(root, "grok");
// Keep pi's scan away from the real ~/.pi: an empty agent dir yields no sessions.
process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const db = await jiti.import("./catalog-db.ts");
const sync = await jiti.import("./catalog-sync.ts");

const project = path.join(root, "project");
const dshId = "11111111-1111-4111-8111-111111111111";
const claudeId = "22222222-2222-4222-8222-222222222222";
const grokId = "33333333-3333-4333-8333-333333333333";

function writeLines(file, lines) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

// dsh: a kernel log whose first record names the cwd.
const dshDir = path.join(process.env.DSH_HOME, "sessions", "--tmp-project--", dshId);
writeLines(path.join(dshDir, "session.v4.jsonl"), [
  { type: "session", version: 4, id: dshId, cwd: project, createdAt: 1000 },
  { type: "user/message", seq: 0, time: 1001, data: { source: { kind: "user" }, content: [{ type: "text", text: "dsh hello" }] } },
]);

// claude-code: the profile directory holds the transcript two levels down.
const claudeDir = path.join(root, "claude");
const claudeFile = path.join(claudeDir, "projects", "-tmp-project", `${claudeId}.jsonl`);
writeLines(claudeFile, [
  { type: "custom-title", customTitle: "Claude hello" },
  { type: "user", cwd: project, message: { role: "user", content: [{ type: "text", text: "claude hello" }] } },
]);
mkdirSync(path.dirname(path.join(root, "claude-code.json")), { recursive: true });
writeFileSync(path.join(root, "claude-code.json"), JSON.stringify({
  profiles: [{ id: "default", name: "Local", provider: "local", configDir: claudeDir }],
}));

// grok: the cwd lives in the URL-encoded directory name.
const grokDir = path.join(process.env.GROK_HOME, "sessions", encodeURIComponent(project), grokId);
writeLines(path.join(grokDir, "chat_history.jsonl"), [
  { type: "user", content: [{ type: "text", text: "<user_query>grok hello</user_query>" }] },
  { type: "assistant", content: "hi", model_id: "grok-code" },
]);

// An index from before the fix: the Claude row names the profile directory.
db.upsertCatalogSession({
  id: claudeId,
  cwd: project,
  harness: "claude-code",
  provider: "local",
  model: "default",
  title: "old row",
  sessionPath: claudeDir,
});

test.after(() => {
  db.closeCatalogDb();
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previous)) {
    const name = { data: "CODING_AGENT_WEB_DATA", dsh: "DSH_HOME", grok: "GROK_HOME", pi: "PI_CODING_AGENT_DIR" }[key];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("repairs the Claude profile row and backfills every harness with a readable file", async () => {
  const result = await sync.syncCatalogSessions();
  assert.deepEqual(result, { added: 2, repaired: 1 });

  const rows = db.listCatalogSessionPaths();
  assert.equal(rows.length, 3);
  const byHarness = Object.fromEntries(rows.map((row) => [row.harness, row]));

  assert.equal(byHarness["claude-code"].sessionPath, claudeFile);
  assert.equal(byHarness["claude-code"].profilePath, claudeDir);
  assert.equal(byHarness["claude-code"].cwd, project);

  assert.equal(byHarness.dsh.sessionPath, dshDir);
  assert.equal(byHarness.dsh.cwd, project);
  assert.equal(byHarness.dsh.title, "dsh hello");

  assert.equal(byHarness.grok.sessionPath, path.join(grokDir, "chat_history.jsonl"));
  assert.equal(byHarness.grok.cwd, project);
  assert.equal(byHarness.grok.title, "grok hello");
});

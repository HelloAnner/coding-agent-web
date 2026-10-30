import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

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
const claudeId = "22222222-2222-4222-8222-222222222222";
const dshId = "11111111-1111-4111-8111-111111111111";
const grokId = "33333333-3333-4333-8333-333333333333";

function writeLines(file, lines) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

// A session that exists only on disk: the index must not pick it up.
const dshDir = path.join(process.env.DSH_HOME, "sessions", "--tmp-project--", dshId);
writeLines(path.join(dshDir, "session.v4.jsonl"), [
  { type: "session", version: 4, id: dshId, cwd: project, createdAt: 1000 },
  { type: "user/message", seq: 0, time: 1001, data: { source: { kind: "user" }, content: [{ type: "text", text: "dsh hello" }] } },
]);
writeLines(path.join(process.env.GROK_HOME, "sessions", encodeURIComponent(project), grokId, "chat_history.jsonl"), [
  { type: "user", content: [{ type: "text", text: "<user_query>grok hello</user_query>" }] },
]);

// A web chat from before the fix: the Claude row named the profile directory.
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

test("repairs a web row's path and leaves disk-only sessions out of the index", async () => {
  const result = await sync.repairCatalogSessionPaths();
  assert.deepEqual(result, { repaired: 1 });

  const rows = db.listCatalogSessionPaths();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, claudeId);
  assert.equal(rows[0].sessionPath, claudeFile);
  assert.equal(rows[0].profilePath, claudeDir);
});

test("legacy Pi labels are repaired only from matching headers inside Pi's real root", async () => {
  const piId = "44444444-4444-4444-8444-444444444444";
  const ompId = "omp-55555555-5555-4555-8555-555555555555";
  const escapedId = "66666666-6666-4666-8666-666666666666";
  const nativeRoot = path.join(process.env.PI_CODING_AGENT_DIR, "sessions", "project");
  const piFile = path.join(nativeRoot, `2026-10-30T00-00-00-000Z_${piId}.jsonl`);
  writeLines(piFile, [{ type: "session", version: 3, id: piId, cwd: project }]);
  db.upsertCatalogSession({ id: piId, cwd: project, harness: "grok", sessionPath: piFile });
  const ompFile = path.join(root, "omp", "sessions", `2026-10-30T00-00-00-000Z_${piId}.jsonl`);
  writeLines(ompFile, [{ type: "title" }, { type: "session", version: 3, id: piId, cwd: project }]);
  db.upsertCatalogSession({ id: ompId, cwd: project, harness: "omp", sessionPath: ompFile, profilePath: path.join(root, "omp") });
  const escaped = path.join(root, "outside", "session.jsonl");
  writeLines(escaped, [{ type: "session", version: 3, id: escapedId, cwd: project }]);
  const link = path.join(nativeRoot, `2026-10-30T00-00-00-000Z_${escapedId}.jsonl`);
  symlinkSync(escaped, link);
  db.upsertCatalogSession({ id: escapedId, cwd: project, harness: "grok", sessionPath: link });
  globalThis.__piWebCatalogRepair = undefined;
  assert.deepEqual(await sync.repairCatalogSessionPaths(), { repaired: 1 });
  assert.equal(db.readCatalogSession(piId).harness, "pi");
  assert.equal(db.readCatalogSession(ompId).harness, "omp");
  assert.equal(db.readCatalogSession(escapedId).harness, "grok");
});

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

// A fake Coding install: the harness session files live under the agent dir,
// and the ingest state lands in a throwaway database.
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-ingest-"));
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-ingest-db-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODING_AGENT_WEB_DATA = join(dataDir, "data.db");

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { claimSessions, listCodingSessions, readCodingSession } = await jiti.import("./ingest.ts");
const { invalidateSessionListCache } = await jiti.import("../lib/session-reader.ts");

const timestamp = "2026-01-01T00:00:00.000Z";
const projectCwd = join(agentDir, "work", "app");
const sessionFile = join(agentDir, "sessions", "proj", "sess1.jsonl");

function write(lines) {
  writeFileSync(sessionFile, lines.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  invalidateSessionListCache();
}

mkdirSync(projectCwd, { recursive: true });
mkdirSync(join(agentDir, "sessions", "proj"), { recursive: true });

after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

test("a new session is pending until a run has read that version", async () => {
  write([
    { type: "session", version: 3, id: "sess1", cwd: projectCwd, timestamp },
    { type: "message", id: "m1", parentId: null, timestamp, message: { role: "user", content: "把登录改成 JWT" } },
    {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp,
      message: { role: "assistant", model: "m", provider: "p", content: [{ type: "text", text: "换成 JWT，令牌放在 Authorization 头。" }] },
    },
  ]);

  const first = await listCodingSessions();
  assert.equal(first.length, 1);
  assert.equal(first[0].id, "sess1");
  assert.equal(first[0].pending, true);
  assert.equal(first[0].projectDir, "app");
  assert.equal(first[0].messageCount, 2);

  const transcript = await readCodingSession("sess1");
  assert.match(transcript, /把登录改成 JWT/);
  assert.match(transcript, /令牌放在 Authorization 头/);

  claimSessions(first);
  assert.deepEqual((await listCodingSessions()).map((session) => session.pending), [false]);

  // A new turn moves the session's version; the notes must read it again.
  appendFileSync(sessionFile, `${JSON.stringify({
    type: "message", id: "m3", parentId: "m2", timestamp: "2026-01-01T00:20:00.000Z",
    message: { role: "user", content: "刷新令牌也换成 JWT" },
  })}\n`);
  invalidateSessionListCache();

  const again = await listCodingSessions();
  assert.deepEqual(again.map((session) => [session.pending, session.messageCount]), [[true, 3]]);
});

test("an unknown session id reads as nothing", async () => {
  assert.equal(await readCodingSession("nope"), null);
});

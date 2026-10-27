import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { codingSessions, projectDirName, sessionTranscript, sessionsPrompt } = await jiti.import("./ingest.ts");

const EMPTY_STATE = { version: 1, revision: 0, sessions: {}, projects: {} };

function session(overrides) {
  return {
    path: "/home/me/.pi/agent/sessions/x.jsonl",
    id: "s1",
    cwd: "/work/app",
    projectRoot: "/work/app",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:10:00.000Z",
    messageCount: 4,
    firstMessage: "修一下登录",
    ...overrides,
  };
}

test("a project maps to a vault directory named after its folder", () => {
  assert.equal(projectDirName("/Users/me/coding/coding-agent-web"), "coding-agent-web");
  assert.equal(projectDirName("/Users/me/coding/app/"), "app");
  // The vault rejects these characters, and a leading dot hides the directory.
  assert.equal(projectDirName("/work/we:ird*name"), "we-ird-name");
  assert.equal(projectDirName("/work/.hidden"), "hidden");
  assert.equal(projectDirName("/"), "项目");
});

test("only non-archived sessions with content are on the reading list", () => {
  const catalog = [
    session({ id: "keep" }),
    session({ id: "empty", messageCount: 0 }),
    session({ id: "archived", modified: "2026-01-01T00:00:00.000Z" }),
    session({ id: "old", modified: "2025-12-01T00:00:00.000Z" }),
    session({ id: "sub", relation: { kind: "subagent", parentSessionId: "keep", profile: "x", description: "d", status: "done" } }),
  ];
  const uiState = { ...EMPTY_STATE, sessions: { archived: { archivedAt: Date.parse("2026-01-01T00:00:00.000Z") } } };

  const now = Date.parse("2026-01-02T00:00:00.000Z");
  const list = codingSessions(catalog, uiState, new Map(), now);
  assert.deepEqual(list.map((item) => item.id), ["keep", "old"]);
  // The session written 30 seconds ago is still moving.
  assert.deepEqual(codingSessions([session({ id: "live", modified: "2026-01-01T23:59:30.000Z" })], EMPTY_STATE, new Map(), now), []);
  assert.deepEqual(list[0], {
    id: "keep",
    path: "/home/me/.pi/agent/sessions/x.jsonl",
    projectRoot: "/work/app",
    projectDir: "app",
    name: "修一下登录",
    modified: "2026-01-01T00:10:00.000Z",
    messageCount: 4,
    pending: true,
  });
});

test("a session already read at this version is no longer pending", () => {
  const catalog = [session({ id: "seen" })];
  const known = new Map([["seen", { sessionId: "seen", path: "x", project: "/work/app", modified: "2026-01-01T00:10:00.000Z", messageCount: 4, processedAt: 1 }]]);
  const now = Date.parse("2026-01-02T00:00:00.000Z");
  assert.equal(codingSessions(catalog, EMPTY_STATE, known, now)[0].pending, false);

  const again = new Map([["seen", { ...known.get("seen"), modified: "2026-01-01T00:09:00.000Z" }]]);
  assert.equal(codingSessions(catalog, EMPTY_STATE, again, now)[0].pending, true);

  const fewer = new Map([["seen", { ...known.get("seen"), messageCount: 2 }]]);
  assert.equal(codingSessions(catalog, EMPTY_STATE, fewer, now)[0].pending, true);
});

test("the transcript keeps turns and tool calls, drops tool results and thinking", () => {
  const entries = [
    { type: "message", id: "1", parentId: null, timestamp: "", message: { role: "user", content: "把登录改成 JWT" } },
    {
      type: "message",
      id: "2",
      parentId: "1",
      timestamp: "",
      message: {
        role: "assistant",
        model: "m",
        provider: "p",
        content: [
          { type: "thinking", thinking: "不重要的推理" },
          { type: "text", text: "换成 JWT，令牌放在 Authorization 头。" },
          { type: "toolCall", toolCallId: "t1", toolName: "edit", input: { path: "src/auth.ts", oldText: "a", newText: "b" } },
        ],
      },
    },
    { type: "message", id: "3", parentId: "2", timestamp: "", message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "一大堆日志" }] } },
    { type: "compaction", id: "4", parentId: "3", timestamp: "", summary: "已讨论过刷新令牌", firstKeptEntryId: "1", tokensBefore: 10 },
  ];
  const text = sessionTranscript(entries);
  assert.match(text, /## 用户\n把登录改成 JWT/);
  assert.match(text, /## 助手\n换成 JWT/);
  assert.match(text, /· edit src\/auth\.ts/);
  assert.match(text, /## 压缩摘要\n已讨论过刷新令牌/);
  assert.equal(text.includes("不重要的推理"), false);
  assert.equal(text.includes("一大堆日志"), false);
});

test("a long session keeps its tail, where the conclusions are", () => {
  const entries = Array.from({ length: 400 }, (_, index) => ({
    type: "message",
    id: String(index),
    parentId: null,
    timestamp: "",
    message: { role: "user", content: `第 ${index} 轮：${"内容".repeat(40)}` },
  }));
  const text = sessionTranscript(entries);
  assert.match(text, /^（前 \d+ 字符省略/);
  assert.match(text, /第 399 轮/);
  assert.ok(text.length < 21_000);
});

test("the prompt names each session, its project and its vault directory", () => {
  const prompt = sessionsPrompt([
    { id: "abc", path: "/p.jsonl", projectRoot: "/work/app", projectDir: "app", name: "登录改造", modified: "2026-01-01T00:10:00.000Z", messageCount: 12, pending: true },
  ], 2);
  assert.match(prompt, /「登录改造」（id `abc`）/);
  assert.match(prompt, /项目 \/work\/app → 笔记目录 app\//);
  assert.match(prompt, /notes_sessions action=read/);
  assert.match(prompt, /另有 2 个会话在排队/);
});

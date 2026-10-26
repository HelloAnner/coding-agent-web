import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { collectUsage } from "./usage-collectors.ts";

const time = "2026-10-20T01:30:00.000Z";
const nextHour = "2026-10-20T02:30:00.000Z";
const nextDay = "2026-10-21T01:30:00.000Z";
const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 0.025 } };
const piMessage = (id, timestamp = time, extra = {}) => ({ type: "message", id, timestamp, message: { role: "assistant", model: "pi-model", provider: "pi-provider", content: [], usage, ...extra } });

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "usage-collectors-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const write = async (file, records) => {
    const path = join(home, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof records === "string" || Buffer.isBuffer(records) ? records : records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    return path;
  };
  const collect = (roots, options = {}) => collectUsage({ roots: roots.map(([harness, path]) => ({ harness, path: join(home, path) })), discoverDefaults: false, timeZone: "UTC", startDay: "2026-10-20", endDay: "2026-10-21", ...options });
  return { home, write, collect };
}

const day = (snapshot, key = "2026-10-20") => snapshot.days.find((entry) => entry.day === key);
const daily = (snapshot, harness) => snapshot.buckets.filter((entry) => entry.hour === -1 && (!harness || entry.harness === harness));

test("pi collects all persisted branches, auxiliary billed calls, dimensions, and distinct sessions", async (t) => {
  const { write, collect } = await fixture(t);
  await write("pi/project/a.jsonl", [
    { type: "session", id: "session-a", timestamp: time },
    { type: "model_change", modelId: "pi-model", provider: "pi-provider" },
    { type: "message", id: "u", timestamp: time, message: { role: "user", content: "not exposed" } },
    piMessage("a", time, { content: [{ type: "toolCall", toolCallId: "tool-a", input: { secret: "never exposed" } }] }),
    piMessage("b", nextHour),
    { type: "compaction", id: "c", timestamp: nextHour, usage },
    { type: "branch_summary", id: "d", timestamp: nextHour, usage },
    { type: "usage", id: "warm", timestamp: nextHour, usage },
    { type: "message", id: "tool", timestamp: nextHour, message: { role: "toolResult", isError: true } },
    piMessage("next-day", nextDay, { model: "other-model", usage: undefined, stopReason: "error" }),
  ]);
  const result = await collect([["pi", "pi"]]);
  assert.equal(result.complete, true);
  assert.equal(day(result).inputTokens, 50);
  assert.equal(day(result).outputTokens, 25);
  assert.equal(day(result).cacheReadTokens, 15);
  assert.equal(day(result).cacheWriteTokens, 10);
  assert.equal(day(result).totalTokens, 100);
  assert.equal(day(result).cost, 0.125);
  assert.equal(day(result).requests, 5);
  assert.equal(day(result).messages, 4);
  assert.equal(day(result).toolCalls, 1);
  assert.equal(day(result).errors, 1);
  assert.equal(day(result).sessions, 1);
  assert.equal(day(result, "2026-10-21").cost, null);
  assert.equal(day(result, "2026-10-21").costUnknownRequests, 1);
  assert.equal(day(result, "2026-10-21").errors, 1);
  const hours = result.buckets.filter((entry) => entry.day === "2026-10-20" && entry.hour >= 0);
  assert.deepEqual(hours.map((entry) => entry.hour), [1, 2]);
  assert.equal(hours.reduce((sum, entry) => sum + entry.sessions, 0), 2);
  assert.equal(daily(result, "pi").find((entry) => entry.day === "2026-10-20").sessions, 1);
  assert.equal(new Set(hours.flatMap((entry) => entry.sessionIds)).size, 1);
  assert.ok(!JSON.stringify(result).includes("never exposed"));
});

test("duplicate pi entries and fork-shared messages are charged once", async (t) => {
  const { write, collect } = await fixture(t);
  await write("pi/a.jsonl", [{ type: "session", id: "a" }, piMessage("shared"), piMessage("shared")]);
  await write("pi/b.jsonl", [{ type: "session", id: "b", parentSession: "a.jsonl" }, piMessage("shared"), piMessage("new", nextHour)]);
  const result = await collect([["pi", "pi"], ["pi", "pi/a.jsonl"]]);
  assert.equal(day(result).requests, 2);
  assert.equal(day(result).totalTokens, 40);
  assert.equal(day(result).sessions, 2);
  assert.equal(result.diagnostics.reduce((sum, source) => sum + source.duplicates, 0), 3);
});

test("Claude Code coalesces cumulative message snapshots and split tool blocks, not cumulative cost-state", async (t) => {
  const { write, collect } = await fixture(t);
  const assistant = (uuid, id, timestamp, input, output, content = []) => ({ type: "assistant", uuid, timestamp, message: { role: "assistant", id, model: "claude-test", usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 }, content } });
  await write("claude/project/session.jsonl", [
    assistant("uuid-a", "response-a", time, 10, 1, [{ type: "tool_use", id: "tool-a" }]),
    assistant("uuid-b", "response-a", time, 10, 5, [{ type: "tool_use", id: "tool-b" }]),
    assistant("uuid-c", "response-b", nextHour, 20, 2),
    { type: "user", uuid: "tool-result", timestamp: nextHour, message: { role: "user", content: [{ type: "tool_result", is_error: true, tool_use_id: "tool-a" }] } },
    { type: "assistant", uuid: "synthetic", timestamp: nextHour, message: { id: "synthetic", model: "<synthetic>", content: [] } },
    { type: "user", uuid: "compact", timestamp: time, isCompactSummary: true, message: { content: "summary" } },
    { type: "cost-state", timestamp: nextHour, totalCostUSD: 900, modelUsage: { "claude-test": { inputTokens: 9000 } } },
  ]);
  // Shared assistant IDs across a branch and subagent logs must not double bill.
  await write("claude/project/fork.jsonl", [assistant("uuid-d", "response-a", time, 10, 5, [{ type: "tool_use", id: "tool-a" }])]);
  await write("claude/project/session/subagents/agent-x.jsonl", [assistant("sub-agent", "response-sub", nextHour, 3, 1)]);
  const result = await collect([["claude-code", "claude"]]);
  assert.equal(day(result).requests, 3);
  assert.equal(day(result).inputTokens, 33);
  assert.equal(day(result).outputTokens, 8);
  assert.equal(day(result).cacheReadTokens, 12);
  assert.equal(day(result).cacheWriteTokens, 6);
  assert.equal(day(result).toolCalls, 2);
  assert.equal(day(result).messages, 4);
  assert.equal(day(result).errors, 1);
  assert.equal(day(result).cost, null);
  assert.equal(day(result).costUnknownRequests, 3);
  assert.ok(result.diagnostics[0].limitations.includes("cumulative_cost_and_usage_excluded"));
});

test("dsh reads native data.usage, source attribution, user filtering and newest generation", async (t) => {
  const { write, collect } = await fixture(t);
  const records = [
    { type: "session", id: "native-dsh" },
    { type: "request/context", seq: 1, time: Date.parse(time), data: { provider: "deepseek-official", model: "deepseek-flash" } },
    { type: "user/message", seq: 2, time: Date.parse(time), data: { id: "user", source: { kind: "user" } } },
    { type: "user/message", seq: 3, time: Date.parse(time), data: { source: { kind: "kernel" } } },
    { type: "assistant/message", seq: 4, time: Date.parse(time), data: { usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 5, totalTokens: 18 }, message: { id: "response", source: { model: "deepseek-flash", provider: "deepseek-official" }, content: [{ type: "tool-call", id: "tool-a" }] } } },
    { type: "tool/result", seq: 5, time: Date.parse(nextHour), data: { message: { toolCallId: "tool-a", isError: true } } },
  ];
  await write("dsh/project/session/session.v3.jsonl", records);
  await write("dsh/project/session/session.v4.jsonl", records);
  const result = await collect([["dsh", "dsh"]]);
  assert.equal(day(result).inputTokens, 10);
  assert.equal(day(result).cacheReadTokens, 5);
  assert.equal(day(result).totalTokens, 18);
  assert.equal(day(result).requests, 1);
  assert.equal(day(result).messages, 3);
  assert.equal(day(result).toolCalls, 1);
  assert.equal(day(result).errors, 1);
  assert.equal(daily(result)[0].provider, "deepseek-official");
  assert.equal(daily(result)[0].model, "deepseek-flash");
  assert.equal(result.diagnostics[0].files, 1);
  assert.ok(result.diagnostics[0].limitations.includes("superseded_log_generations_excluded"));
});

test("dsh streams every concatenated Zstd frame including UTF8 split across frames", async (t) => {
  const { write, collect } = await fixture(t);
  const record = JSON.stringify({ type: "assistant/message", seq: 1, time: Date.parse(time), data: { usage: { inputTokens: 12, outputTokens: 3 }, message: { id: "response", source: { model: "dsh-model" }, content: [{ type: "text", text: "中文" }] } } }) + "\n";
  const bytes = Buffer.from(record);
  const split = bytes.indexOf(Buffer.from("中文")) + 1;
  await write("dsh/project/id/session.v4.jsonl.zstd", Buffer.concat([
    zstdCompressSync(Buffer.from(JSON.stringify({ type: "session", id: "compressed" }) + "\n")),
    zstdCompressSync(bytes.subarray(0, split)),
    zstdCompressSync(bytes.subarray(split)),
    Buffer.from([0x28, 0xb5, 0x2f]),
  ]));
  const result = await collect([["dsh", "dsh"]]);
  assert.equal(result.complete, true);
  assert.equal(day(result).totalTokens, 15);
  assert.equal(day(result).requests, 1);
  assert.ok(result.diagnostics[0].limitations.includes("incomplete_compressed_tail_skipped"));
});

test("Grok uses per-turn per-model ledger, never cumulative session totals or untimed chat history", async (t) => {
  const { write, collect } = await fixture(t);
  await write("grok/project/session/usage.json", JSON.stringify({
    sessionId: "grok-session", updatedAt: nextDay,
    session: { inputTokens: 999999, totalTokens: 999999, modelCalls: 999 },
    turns: [
      { turnNumber: 1, endedAt: time, inputTokens: 12345, totalTokens: 12345, primaryModelId: "grok-a", modelUsage: {
        "grok-a": { inputTokens: 100, outputTokens: 10, cachedReadTokens: 20, cacheCreationTokens: 2, totalTokens: 132, modelCalls: 2, costUsdTicks: 100 },
        "grok-b": { inputTokens: 50, outputTokens: 5, cachedReadTokens: 0, cacheCreationTokens: 0, totalTokens: 55, modelCalls: 1, costUsd: 0 },
      } },
      { turnNumber: 2, endedAt: nextDay, primaryModelId: "grok-a", inputTokens: 4, outputTokens: 1, totalTokens: 5, modelCalls: 1 },
    ],
  }));
  await write("grok/project/session/events.jsonl", [
    { type: "turn_started", ts: time, model_id: "grok-a" },
    { type: "first_token", ts: time },
    { type: "tool_completed", ts: nextHour, tool_call_id: "tool", outcome: "error" },
    { type: "phase_changed", ts: time, phase: "ignored" },
  ]);
  await write("grok/project/session/chat_history.jsonl", [{ type: "assistant", content: "no timestamp", model_id: "grok-a" }]);
  const result = await collect([["grok", "grok"]]);
  assert.equal(day(result).totalTokens, 187);
  assert.equal(day(result).requests, 3);
  assert.equal(day(result).inputTokens, 150);
  assert.equal(day(result).cacheReadTokens, 20);
  assert.equal(day(result).messages, 3);
  assert.equal(day(result).toolCalls, 1);
  assert.equal(day(result).errors, 1);
  assert.equal(day(result).sessions, 1);
  assert.equal(day(result).cost, 0);
  assert.equal(day(result).costKnownRequests, 1);
  assert.equal(day(result).costUnknownRequests, 2);
  assert.equal(day(result, "2026-10-21").totalTokens, 5);
  assert.equal(daily(result, "grok").filter((entry) => entry.day === "2026-10-20").length, 2);
  assert.ok(result.diagnostics[0].limitations.includes("cost_usd_ticks_unit_unknown"));
  assert.equal(result.diagnostics[0].missingTimestamps, 0);
});

test("untimed native Grok history is diagnosed, not fabricated from mtime", async (t) => {
  const { write, collect } = await fixture(t);
  await write("grok/session/chat_history.jsonl", [
    { type: "user", content: "<rules>synthetic</rules>", synthetic_reason: "rules" },
    { type: "assistant", content: "answer", model_id: "grok-a" },
  ]);
  const result = await collect([["grok", "grok"]]);
  assert.equal(day(result).requests, 0);
  assert.equal(result.diagnostics[0].missingTimestamps, 1);
  assert.ok(result.diagnostics[0].limitations.includes("undated_events_excluded"));
  assert.equal(result.complete, true);
});

test("local calendar bounds honor DST and union repeated hours", async (t) => {
  const { write, collect } = await fixture(t);
  await write("pi/s.jsonl", [
    { type: "session", id: "dst" },
    piMessage("before", "2026-11-01T03:59:59Z"),
    piMessage("first-1am", "2026-11-01T05:30:00Z"),
    piMessage("second-1am", "2026-11-01T06:30:00Z"),
    piMessage("last", "2026-11-02T04:59:59Z"),
    piMessage("after", "2026-11-02T05:00:00Z"),
  ]);
  const result = await collect([["pi", "pi"]], { startDay: "2026-11-01", endDay: "2026-11-01", timeZone: "America/New_York" });
  assert.equal(day(result, "2026-11-01").requests, 3);
  assert.deepEqual(result.buckets.filter((entry) => entry.hour >= 0).map((entry) => [entry.hour, entry.requests]), [[1, 2], [23, 1]]);
});

test("discovers all configured roots including disabled Claude profiles and symlink aliases", async (t) => {
  const { home, write } = await fixture(t);
  await write("pi-root/sessions/project/s.jsonl", [piMessage("pi")]);
  await write("dsh-root/sessions/project/session/session.jsonl", [{ type: "assistant/message", time: Date.parse(time), data: { message: { id: "dsh" }, usage: { inputTokens: 1 } } }]);
  await write("grok-root/sessions/project/session/chat_history.jsonl", [{ type: "assistant", timestamp: time, model_id: "grok", usage: { input_tokens: 2, output_tokens: 1 } }]);
  await write(".claude/projects/project/a.jsonl", [{ type: "assistant", uuid: "a", timestamp: time, message: { id: "cc-a", model: "cc", usage: { input_tokens: 3 } } }]);
  await write("profile-disabled/projects/project/b.jsonl", [{ type: "assistant", uuid: "b", timestamp: time, message: { id: "cc-b", model: "cc", usage: { input_tokens: 4 } } }]);
  await write("web/claude-code.json", JSON.stringify({ profiles: [{ id: "disabled", configDir: "~/profile-disabled", enabled: false, provider: "custom-provider", env: { SECRET: "must not leak" } }] }));
  await symlink(join(home, "profile-disabled"), join(home, "profile-alias"));
  const result = await collectUsage({ homeDir: home, timeZone: "UTC", startDay: "2026-10-20", endDay: "2026-10-20", env: { PI_CODING_AGENT_DIR: "~/pi-root", DSH_HOME: "~/dsh-root", GROK_HOME: "~/grok-root", CODING_AGENT_WEB_DATA: join(home, "web/data.db"), CLAUDE_CONFIG_DIR: join(home, "profile-alias") } });
  assert.equal(day(result).requests, 5);
  assert.equal(day(result).sessions, 5);
  assert.ok(result.buckets.some((entry) => entry.provider === "custom-provider"));
  assert.equal(result.diagnostics.filter((source) => source.harness === "claude-code").length, 2);
  assert.ok(!JSON.stringify(result).includes("must not leak"));
});

test("bad lines and missing timestamps skip diagnostically without preventing snapshot replacement", async (t) => {
  const { write, collect } = await fixture(t);
  await write("pi/s.jsonl", JSON.stringify(piMessage("valid")) + "\n{broken\n" + JSON.stringify({ ...piMessage("undated"), timestamp: undefined }) + "\n{\"partial\":");
  const result = await collect([["pi", "pi"], ["grok", "absent"]]);
  assert.equal(result.complete, true);
  assert.equal(day(result).requests, 1);
  assert.equal(result.diagnostics[0].invalidRecords, 2);
  assert.equal(result.diagnostics[0].missingTimestamps, 1);
  assert.ok(result.diagnostics[1].limitations.includes("root_not_found"));
});

test("read/decompression and profile discovery failures mark snapshot unsafe", async (t) => {
  const { home, write, collect } = await fixture(t);
  await write("dsh/p/s/session.jsonl.zstd", Buffer.from("invalid compressed file"));
  const result = await collect([["dsh", "dsh"]]);
  assert.equal(result.complete, false);
  assert.equal(result.diagnostics[0].unreadableFiles, 1);
  await write(".coding-agent-web/claude-code.json", "{broken");
  const profiles = await collectUsage({ homeDir: home, env: {}, timeZone: "UTC" });
  assert.equal(profiles.complete, false);
  assert.ok(profiles.diagnostics.some((source) => source.limitations.includes("profile_discovery_failed")));
});

test("OpenAI-compatible cache read is a subset of prompt tokens; explicit zero cost stays known", async (t) => {
  const { write, collect } = await fixture(t);
  await write("pi/s.jsonl", [piMessage("a", time, { usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 }, total_tokens: 105, cost: 0 } })]);
  const result = await collect([["pi", "pi"]]);
  assert.equal(day(result).inputTokens, 60);
  assert.equal(day(result).cacheReadTokens, 40);
  assert.equal(day(result).totalTokens, 105);
  assert.equal(day(result).cost, 0);
  assert.equal(day(result).costKnownRequests, 1);
});

test("empty date range includes zero days, today is always represented, invalid options fail", async () => {
  const empty = await collectUsage({ discoverDefaults: false, timeZone: "UTC", startDay: "2026-10-20", endDay: "2026-10-21" });
  assert.deepEqual(empty.days.map((entry) => entry.day), ["2026-10-20", "2026-10-21"]);
  assert.equal(empty.days[0].cost, null);
  const today = await collectUsage({ discoverDefaults: false, timeZone: "UTC" });
  assert.equal(today.days[0].day, new Date().toISOString().slice(0, 10));
  await assert.rejects(collectUsage({ startDay: "2026-02-30" }));
  await assert.rejects(collectUsage({ startDay: "2026-10-21", endDay: "2026-10-20" }));
  await assert.rejects(collectUsage({ timeZone: "not-a-timezone" }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collectUsage({ signal: controller.signal }));
});

test("large JSONL streams many records without retaining transcript payloads", async (t) => {
  const { write, collect } = await fixture(t);
  const records = Array.from({ length: 4000 }, (_, index) => piMessage(`large-${index}`, time, { content: [{ type: "text", text: "x".repeat(1024) }] }));
  await write("pi/s.jsonl", records);
  const result = await collect([["pi", "pi"]]);
  assert.equal(day(result).requests, 4000);
  assert.equal(day(result).sessions, 1);
  assert.ok(JSON.stringify(result).length < 10000);
});

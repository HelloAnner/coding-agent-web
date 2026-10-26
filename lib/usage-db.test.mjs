import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const db = await createJiti(import.meta.url).import("./usage-db.ts");
const metrics = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, totalTokens: 15, cost: null, costKnownRequests: 0, costUnknownRequests: 1, requests: 1, messages: 2, toolCalls: 0, sessions: 1, errors: 0 };
const bucket = (day, model = null) => ({ ...metrics, day, hour: -1, harness: "pi", model, provider: null, sessionIds: ["opaque"] });
const snapshot = (day, amount = 15) => ({ schemaVersion: 1, collectedAt: "2026-10-26T12:00:00Z", timeZone: "UTC", startDay: null, endDay: null, complete: true, days: [{ ...metrics, day, totalTokens: amount }], buckets: [{ ...bucket(day), totalTokens: amount }], diagnostics: [] });

test("usage snapshots replace days, retain history, and roll back invalid snapshots", () => {
  const root = mkdtempSync(path.join(tmpdir(), "usage-db-"));
  const previous = process.env.CODING_AGENT_WEB_DATA;
  process.env.CODING_AGENT_WEB_DATA = path.join(root, "data.db");
  try {
    assert.equal(db.readUsageData().days.length, 0);
    db.saveUsageSnapshot(snapshot("2026-10-25"));
    db.saveUsageSnapshot(snapshot("2026-10-26"));
    db.saveUsageSnapshot(snapshot("2026-10-26", 42));
    let data = db.readUsageData();
    assert.equal(data.days.length, 2);
    assert.equal(data.buckets.length, 2);
    assert.equal(data.days[1].totalTokens, 42);
    assert.equal(data.days[1].cost, null);
    const invalid = snapshot("2026-10-26", 100);
    invalid.buckets.push(invalid.buckets[0]);
    assert.throws(() => db.saveUsageSnapshot(invalid));
    assert.equal(db.readUsageData().days[1].totalTokens, 42);
    assert.throws(() => db.saveUsageSnapshot({ ...invalid, complete: false }));
    assert.throws(() => db.saveUsageSnapshot({ ...snapshot("2026-10-26"), timeZone: "Asia/Shanghai" }));
    db.saveUsageError("Failed");
    data = db.readUsageData();
    assert.equal(data.sync.error, "Failed");
    assert.equal(data.days[1].totalTokens, 42);
    db.saveUsageSnapshot({ ...snapshot("2026-10-26", 0), buckets: [] });
    assert.equal(db.readUsageData().buckets.length, 1);
    assert.equal(db.readUsageData().sync.error, null);
    const nullable = snapshot("2026-10-27");
    nullable.buckets.push(bucket("2026-10-27", ""));
    db.saveUsageSnapshot(nullable);
    assert.equal(db.readUsageData().buckets.filter((row) => row.day === "2026-10-27").length, 2);
  } finally {
    db.closeUsageDb();
    if (previous === undefined) delete process.env.CODING_AGENT_WEB_DATA;
    else process.env.CODING_AGENT_WEB_DATA = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

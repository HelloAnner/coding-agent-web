import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { toolbarQuotaValues } from "./toolbar-quota.ts";

const report = (providerId, buckets = [], metrics = []) => ({ providerId, buckets, metrics, capturedAt: 0, providerName: providerId });

test("quota values show remaining rather than used percentages and retain reset dates", () => {
  const values = toolbarQuotaValues(report("kimi-coding", [{ id: "weekly", label: "Weekly", unit: "count", limit: 1000, used: 750, resetsAt: 123 }]));
  assert.deepEqual(values, [{ label: "Weekly", value: "25%", empty: false, resetsAt: 123 }]);
});

test("zero means empty while a small positive balance never reads zero", () => {
  const values = toolbarQuotaValues(report("opencode-go", [
    { id: "zero", label: "Zero", remaining: 0, limit: 100 },
    { id: "small", label: "Small", remaining: 0.5, limit: 100 },
    { id: "invalid", label: "Invalid", remaining: 10, limit: 0 },
  ]));
  assert.equal(values[0].value, "0%");
  assert.equal(values[0].empty, true);
  assert.equal(values[1].value, "<1%");
  assert.equal(values[1].empty, false);
  assert.equal(values.length, 2);
});

test("DeepSeek displays actual currency balances without inventing a percentage", () => {
  assert.deepEqual(toolbarQuotaValues(report("deepseek", [], [
    { id: "cny-total", value: 12.34, currency: "CNY" },
    { id: "cny-granted", value: 2, currency: "CNY" },
  ])), [{ label: "CNY", value: "¥12.34", empty: false }]);
});

test("Codex excludes quota for unrelated products", () => {
  const values = toolbarQuotaValues(report("openai-codex", [
    { id: "codex:primary", label: "5h", limit: 100, remaining: 40 },
    { id: "spark:primary", label: "5h", limit: 100, remaining: 5 },
  ]));
  assert.equal(values.length, 1);
  assert.equal(values[0].value, "40%");
});

test("toolbar removes unwanted controls and keeps title generation followed by quota", () => {
  const source = readFileSync(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  const toolbar = source.slice(source.indexOf("const renderChatToolbarActions"), source.indexOf("const renderSessionStatsButton"));
  assert.doesNotMatch(toolbar, /history\.full|system\.label|tools\.label/);
  assert.match(toolbar, /title\.generate/);
  assert.match(toolbar, /<ToolbarQuota \/>/);
  const component = readFileSync(new URL("../components/ToolbarQuota.tsx", import.meta.url), "utf8");
  assert.match(component, /5 \* 60 \* 1000/);
  assert.doesNotMatch(component, /localStorage|indexedDB/);
});

import assert from "node:assert/strict";
import path from "node:path";
import { readRegularFileText } from "../../../lib/regular-file";
import type { HealthData } from "./model";

export const HEALTH_DIRECTORY = path.join(process.cwd(), "data", "dashboard", "健康", "父亲");
export class HealthDataError extends Error {}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "需要对象");
  return value as Record<string, unknown>;
}
function strings(value: unknown, keys: string[]) {
  const row = record(value);
  assert.ok(keys.every((key) => typeof row[key] === "string"), `${keys.join("、")} 需要文本`);
}
function textList(value: unknown) {
  assert.ok(Array.isArray(value) && value.every((item) => typeof item === "string"), "需要文本数组");
}
function date(value: unknown) {
  assert.ok(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, "日期需为真实 YYYY-MM-DD");
}
function uniqueIds(rows: { id: string }[]) {
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, "ID 不能重复");
}

/** Fail the entire read rather than silently omit malformed medical data. */
export function validateHealthData(value: unknown): asserts value is HealthData {
  record(value);
  const data = value as HealthData;
  assert.equal(data.version, 1, "version 需为 1");
  assert.ok(typeof data.updatedAt === "string" && Number.isFinite(Date.parse(data.updatedAt)), "updatedAt 无效");
  for (const key of ["metrics", "reports", "events", "medications", "alerts", "findings", "documents", "attachments"] as const) {
    assert.ok(Array.isArray(data[key]), `${key} 需要数组`);
  }
  strings(data.profile, ["label", "name", "sex", "summary", "sourceId"]);
  assert.ok(Number.isInteger(data.profile.ageAtLastReport) && data.profile.ageAtLastReport > 0);
  for (const items of [data.profile.conditions, data.profile.context, data.profile.missing, data.emergency]) textList(items);
  for (const metric of data.metrics) {
    strings(metric, ["id", "label", "shortLabel", "unit", "group", "note"]);
    assert.ok(/^[a-z][a-z0-9_]*$/.test(metric.id), "指标 ID 无效");
    assert.ok(Number.isInteger(metric.decimals) && metric.decimals >= 0 && metric.decimals <= 6);
    assert.equal(typeof metric.core, "boolean");
  }
  for (const document of data.documents) {
    strings(document, ["id", "title", "category", "sourcePath", "content", "attachmentId", "note"]);
    if (document.date !== null) date(document.date);
  }
  for (const attachment of data.attachments) {
    strings(attachment, ["id", "title", "kind", "status", "mime", "sourcePath"]);
    assert.ok(/^[a-zA-Z0-9_-]+$/.test(attachment.id));
    assert.ok(["report", "medication", "transcript", "document"].includes(attachment.kind));
    assert.ok(["available", "missing"].includes(attachment.status));
    assert.ok(Number.isSafeInteger(attachment.sizeBytes) && attachment.sizeBytes >= 0);
    if (attachment.date !== null) date(attachment.date);
    if (attachment.status === "available") {
      assert.ok(typeof attachment.path === "string" && attachment.path.startsWith("attachments/")
        && !attachment.path.includes("\\") && !attachment.path.split("/").some((part) => !part || part === "." || part === ".."), "附件路径需在 attachments/ 内");
      assert.ok(typeof attachment.sha256 === "string" && /^[a-f0-9]{64}$/.test(attachment.sha256));
    } else {
      assert.equal(attachment.path, null);
      assert.equal(attachment.sha256, null);
    }
  }
  for (const rows of [data.metrics, data.documents, data.attachments, data.reports]) uniqueIds(rows);
  const metricIds = new Set(data.metrics.map((row) => row.id));
  const documentIds = new Set(data.documents.map((row) => row.id));
  const attachmentIds = new Set(data.attachments.map((row) => row.id));
  for (const report of data.reports) {
    strings(report, ["id", "hospital", "sourceId", "note"]);
    date(report.date);
    textList(report.attachmentIds);
    assert.ok(report.attachmentIds.every((id) => attachmentIds.has(id)), "报告附件引用不存在");
    assert.ok(Array.isArray(report.results));
    assert.equal(new Set(report.results.map((row) => row.metricId)).size, report.results.length, "同次报告指标不能重复");
    for (const result of report.results) {
      strings(result, ["metricId", "unit", "reference", "flag", "note"]);
      assert.ok(metricIds.has(result.metricId), "指标引用不存在");
      assert.ok(typeof result.value === "string" || (typeof result.value === "number" && Number.isFinite(result.value)), "检测结果无效");
      assert.ok(["high", "low", "normal", "unclassified"].includes(result.flag));
      for (const bound of [result.min, result.max]) assert.ok(bound === null || (typeof bound === "number" && Number.isFinite(bound)));
      assert.ok(result.min === null || result.max === null || result.min <= result.max, "参考区间上下限错误");
    }
  }
  for (const event of data.events) {
    strings(event, ["date", "title", "detail", "sourceId", "kind"]);
    assert.ok(["history", "report", "medication", "plan"].includes(event.kind));
  }
  for (const medication of data.medications) {
    strings(medication, ["name", "status", "asOf", "dose", "purpose", "note", "sourceId"]);
    date(medication.asOf);
    assert.ok(["confirmed", "unconfirmed"].includes(medication.status));
  }
  for (const alert of data.alerts) {
    strings(alert, ["title", "detail", "tone", "sourceId"]);
    assert.ok(["rust", "amber", "teal"].includes(alert.tone));
  }
  for (const finding of data.findings) {
    strings(finding, ["title", "detail", "sourceId"]);
    date(finding.date);
  }
  strings(data.followUp, ["status", "sourceId"]);
  date(data.followUp.date);
  textList(data.followUp.items);
  strings(data.nutrition, ["sourceId"]);
  textList(data.nutrition.summary);
  strings(data.provenance, ["root"]);
  textList(data.provenance.notes);
  for (const item of [data.profile, data.followUp, data.nutrition, ...data.reports, ...data.events, ...data.medications, ...data.alerts, ...data.findings]) {
    assert.ok(documentIds.has(item.sourceId), "原文引用不存在");
  }
  assert.ok(data.documents.every((document) => attachmentIds.has(document.attachmentId)), "笔记附件引用不存在");
}

export async function readHealthData(directory = HEALTH_DIRECTORY): Promise<HealthData | null> {
  const text = readRegularFileText(path.join(directory, "health.json"), 8 * 1024 * 1024);
  if (text === undefined) return null;
  try {
    const data: unknown = JSON.parse(text);
    validateHealthData(data);
    return data;
  } catch (error) {
    throw new HealthDataError(`health.json：${error instanceof SyntaxError ? "JSON 格式错误" : error instanceof Error ? error.message : "数据格式错误"}`);
  }
}

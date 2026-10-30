import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

const scratch = await mkdtemp(path.join(tmpdir(), "father-health-check-"));
after(() => rm(scratch, { recursive: true, force: true }));
const stub = path.join(scratch, "styles.mjs");
await writeFile(stub, "export default new Proxy({}, { get: (_target, key) => key });");
const jiti = createJiti(import.meta.url, { tryNative: false, jsx: { runtime: "automatic" }, alias: {
  "./father-health.module.css": stub,
} });
const { metricSeries, metricChange, formatValue } = await jiti.import("../model.ts");
const { readHealthData, validateHealthData } = await jiti.import("../data.ts");
const { getHealth, getHealthAttachment } = await jiti.import("../api.ts");

function fixture() {
  const metric = (id, label) => ({ id, label, shortLabel: label, unit: "unit", decimals: 2, group: "生化", core: true, note: "来自报告；不作治疗建议" });
  const result = (metricId, value) => ({ metricId, value, unit: "unit", min: null, max: null, reference: "报告未列", flag: "unclassified", note: "" });
  const report = (id, date, value, extra = []) => ({ id, date, hospital: "测试医院", sourceId: "source", note: "测试记录", attachmentIds: ["note"], results: [result("creatinine", value), ...extra] });
  return {
    version: 1, updatedAt: "2026-06-30T00:00:00Z",
    profile: { label: "测试档案", name: "测试", sex: "男", ageAtLastReport: 50, summary: "虚构测试档案", conditions: ["测试条件"], context: ["仅作软件测试"], missing: ["无体重实测值"], sourceId: "source" },
    metrics: [metric("creatinine", "肌酐"), metric("co2", "CO₂"), { ...metric("urine_glucose", "尿糖"), core: false }],
    reports: [report("later", "2026-06-30", 80, [result("urine_glucose", "1+")]), report("earlier", "2026-05-01", 100, [result("co2", 18), result("urine_glucose", "4+")])],
    events: [{ date: "2018-09", title: "口述历史", detail: "只有月份，不能当正式测点", sourceId: "source", kind: "history" }],
    medications: [{ name: "测试药物", status: "confirmed", asOf: "2026-05-01", dose: "用量待核实", purpose: "测试功效说明", note: "非当前处方", sourceId: "source" }, { name: "既往药物", status: "unconfirmed", asOf: "2026-04-01", dose: "待确认", purpose: "既往方案", note: "不推断停药", sourceId: "source" }],
    followUp: { date: "2026-09-01", status: "计划，无结果", sourceId: "source", items: ["复查"] },
    alerts: [{ title: "测试关注项", detail: "数据尚待核实", tone: "amber", sourceId: "source" }],
    emergency: ["症状异常及时就医"], nutrition: { sourceId: "source", summary: ["营养目标需个体化"] }, findings: [],
    documents: [{ id: "source", title: "测试原文", category: "病历", date: null, sourcePath: "/private/test-note.txt", content: "这是虚构测试资料", attachmentId: "note", note: "原文非当前医嘱" }],
    attachments: [{ id: "note", title: "只应在详情展示的附件", kind: "document", date: null, path: "attachments/note.txt", status: "available", mime: "text/plain", sourcePath: "/private/test-note.txt", sizeBytes: 5, sha256: "0".repeat(64) }],
    provenance: { root: "test", notes: ["无真实医疗数据"] },
  };
}

async function directory(run) {
  const root = await mkdtemp(path.join(scratch, "case-"));
  await mkdir(path.join(root, "attachments"));
  await writeFile(path.join(root, "attachments/note.txt"), "hello");
  await run(root);
}

test("only official numeric report results form a sorted, range-filtered trend; gaps are not zero or interpolated", () => {
  const data = fixture();
  validateHealthData(data);
  const points = metricSeries(data, "creatinine");
  assert.deepEqual(points.map((point) => [point.date, point.value]), [["2026-05-01", 100], ["2026-06-30", 80]]);
  assert.equal(metricChange(points), -20);
  assert.equal(metricSeries(data, "co2").length, 1);
  assert.equal(metricChange(metricSeries(data, "co2")), null);
  assert.deepEqual(metricSeries(data, "co2", "2026-06-01", "2026-06-30"), []);
  assert.deepEqual(metricSeries(data, "urine_glucose"), []);
  assert.equal(metricSeries(data, "creatinine", "2026-06-30", "2026-06-30")[0].value, 80);
  assert.deepEqual(metricSeries(data, "creatinine", "2026-07-01", "2026-06-30"), []);
  assert.equal(formatValue(undefined), "—");
  assert.equal(formatValue(0), "0");
  assert.equal(formatValue("1+"), "1+");
});

test("bad dates, missing fields, duplicate IDs, invalid references and unsafe file paths fail the whole read", async () => directory(async (root) => {
  for (const mutate of [
    (data) => { data.version = 2; },
    (data) => { data.reports[0].date = "2026-02-30"; },
    (data) => { data.reports[0].results[0].value = null; },
    (data) => { data.reports[0].results.push(data.reports[0].results[0]); },
    (data) => { data.metrics.push(data.metrics[0]); },
    (data) => { data.reports[0].sourceId = "unknown"; },
    (data) => { data.reports[0].results[0].metricId = "unknown"; },
    (data) => { data.documents[0].attachmentId = "unknown"; },
    (data) => { data.medications[0].status = "current-prescription"; },
    (data) => { data.followUp.items = null; },
    (data) => { data.attachments[0].path = "attachments/../../secret.txt"; },
    (data) => { data.attachments[0].path = "/etc/passwd"; },
    (data) => { data.attachments[0].path = "attachments\\note.txt"; },
    (data) => { data.attachments[0].status = "missing"; },
  ]) {
    const data = fixture();
    mutate(data);
    await writeFile(path.join(root, "health.json"), JSON.stringify(data));
    await assert.rejects(() => readHealthData(root), /health\.json/);
    assert.equal((await getHealth(root)).status, 500);
  }
  await writeFile(path.join(root, "health.json"), "{");
  assert.match((await (await getHealth(root)).json()).error, /JSON 格式错误/);
}));

test("missing local data is explicit; refreshed JSON is reread without a build and medical responses are private/no-store", async () => directory(async (root) => {
  assert.equal(await readHealthData(root), null);
  assert.equal((await getHealth(root)).status, 404);
  const data = fixture();
  await writeFile(path.join(root, "health.json"), JSON.stringify(data));
  const response = await getHealth(root);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  data.reports[0].results[0].value = 70;
  await writeFile(path.join(root, "health.json"), JSON.stringify(data));
  assert.equal(metricSeries(await readHealthData(root), "creatinine").at(-1).value, 70);
}));

test("attachments are manifest-only, confined even through symlinks, no-store, nosniff, and absent files stay missing", async () => directory(async (root) => {
  const data = fixture();
  const save = () => writeFile(path.join(root, "health.json"), JSON.stringify(data));
  await save();
  const response = await getHealthAttachment("note", root);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "hello");
  assert.equal(response.headers.get("Content-Type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(response.headers.get("Cache-Control"), /private, no-store/);
  for (const id of ["../health.json", "%2e%2e", "unknown", "note.txt", ""]) assert.equal((await getHealthAttachment(id, root)).status, 404);
  const outside = path.join(scratch, "outside.txt");
  await writeFile(outside, "must not be served");
  await symlink(outside, path.join(root, "attachments/link.txt"));
  data.attachments[0].path = "attachments/link.txt";
  await save();
  assert.equal((await getHealthAttachment("note", root)).status, 403);
  data.attachments[0].path = "attachments/unavailable.txt";
  await save();
  assert.equal((await getHealthAttachment("note", root)).status, 404);
  data.attachments[0].path = "attachments/payload.html";
  await writeFile(path.join(root, data.attachments[0].path), "<script>bad()</script>");
  await save();
  assert.equal((await getHealthAttachment("note", root)).status, 415);
  data.attachments[0] = { ...data.attachments[0], status: "missing", path: null, sha256: null, sizeBytes: 0 };
  await save();
  assert.equal((await getHealthAttachment("note", root)).status, 404);
}));

test("vertical main view includes full medication details but no attachments or patient source paths; CSS stays isolated", async () => {
  const React = await jiti.import("react");
  const { renderToStaticMarkup } = await jiti.import("react-dom/server");
  const { FatherHealthView, FatherHealthBoard } = await jiti.import("../ui/FatherHealthBoard.tsx");
  const html = renderToStaticMarkup(React.createElement(FatherHealthView, { data: fixture(), error: "", pending: false, onRefresh() {} }));
  for (const text of ["Key Metrics", "Trends", "Medications", "Health Overview", "Lab Results", "To Review", "Follow-up Plan", "Medical Timeline", "Missing Records", "Nutrition", "测试药物", "测试功效说明", "当时确认在服", "服用待核实", "非当前处方", "健康记录开始日期", "健康记录结束日期", "选择健康趋势指标", "筛选化验指标分组", "查看原始测点"]) assert.ok(html.includes(text), text);
  assert.match(html, /<h1[^>]*>Father(?:&#x27;|')s Health<\/h1>/);
  for (const heading of html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/g)) assert.doesNotMatch(heading[1], /\p{Script=Han}/u, "board titles must be English");
  assert.ok(!html.includes("只应在详情展示的附件") && !html.includes("/private/test-note.txt"));
  assert.ok(!html.includes("<img") && !html.includes("<dialog"));
  assert.ok(!html.includes("治疗效果") && !html.includes("健康评分"));
  assert.equal((html.match(/来自报告；不作治疗建议/g) ?? []).length, 1, "主页面只保留当前趋势的解释，不在每张指标卡重复长说明");
  assert.match(renderToStaticMarkup(React.createElement(FatherHealthBoard, { active: false })), /hidden=""/);
  const css = await readFile(new URL("../ui/father-health.module.css", import.meta.url), "utf8");
  assert.ok(!css.includes(".dashboard-") && !css.includes(":global") && !css.includes("var(--bg)") && !css.includes("var(--text)"));
  assert.match(css, /\.sections \{ display: flex; flex-direction: column;/);
  for (const name of ["timeline", "comparisonWrap", "medicationList"]) {
    const rule = css.match(new RegExp(`\\.${name} \\{([^}]+)\\}`))[1];
    assert.ok(!rule.includes("max-height") && !rule.includes("overflow-y"), `${name} must expand vertically`);
  }
  assert.ok(!css.includes(".side ") && !css.includes(".overviewGrid"));
});

test("later reports, new core metrics, long medicine notes and additional history render without display caps", async () => {
  const data = fixture();
  data.metrics.push({ ...data.metrics[0], id: "future_marker", label: "后续新增指标", shortLabel: "后续新增指标" });
  for (let index = 0; index < 40; index += 1) {
    const date = new Date(Date.UTC(2027, 0, index + 1)).toISOString().slice(0, 10);
    data.reports.unshift({ ...data.reports[0], id: `future-${index}`, date, results: [
      { ...data.reports[0].results[0], value: 90 + index },
      { ...data.reports[0].results[0], metricId: "future_marker", value: index },
    ] });
    data.events.push({ date, title: `后续病史-${index}`, detail: "完整保留后续记录", sourceId: "source", kind: "report" });
  }
  const longNote = "这是一段需要完整展示而不是省略的用药说明。".repeat(8);
  data.medications.push({ ...data.medications[0], name: "后续新增药物", note: longNote });
  validateHealthData(data);
  const React = await jiti.import("react");
  const { renderToStaticMarkup } = await jiti.import("react-dom/server");
  const { FatherHealthView } = await jiti.import("../ui/FatherHealthBoard.tsx");
  const html = renderToStaticMarkup(React.createElement(FatherHealthView, { data, error: "", pending: false, onRefresh() {} }));
  for (const text of ["后续新增指标", "后续新增药物", longNote, "后续病史-39", "42 次检查", "2027-02-09"]) assert.ok(html.includes(text), text);
  assert.equal(metricSeries(data, "future_marker").length, 40);
  const header = html.slice(html.indexOf('class="comparison"')).split("</thead>")[0];
  assert.ok(header.indexOf("2026-05-01") < header.indexOf("2027-02-09"), "reports sort by real date, not insertion order");
});

test("right-side details retain qualitative results and show original attachments only after selection", async () => {
  const React = await jiti.import("react");
  const { renderToStaticMarkup } = await jiti.import("react-dom/server");
  const { HealthDetails } = await jiti.import("../ui/HealthDetails.tsx");
  const html = renderToStaticMarkup(React.createElement(HealthDetails, { data: fixture(), selection: { title: "尿糖详情", metricId: "urine_glucose", sourceId: "source" }, onClose() {} }));
  assert.ok(html.includes("1+") && html.includes("4+"));
  assert.ok(html.includes("<dialog") && html.includes("关闭健康详情"));
  assert.ok(html.includes("只应在详情展示的附件") && html.includes("/api/dashboard/father-health/attachments/note"));
  assert.ok(!html.includes("仅有0个实测值"));
  assert.ok(html.includes("Metric Details") && html.includes("Original Record") && html.includes("Attachments"));
  for (const heading of html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/g)) assert.doesNotMatch(heading[1], /\p{Script=Han}/u, "detail section titles must be English");
});

// Connects to an existing local development server; never starts/restarts the user's service.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.HEALTH_E2E_URL ?? "http://127.0.0.1:30141";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1024 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const artifacts = "test-results/father-health";
await mkdir(artifacts, { recursive: true });

try {
  const response = await page.request.get(`${base}/api/dashboard/father-health`);
  assert.equal(response.status(), 200, "需要已登录的本地开发服务和私有 health.json");
  assert.match(response.headers()["cache-control"], /private, no-store/);
  const data = await response.json();
  const dates = data.reports.map((row) => row.date).sort();
  const latest = dates.at(-1);
  await page.goto(`${base}/dashboard?board=father-health`);
  const board = page.getByRole("region", { name: "Father's Health", exact: true });
  await board.getByRole("heading", { name: "Medications", exact: true }).waitFor({ timeout: 120_000 });
  assert.equal(await page.getByRole("button", { name: "Father's Health JSON", exact: true }).getAttribute("aria-current"), "page");
  assert.equal(await page.getByRole("button", { name: "Health", exact: true }).getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator(".dashboard-board-title").innerText(), "Father's Health");
  assert.equal(await board.getByRole("heading", { level: 1 }).innerText(), "Father's Health");
  for (const title of await board.getByRole("heading").allTextContents()) assert.doesNotMatch(title, /\p{Script=Han}/u);
  assert.equal(await board.locator("img, dialog").count(), 0, "主看板不得展示附件或预先打开详情");
  assert.equal(await board.evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(246, 245, 241)");
  for (const medication of data.medications) {
    const text = await board.innerText();
    assert.ok(text.includes(medication.name) && text.includes(medication.note), "用药说明必须完整展示");
  }
  let previousY = -Infinity;
  for (const name of ["Key Metrics", "Trends", "Medications", "Lab Results", "Medical Timeline"]) {
    const box = await board.getByRole("heading", { name, exact: true }).boundingBox();
    assert.ok(box.y > previousY, `${name} 应按单列纵向排列`);
    previousY = box.y;
  }
  const comparison = board.getByRole("region", { name: "历次化验对照，可横向滚动", exact: true });
  assert.ok(await comparison.evaluate((element) => element.scrollHeight <= element.clientHeight + 1), "化验对照不能被固定高度截断");
  await board.getByLabel("筛选化验指标分组").selectOption("全部指标");
  assert.equal(await comparison.locator("tbody tr").count(), data.metrics.length, "所有指标都应可完整展开");
  assert.ok(await comparison.evaluate((element) => element.scrollHeight <= element.clientHeight + 1));
  await board.getByLabel("筛选化验指标分组").selectOption("重点指标");
  const history = board.getByRole("heading", { name: "Medical Timeline", exact: true }).locator("..").locator("..").locator(":scope > div");
  assert.equal(await history.getByRole("button").count(), data.events.length);
  assert.ok(await history.evaluate((element) => element.scrollHeight <= element.clientHeight + 1), "病史应完整展开");
  await page.locator(".dashboard-content").evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: `${artifacts}/desktop.png` });

  const medicine = data.medications.find((row) => row.status === "confirmed");
  const medicineButton = board.getByRole("button", { name: `查看${medicine.name}用药详情`, exact: true });
  await medicineButton.click();
  let dialog = page.getByRole("dialog");
  await dialog.waitFor();
  for (const title of await dialog.getByRole("heading").allTextContents()) assert.doesNotMatch(title, /\p{Script=Han}/u);
  assert.ok((await dialog.innerText()).includes(medicine.purpose));
  assert.ok((await dialog.innerText()).includes("非当前处方") || (await dialog.innerText()).includes("不是当前处方"));
  const box = await dialog.boundingBox();
  assert.ok(Math.abs(box.x + box.width - 1280) < 2, "详情必须贴右侧打开");
  const attachment = dialog.locator('a[href*="/attachments/"]').first();
  await attachment.scrollIntoViewIfNeeded();
  const original = await page.request.get(new URL(await attachment.getAttribute("href"), base).href);
  assert.equal(original.status(), 200);
  assert.match(original.headers()["cache-control"], /private, no-store/);
  await dialog.screenshot({ path: `${artifacts}/detail.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.ok(await medicineButton.evaluate((element) => document.activeElement === element), "关闭后焦点应返回触发按钮");

  const co2 = data.metrics.find((row) => row.id === "co2");
  if (co2) {
    await board.getByLabel("选择健康趋势指标").selectOption("co2");
    await board.getByLabel("健康记录开始日期").fill(latest);
    await board.getByLabel("健康记录结束日期").fill(latest);
    const exists = data.reports.some((report) => report.date === latest && report.results.some((row) => row.metricId === "co2"));
    if (!exists) assert.ok((await board.innerText()).includes("此范围无实测记录"));
  }
  await board.getByLabel("健康记录开始日期").fill("2100-01-01");
  assert.ok((await board.getByRole("alert").innerText()).includes("开始日期不能晚于结束日期"));
  await board.getByRole("button", { name: "全部", exact: true }).click();
  assert.equal(await board.getByLabel("健康记录开始日期").inputValue(), dates[0]);
  await board.getByRole("button", { name: "资料索引 ↗", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("搜索健康资料").fill("检查报告");
  assert.ok((await dialog.innerText()).includes("检查报告"));
  const document = data.documents.find((row) => row.id === data.reports.find((row) => row.date === latest).sourceId);
  await dialog.getByRole("button").filter({ hasText: document.title }).click();
  const missing = data.attachments.filter((row) => row.status === "missing");
  if (missing.length) assert.ok((await dialog.innerText()).includes("原文件未找到"));
  await dialog.getByRole("button", { name: "关闭健康详情" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector(".dashboard-sidebar").getBoundingClientRect().right <= 1);
  assert.ok(await board.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), "移动端不能出现整个看板横向溢出");
  await page.screenshot({ path: `${artifacts}/mobile.png` });
  await board.getByRole("button", { name: "查看肌酐详情", exact: true }).click();
  assert.ok((await page.getByRole("dialog").boundingBox()).width <= 390);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log("Health board: English titles, vertical sections, medicines, expanding data, date filtering, private details and mobile layout passed.");
} finally {
  await browser.close();
}

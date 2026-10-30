import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" } });
const { readFinanceData } = await jiti.import("../data.ts");
const { getFinance } = await jiti.import("../api.ts");
const { financeTotals, financeTrend, expenseCategories } = await jiti.import("../model.ts");
const transaction = (overrides = {}) => ({
  id: "one", date: "2026-10-01", type: "income", amountCents: 10001,
  description: "项目回款", counterparty: "示例客户", category: "项目收入", account: "账户 A", ...overrides,
});
const document = (transactions, extra = {}) => JSON.stringify({ currency: "CNY", transactions, ...extra });

async function withDirectory(run) {
  const root = await mkdtemp(path.join(tmpdir(), "income-expenses-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("multiple JSON files merge without duplicates; totals stay in integer cents and files reload live", () => withDirectory(async (root) => {
  await writeFile(path.join(root, "october.json"), document([transaction(), transaction({ id: "two", date: "2026-10-02", type: "expense", amountCents: 1001, category: "软件服务" })]));
  await writeFile(path.join(root, "september.json"), document([transaction({ id: "old", date: "2026-09-01", amountCents: 9 })], { sample: true }));
  await writeFile(path.join(root, "ignored.txt"), "not json");
  await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, "nested", "ignored.json"), "not json");
  await symlink(path.join(root, "october.json"), path.join(root, "link.json"));
  const snapshot = await readFinanceData(root);
  assert.deepEqual(snapshot.files, ["october.json", "september.json"]);
  assert.deepEqual(snapshot.transactions.map((row) => row.id), ["two", "one", "old"]);
  assert.equal(snapshot.containsSampleData, true);
  const october = snapshot.transactions.filter((row) => row.date.startsWith("2026-10") && row.account === "账户 A");
  assert.deepEqual(financeTotals(october), { income: 10001, expense: 1001, balance: 9000, savingsRate: 9000 / 10001 });
  assert.deepEqual(expenseCategories(october), [{ name: "软件服务", amount: 1001 }]);
  await writeFile(path.join(root, "october.json"), document([transaction({ amountCents: 20001 })]));
  assert.equal(financeTotals((await readFinanceData(root)).transactions).income, 20010);
}));

test("bad JSON, currencies, dates, fields, fractional amounts, duplicates and overflow fail the entire read", () => withDirectory(async (root) => {
  const filename = path.join(root, "bad.json");
  for (const value of [
    "{", "null", document([], { currency: "USD" }), document([], { sample: "false" }),
    ...[
      { date: "2026-02-29" }, { date: "2026-13-01" }, { date: "2026-02-30" }, { date: "2026-1-01" },
      { amountCents: 0 }, { amountCents: -1 }, { amountCents: 1.1 }, { amountCents: "100" },
      { amountCents: Number.MAX_SAFE_INTEGER + 1 }, { type: "transfer" }, { account: " " }, { id: "" }, { counterparty: null },
    ].map((overrides) => document([transaction(overrides)])),
    document([transaction(), transaction()]),
    document([transaction({ amountCents: Number.MAX_SAFE_INTEGER }), transaction({ id: "two" })]),
  ]) {
    await writeFile(filename, value);
    await assert.rejects(() => readFinanceData(root), /bad\.json/);
  }
  await writeFile(filename, document([transaction()]));
  await writeFile(path.join(root, "duplicate.json"), document([transaction()]));
  await assert.rejects(() => readFinanceData(root), /重复/);
}));

test("trends include leap days and missing months; no income never invents a savings rate", () => {
  const rows = [transaction({ date: "2024-02-29", amountCents: 101 }), transaction({ id: "expense", date: "2024-02-29", type: "expense", amountCents: 202 })];
  const points = financeTrend(rows, "2024-02");
  assert.equal(points.length, 29);
  assert.deepEqual(points[0], { label: "2024-02-01", income: 0, expense: 0 });
  assert.deepEqual(points[28], { label: "2024-02-29", income: 101, expense: 202 });
  assert.equal(financeTotals(rows).savingsRate, -1);
  assert.equal(financeTotals([rows[1]]).savingsRate, null);
  assert.deepEqual(financeTrend([transaction({ date: "2025-12-01" }), transaction({ date: "2026-02-01" })], "").map((point) => point.label), ["2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(financeTrend([], ""), []);
  assert.deepEqual(financeTotals([]), { income: 0, expense: 0, balance: 0, savingsRate: null });
});

test("API is read-only/no-store, empty directories stay empty and malformed files produce an explicit error", () => withDirectory(async (root) => {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const empty = await getFinance();
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await empty.json(), { transactions: [], files: [], containsSampleData: false });
    const directory = path.join(root, "data", "dashboard", "财务");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "broken.json"), "{");
    const failed = await getFinance();
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: "broken.json：JSON 格式错误" });
    await writeFile(path.join(directory, "broken.json"), document([transaction()]));
    assert.equal((await (await getFinance()).json()).transactions.length, 1);
  } finally { process.chdir(cwd); }
}));

test("the independent view has named controls, sortable headers, an honest initial state and scoped CSS", async () => {
  const React = await jiti.import("react");
  const { renderToStaticMarkup } = await jiti.import("react-dom/server");
  const filename = new URL("../ui/IncomeExpensesBoard.tsx", import.meta.url);
  const source = await readFile(filename, "utf8");
  const { IncomeExpensesBoard } = jiti.evalModule(source.replace('import styles from "./income-expenses.module.css";', 'const styles = new Proxy({}, { get: (_target, key) => key });'), { filename: fileURLToPath(filename) });
  const html = renderToStaticMarkup(React.createElement(IncomeExpensesBoard, { active: true }));
  for (const label of ["统计月份", "统计账户", "搜索收支明细", "明细收支类型", "可横向滚动", "刷新数据"]) assert.ok(html.includes(label), label);
  assert.equal((html.match(/aria-sort=/g) ?? []).length, 2);
  assert.match(html, /正在读取交易记录/);
  assert.ok(!html.includes("示例客户"));
  assert.match(renderToStaticMarkup(React.createElement(IncomeExpensesBoard, { active: false })), /hidden=""/);
  assert.ok(!source.includes("fine-tasks"));
  const css = await readFile(new URL("../ui/income-expenses.module.css", import.meta.url), "utf8");
  assert.ok(!css.includes(".dashboard-") && !css.includes("var(--bg)") && !css.includes("var(--text)"));
});

test("the three shipped files are explicit fictional examples, independent of private local JSON", async () => {
  const transactions = [];
  for (const month of ["08", "09", "10"]) {
    const file = new URL(`../../../../data/dashboard/财务/示例-2026-${month}.json`, import.meta.url);
    const data = JSON.parse(await readFile(file, "utf8"));
    assert.equal(data.sample, true, file.pathname);
    assert.equal(data.currency, "CNY");
    transactions.push(...data.transactions);
  }
  assert.equal(transactions.length, 44);
  assert.equal(new Set(transactions.map((row) => row.id)).size, 44);
  const october = transactions.filter((row) => row.date.startsWith("2026-10"));
  assert.deepEqual(financeTotals(october), { income: 3146000, expense: 887300, balance: 2258700, savingsRate: 2258700 / 3146000 });
});

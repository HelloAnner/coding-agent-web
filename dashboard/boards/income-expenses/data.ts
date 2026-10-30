import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { FinanceSnapshot, FinanceTransaction } from "./model";

export class FinanceDataError extends Error {}

function validTransaction(value: unknown): value is FinanceTransaction {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["id", "description", "counterparty", "category", "account"].every((key) =>
    typeof row[key] === "string" && (row[key] as string).trim().length > 0,
  ) && typeof row.date === "string" && /^(20\d{2})-\d{2}-\d{2}$/.test(row.date)
    && Number.isFinite(Date.parse(`${row.date}T00:00:00Z`))
    && new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) === row.date
    && (row.type === "income" || row.type === "expense")
    && Number.isSafeInteger(row.amountCents) && (row.amountCents as number) > 0;
}

export async function readFinanceData(directory = path.join(process.cwd(), "data", "dashboard", "财务")): Promise<FinanceSnapshot> {
  const snapshot: FinanceSnapshot = { transactions: [], files: [], containsSampleData: false };
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name).sort();
  const ids = new Set<string>();
  let totalCents = 0;
  for (const filename of files) {
    let document;
    try {
      document = JSON.parse(await readFile(path.join(directory, filename), "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new FinanceDataError(`${filename}：JSON 格式错误`);
      throw error;
    }
    if (!document || document.currency !== "CNY" || !Array.isArray(document.transactions)
      || (document.sample !== undefined && typeof document.sample !== "boolean")) {
      throw new FinanceDataError(`${filename}：需要 currency: "CNY" 和 transactions 数组；sample 只能为布尔值`);
    }
    for (const [index, row] of document.transactions.entries()) {
      if (!validTransaction(row)) throw new FinanceDataError(`${filename}：第 ${index + 1} 笔记录格式错误（日期、正整数分金额及所有文本字段必填）`);
      if (ids.has(row.id)) throw new FinanceDataError(`${filename}：交易 ID「${row.id}」重复，请勿重复导入`);
      totalCents += row.amountCents;
      if (!Number.isSafeInteger(totalCents)) throw new FinanceDataError(`${filename}：金额合计超出安全整数范围`);
      ids.add(row.id);
      snapshot.transactions.push(row);
    }
    snapshot.files.push(filename);
    snapshot.containsSampleData ||= document.sample === true;
  }
  snapshot.transactions.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id, "zh-CN", { numeric: true }));
  return snapshot;
}

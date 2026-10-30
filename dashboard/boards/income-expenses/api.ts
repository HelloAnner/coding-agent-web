import { FinanceDataError, readFinanceData } from "./data";

export async function getFinance() {
  const headers = { "Cache-Control": "no-store" };
  try {
    return Response.json(await readFinanceData(), { headers });
  } catch (error) {
    if (!(error instanceof FinanceDataError)) console.error("[finance] Failed to read JSON data", error);
    return Response.json({ error: error instanceof FinanceDataError ? error.message : "财务数据读取失败，请检查数据目录的访问权限" }, { status: 500, headers });
  }
}

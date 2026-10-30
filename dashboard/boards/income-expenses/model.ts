export type TransactionType = "income" | "expense";

export interface FinanceTransaction {
  id: string;
  date: string;
  type: TransactionType;
  amountCents: number;
  description: string;
  counterparty: string;
  category: string;
  account: string;
}

export interface FinanceSnapshot {
  transactions: FinanceTransaction[];
  files: string[];
  containsSampleData: boolean;
}

export function financeTotals(transactions: readonly FinanceTransaction[]) {
  let income = 0;
  let expense = 0;
  for (const row of transactions) {
    if (row.type === "income") income += row.amountCents;
    else expense += row.amountCents;
  }
  return { income, expense, balance: income - expense, savingsRate: income ? (income - expense) / income : null };
}

/** Fill missing days/months with zero; chart and ledger use the same transactions. */
export function financeTrend(transactions: readonly FinanceTransaction[], month: string) {
  const grouped = new Map<string, { label: string; income: number; expense: number }>();
  if (month) {
    const [year, monthNumber] = month.split("-").map(Number);
    const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    for (let day = 1; day <= days; day++) {
      const label = `${month}-${String(day).padStart(2, "0")}`;
      grouped.set(label, { label, income: 0, expense: 0 });
    }
  } else if (transactions.length) {
    const dates = transactions.map((row) => row.date.slice(0, 7)).sort();
    const [year, monthNumber] = dates[0].split("-").map(Number);
    const cursor = new Date(Date.UTC(year, monthNumber - 1, 1));
    while (cursor.toISOString().slice(0, 7) <= dates[dates.length - 1]) {
      const label = cursor.toISOString().slice(0, 7);
      grouped.set(label, { label, income: 0, expense: 0 });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  for (const row of transactions) {
    const key = row.date.slice(0, month ? 10 : 7);
    const point = grouped.get(key);
    if (point) point[row.type] += row.amountCents;
  }
  return [...grouped.values()];
}

export function expenseCategories(transactions: readonly FinanceTransaction[]) {
  const categories = new Map<string, number>();
  for (const row of transactions) {
    if (row.type === "expense") categories.set(row.category, (categories.get(row.category) ?? 0) + row.amountCents);
  }
  return [...categories].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "zh-CN"));
}

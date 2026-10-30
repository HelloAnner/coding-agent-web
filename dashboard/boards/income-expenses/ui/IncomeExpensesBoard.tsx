"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { expenseCategories, financeTotals, financeTrend, type FinanceSnapshot, type FinanceTransaction } from "../model";
import styles from "./income-expenses.module.css";

const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" });
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });
const formatMoney = (cents: number) => money.format(cents / 100);
const formatMonth = (month: string) => `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`;
const tones = [styles.violet, styles.orange, styles.blue, styles.teal, styles.pink];

function TrendChart({ transactions, month }: { transactions: FinanceTransaction[]; month: string }) {
  const titleId = useId();
  const points = financeTrend(transactions, month);
  const max = Math.max(100, ...points.flatMap((point) => [point.income, point.expense]));
  const step = 10 ** Math.floor(Math.log10(max));
  const ceiling = Math.ceil(max / step) * step;
  const x = (index: number) => 62 + index * 884 / Math.max(1, points.length - 1);
  const y = (amount: number) => 216 - amount / ceiling * 190;
  const label = (value: string) => month ? `${Number(value.slice(5, 7))}/${Number(value.slice(8))}` : `${value.slice(0, 4)}/${value.slice(5)}`;
  return (
    <div className={styles.chartWrap} role="region" aria-label="收支趋势图，可横向滚动" tabIndex={0}>
      {!transactions.length ? <div className={styles.chartEmpty}>当前范围暂无收支记录</div> : (
        <svg className={styles.chart} viewBox="0 0 968 256" role="img" aria-labelledby={titleId}>
          <title id={titleId}>收支趋势，{month ? "按日" : "按月"}统计，单位人民币元。绿色为收入，粉色为支出，精确金额见收支明细。</title>
          {[0, 1, 2, 3, 4].map((index) => {
            const amount = ceiling * index / 4;
            return <g key={index}>
              <line x1="62" x2="946" y1={y(amount)} y2={y(amount)} className={styles.gridLine} />
              <text x="50" y={y(amount) + 4} textAnchor="end" className={styles.axisLabel}>{new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(amount / 100)}</text>
            </g>;
          })}
          {(["income", "expense"] as const).map((type) => <g key={type} className={type === "income" ? styles.incomeLine : styles.expenseLine}>
            <polyline points={points.map((point, index) => `${x(index)},${y(point[type])}`).join(" ")} className={styles.trendLine} />
            {points.map((point, index) => <circle key={point.label} cx={x(index)} cy={y(point[type])} r={points.length === 1 ? 3 : 2} className={styles.chartPoint}>
              <title>{point.label} · {type === "income" ? "收入" : "支出"} {formatMoney(point[type])}</title>
            </circle>)}
          </g>)}
          {points.map((point, index) => (index % Math.max(1, Math.ceil(points.length / 7)) === 0 || index === points.length - 1) && (
            <text key={point.label} x={x(index)} y="243" textAnchor="middle" className={styles.axisLabel}>{label(point.label)}</text>
          ))}
        </svg>
      )}
    </div>
  );
}

function SegmentMeter({ label, value, tone }: { label: string; value: number | null; tone: string }) {
  const clamped = Math.min(1, Math.max(0, value ?? 0));
  return <div className={styles.meter}>
    <div className={styles.meterLabel}><span className={tone}>●</span> {label}</div>
    <div className={`${styles.segments} ${tone}`} role="img" aria-label={`${label} ${value === null ? "无收入，无法计算" : percent.format(value)}`}>
      {Array.from({ length: 44 }, (_, index) => <span key={index} style={{ opacity: index / 44 < clamped ? 1 : 0.12 }} />)}
    </div>
    <div className={styles.meterScale}><strong>{value === null ? "—" : percent.format(value)}</strong><span>100%</span></div>
  </div>;
}

export function IncomeExpensesBoard({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<FinanceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [month, setMonth] = useState<string | null>(null);
  const [account, setAccount] = useState("");
  const [view, setView] = useState<"overview" | "transactions">("overview");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState<{ key: "date" | "amountCents"; descending: boolean }>({ key: "date", descending: true });
  const request = useRef<AbortController | null>(null);
  const id = useId();

  const load = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/dashboard/income-expenses", { cache: "no-store", signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `读取失败（HTTP ${response.status}）`);
      if (!data || !Array.isArray(data.transactions) || !Array.isArray(data.files) || typeof data.containsSampleData !== "boolean") throw new Error("财务数据格式错误");
      if (!controller.signal.aborted) setSnapshot(data);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "财务数据读取失败");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [active, load]);

  const months = useMemo(() => [...new Set(snapshot?.transactions.map((row) => row.date.slice(0, 7)))].sort().reverse(), [snapshot]);
  const accounts = useMemo(() => [...new Set(snapshot?.transactions.map((row) => row.account))].sort(), [snapshot]);
  const categories = useMemo(() => [...new Set(snapshot?.transactions.map((row) => row.category))].sort(), [snapshot]);
  const selectedMonth = month ?? months[0] ?? "";
  const transactions = useMemo(() => (snapshot?.transactions ?? []).filter((row) =>
    (!selectedMonth || row.date.startsWith(selectedMonth)) && (!account || row.account === account),
  ), [snapshot, selectedMonth, account]);
  const totals = financeTotals(transactions);
  const breakdown = expenseCategories(transactions);
  const query = search.trim().toLocaleLowerCase("zh-CN");
  const rows = useMemo(() => transactions.filter((row) => (!type || row.type === type) && (!query ||
    [row.description, row.counterparty, row.category, row.account, row.id].some((text) => text.toLocaleLowerCase("zh-CN").includes(query))
  )).sort((a, b) => {
    const compared = sort.key === "amountCents" ? a.amountCents - b.amountCents : a.date.localeCompare(b.date);
    return (sort.descending ? -compared : compared) || a.id.localeCompare(b.id, "zh-CN", { numeric: true });
  }), [transactions, type, query, sort]);
  const period = selectedMonth ? formatMonth(selectedMonth) : "全部月份";
  const canShowData = snapshot !== null;

  function toggleSort(key: "date" | "amountCents") {
    setSort((current) => ({ key, descending: current.key === key ? !current.descending : true }));
  }

  return (
    <section className={styles.board} hidden={!active} aria-label="收入支出分析" lang="zh-CN">
      <div className={styles.canvas}>
        <header className={styles.header}>
          <div>
            <div className={styles.eyebrow}>财务 <span>/</span> FINANCIAL OVERVIEW</div>
            <h1>收入支出分析</h1>
            <p>每一笔收支，清晰有迹。<span className={styles.headerNote}> 从本地 JSON 文件了解你的资金流向。</span></p>
          </div>
          <div className={styles.sourceBadge}><span />本地 JSON <span className={styles.badgeDivider}>|</span> CNY</div>
        </header>

        <div className={styles.navigation}>
          <div className={styles.tabs} aria-label="看板视图">
            <button type="button" className={view === "overview" ? styles.activeTab : ""} aria-pressed={view === "overview"} onClick={() => setView("overview")}>收支概览</button>
            <button type="button" className={view === "transactions" ? styles.activeTab : ""} aria-pressed={view === "transactions"} onClick={() => setView("transactions")}>交易明细 <span>{transactions.length}</span></button>
          </div>
          <span className={styles.navigationNote}>{snapshot ? `${snapshot.files.length} 个数据文件` : "正在连接数据源"}</span>
        </div>

        <div className={styles.toolbar}>
          <div className={styles.filters}>
            <label className={styles.selectControl}><span aria-hidden="true">▦</span><select aria-label="统计月份" value={selectedMonth} onChange={(event) => setMonth(event.target.value)}>
              <option value="">全部月份</option>
              {month && !months.includes(month) && <option value={month}>{formatMonth(month)}（无数据）</option>}
              {months.map((value) => <option value={value} key={value}>{formatMonth(value)}</option>)}
            </select></label>
            <label className={styles.selectControl}><span aria-hidden="true">▤</span><select aria-label="统计账户" value={account} onChange={(event) => setAccount(event.target.value)}>
              <option value="">全部账户</option>
              {[...new Set([...accounts, ...(account ? [account] : [])])].map((value) => <option value={value} key={value}>{value}</option>)}
            </select></label>
            <span className={styles.periodNote}>{period} · 人民币 / 元</span>
          </div>
          <button type="button" className={styles.refreshButton} onClick={() => void load()} disabled={pending} aria-busy={pending}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 11-1l3 6M4 12l3 6a7 7 0 0 0 11-1" /></svg>
            {pending ? "读取中…" : "刷新数据"}
          </button>
        </div>

        {error && <div className={styles.error} role="alert">{error}{snapshot ? "。当前保留上次成功读取的数据，请修正文件后刷新。" : "。请检查 JSON 文件后重试。"}</div>}
        {snapshot?.containsSampleData && <div className={styles.sampleNotice}><span>示例数据</span> 当前包含演示记录，不代表真实财务状况；使用前请移除「示例-」文件并放入自己的 JSON。</div>}
        {snapshot && !snapshot.files.length && <div className={styles.emptyNotice}>还没有数据文件。在 <code>data/dashboard/财务/</code> 放入 JSON 后点击「刷新数据」。</div>}

        {view === "overview" && <>
          <div className={styles.stats} aria-label="当期收支汇总" aria-busy={pending}>
            <div className={styles.stat}><div className={styles.statLabel}><span className={styles.teal}>↙</span> 总收入</div><strong>{canShowData ? formatMoney(totals.income) : "—"}</strong><small>{transactions.filter((row) => row.type === "income").length} 笔收入 · {period}</small></div>
            <div className={styles.stat}><div className={styles.statLabel}><span className={styles.pink}>↗</span> 总支出</div><strong>{canShowData ? formatMoney(totals.expense) : "—"}</strong><small>{transactions.filter((row) => row.type === "expense").length} 笔支出 · {period}</small></div>
            <div className={styles.stat}><div className={styles.statLabel}><span className={styles.orange}>≋</span> 净结余</div><strong>{canShowData ? formatMoney(totals.balance) : "—"}</strong><small>当期收入 − 当期支出</small></div>
            <div className={styles.stat}><div className={styles.statLabel}><span className={styles.violet}>◴</span> 结余率</div><strong>{canShowData && totals.savingsRate !== null ? percent.format(totals.savingsRate) : "—"}</strong><small>{totals.income ? "每一份收入中留下的比例" : "当期无收入，暂不计算"}</small></div>
          </div>

          <section className={styles.panel} aria-labelledby={`${id}-trend`}>
            <header className={styles.panelHeader}>
              <div><h2 id={`${id}-trend`}>收支趋势</h2><p>{selectedMonth ? "按日" : "按月"}追踪收入与支出，未发生交易的日期记为零。</p></div>
              <span className={styles.quietBadge}>{selectedMonth ? "每日" : "每月"} <span aria-hidden="true">⌁</span></span>
            </header>
            <div className={styles.legend}><span><i className={styles.teal} />收入</span><span><i className={styles.pink} />支出</span></div>
            {canShowData ? <TrendChart transactions={transactions} month={selectedMonth} /> : <div className={styles.chartEmpty}>{error ? "无法读取趋势数据" : "正在读取收支数据…"}</div>}
            <div className={styles.chartNote}>只统计所选月份与账户的记录，金额以交易明细为准。</div>
            <div className={styles.allocation}>
              <div><h3>收支分配</h3><p>看清支出与结余在收入中的占比。</p></div>
              <div className={styles.meters}>
                <SegmentMeter label="支出 / 收入" value={canShowData && totals.income ? totals.expense / totals.income : null} tone={styles.orange} />
                <SegmentMeter label="净结余 / 收入" value={canShowData ? totals.savingsRate : null} tone={styles.violet} />
              </div>
              <p className={styles.allocationNote}>比例可超过 100% 或为负；刻度条仅显示 0–100% 范围。</p>
            </div>
          </section>

          <section className={styles.panel} aria-labelledby={`${id}-categories`}>
            <header className={styles.panelHeader}><div><h2 id={`${id}-categories`}>支出分类</h2><p>钱花在哪里，一目了然。</p></div><span className={styles.muted}>{breakdown.length} 个分类 · 合计 {canShowData ? formatMoney(totals.expense) : "—"}</span></header>
            <div className={styles.categoryGrid}>
              {breakdown.map((category, index) => <div className={styles.category} key={category.name}>
                <div className={styles.categoryHeading}><span><i className={tones[index % tones.length]} />{category.name}</span><strong>{formatMoney(category.amount)}</strong></div>
                <div className={styles.categoryTrack}><span className={tones[index % tones.length]} style={{ width: `${category.amount / totals.expense * 100}%` }} /></div>
                <small>{percent.format(category.amount / totals.expense)} 的当期支出</small>
              </div>)}
              {!breakdown.length && <p className={styles.noCategories}>{canShowData ? "当前范围暂无支出" : "等待数据加载"}</p>}
            </div>
          </section>
        </>}

        <section className={styles.panel} aria-labelledby={`${id}-ledger`}>
          <header className={styles.panelHeader}><div><h2 id={`${id}-ledger`}>收支明细 <span className={styles.count}>{transactions.length}</span></h2><p>所选范围内的每一笔收入与支出。</p></div><span className={styles.quietBadge}>只读账本</span></header>
          <div className={styles.ledgerToolbar}>
            <label className={styles.searchControl}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg><input type="search" aria-label="搜索收支明细" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索交易、对方或分类…" /></label>
            <label className={styles.selectControl}><select aria-label="明细收支类型" value={type} onChange={(event) => setType(event.target.value)}><option value="">全部收支</option><option value="income">仅收入</option><option value="expense">仅支出</option></select></label>
            <span className={styles.ledgerCount} role="status">{rows.length} 条记录</span>
          </div>
          <div className={styles.tableWrap} role="region" aria-label="收支明细，可横向滚动" tabIndex={0} aria-busy={pending}>
            <table className={styles.table}>
              <caption className={styles.srOnly}>收支明细。日期与金额列支持点击排序；明细搜索及类型筛选不改变上方汇总。</caption>
              <thead><tr>
                <th scope="col" className={styles.indexColumn}>#</th><th scope="col">交易 / 对方</th><th scope="col">类型</th>
                <th scope="col" aria-sort={sort.key === "date" ? sort.descending ? "descending" : "ascending" : "none"}><button type="button" onClick={() => toggleSort("date")}>日期 <span aria-hidden="true">{sort.key === "date" ? sort.descending ? "↓" : "↑" : "↕"}</span></button></th>
                <th scope="col">账户</th><th scope="col">分类</th>
                <th scope="col" className={styles.amountColumn} aria-sort={sort.key === "amountCents" ? sort.descending ? "descending" : "ascending" : "none"}><button type="button" onClick={() => toggleSort("amountCents")}>金额 <span aria-hidden="true">{sort.key === "amountCents" ? sort.descending ? "↓" : "↑" : "↕"}</span></button></th>
              </tr></thead>
              <tbody>{rows.map((row, index) => <tr key={row.id}>
                <td className={styles.indexColumn}>{String(index + 1).padStart(2, "0")}</td>
                <td className={styles.transactionCell}><div className={styles.transaction}><span className={`${styles.avatar} ${row.type === "income" ? styles.teal : styles.orange}`} aria-hidden="true">{row.counterparty.slice(0, 1)}</span><div><strong>{row.description}</strong><small>{row.counterparty}</small></div></div></td>
                <td><span className={row.type === "income" ? styles.teal : styles.pink}><span aria-hidden="true">{row.type === "income" ? "↙" : "↗"}</span> {row.type === "income" ? "收入" : "支出"}</span></td>
                <td><time dateTime={row.date}>{row.date}</time></td><td><span className={styles.accountName}>{row.account}</span></td>
                <td><span className={`${styles.categoryBadge} ${tones[categories.indexOf(row.category) % tones.length]}`}><span aria-hidden="true">#</span> {row.category}</span></td>
                <td className={`${styles.amountColumn} ${row.type === "income" ? styles.teal : ""}`}>{row.type === "income" ? "+" : "−"}{formatMoney(row.amountCents)}</td>
              </tr>)}
                {!rows.length && <tr><td colSpan={7} className={styles.emptyCell}>{!snapshot ? error ? "数据加载失败，请点击刷新重试" : "正在读取交易记录…" : transactions.length ? "没有匹配的交易，试试其他搜索词或收支类型" : "当前范围暂无交易记录"}</td></tr>}
              </tbody>
            </table>
          </div>
          <footer className={styles.tableFooter}><span>显示 {rows.length} / {transactions.length} 条 · 明细筛选不影响汇总</span><span>金额单位 CNY</span></footer>
        </section>
        <footer className={styles.footer}><span><span className={styles.sourceDot} /> 数据来源 <code>data/dashboard/财务/*.json</code></span><span>本地文件 · 只读分析 · 无外部同步</span></footer>
      </div>
    </section>
  );
}

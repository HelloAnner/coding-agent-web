"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { UsageBucket, UsageDaySummary, UsageMetrics } from "@/lib/usage-types";
import styles from "./UsageAnalytics.module.css";

interface UsageResponse {
  days: UsageDaySummary[];
  buckets: UsageBucket[];
  timeZone?: string;
  diagnostics?: unknown[];
  sync: {
    lastCollectedAt: number | null;
    error: string | null;
    running: boolean;
    diagnostics?: unknown[];
  };
}
type Metric = "totalTokens" | "requests" | "cost";
type Range = 1 | 7 | 30;
type TableView = "daily" | "hourly" | "dimensions";

const en = {
  title: "Usage analytics", subtitle: "Your local activity, in perspective.",
  refresh: "Collect now", collecting: "Collecting…", loading: "Loading usage…", refreshing: "Updating usage…",
  updated: "Last collected", never: "Not collected yet", failed: "Could not load usage. Try again.",
  collectionFailed: "The last collection reported an error.", retry: "Retry", day: "Day", seven: "7 days", thirty: "30 days",
  endDay: "Ending on", harness: "Harness", model: "Model", allHarnesses: "All harnesses", allModels: "All models",
  unknownModel: "Unspecified model", unknownProvider: "Unspecified provider", metric: "Chart measure",
  totalTokens: "Total tokens", inputTokens: "Input", outputTokens: "Output", cacheReadTokens: "Cache read",
  cacheWriteTokens: "Cache write", requests: "Requests", sessions: "Distinct sessions", cost: "Recorded cost",
  messages: "Messages", toolCalls: "Tool calls", errors: "Errors", costKnownRequests: "Cost recorded", costUnknownRequests: "Cost unknown",
  previous: "vs. previous period", noBaseline: "No previous activity", unchanged: "No change", unknown: "Unknown", partial: "Partial",
  costNote: "Recorded USD only, not an estimate. Requests without a recorded cost are excluded, not treated as free.",
  sessionsNote: "Unique sessions across this period; daily session counts are not additive.",
  dailyTrend: "Daily trend", hourlyActivity: "Hourly activity", byHarness: "By harness", byModel: "By model",
  hourlyNote: "Combined by local hour across the selected period.", hourlyMissing: "No timestamped activity in this selection.",
  ranksNote: "Ranked by total tokens", noData: "No activity in this period", emptyNote: "Collect local usage or choose another date or filter.",
  clearFilters: "Reset filters", table: "Explore the data", daily: "Daily", hourly: "Hourly", dimensions: "Harness & model",
  tableCaption: "Usage in the selected period. Cost is recorded USD only. Sessions are distinct within each row.",
  date: "Date", hour: "Hour", provider: "Provider", coverage: "Collection coverage", coverageNote: "Source diagnostics describe the last collection, not the current filters.",
  diagnostics: "Source diagnostics", noDiagnostics: "No source diagnostics available.", source: "Source", files: "Files", records: "Records",
  duplicates: "Duplicates skipped", invalidRecords: "Invalid records", missingTimestamps: "Missing timestamps", unreadableFiles: "Unreadable files",
  limitations: "Limitations", clean: "No source warnings", warning: "Source warnings", sources: "Sources", timezone: "Time zone", other: "Other",
  tableView: "View table", texture: "Patterned charts", dismiss: "Dismiss tooltip", unavailable: "Not available",
  partialCost: "Some requests have no recorded cost", incomplete: "Some source records could not be collected.",
};
type Labels = typeof en;
const labels: Record<string, Labels> = {
  en,
  "zh-CN": {
    title: "用量分析", subtitle: "一览本地使用情况。", refresh: "立即采集", collecting: "采集中…", loading: "正在加载用量…", refreshing: "正在更新用量…",
    updated: "上次采集", never: "尚未采集", failed: "无法加载用量，请重试。", collectionFailed: "上次采集发生错误。", retry: "重试",
    day: "单日", seven: "7 天", thirty: "30 天", endDay: "截至日期", harness: "运行器", model: "模型", allHarnesses: "所有运行器", allModels: "所有模型",
    unknownModel: "未指定模型", unknownProvider: "未指定提供商", metric: "图表指标", totalTokens: "总 Token", inputTokens: "输入", outputTokens: "输出",
    cacheReadTokens: "缓存读取", cacheWriteTokens: "缓存写入", requests: "请求", sessions: "独立会话", cost: "已记录费用", messages: "消息", toolCalls: "工具调用",
    errors: "错误", costKnownRequests: "费用已知", costUnknownRequests: "费用未知", previous: "较上一时段", noBaseline: "上一时段无活动", unchanged: "无变化",
    unknown: "未知", partial: "不完整", costNote: "仅汇总已记录的美元费用，不作估算。未记录费用的请求不计入，不代表免费。",
    sessionsNote: "按整个时段去重；每天的会话数不能直接相加。", dailyTrend: "每日趋势", hourlyActivity: "每小时活动", byHarness: "运行器排行", byModel: "模型排行",
    hourlyNote: "将所选时段的活动按当地小时汇总。", hourlyMissing: "当前选择没有带时间戳的活动。", ranksNote: "按总 Token 排序", noData: "此时段暂无活动",
    emptyNote: "采集本地用量，或尝试其他日期和筛选条件。", clearFilters: "重置筛选", table: "用量明细", daily: "每日", hourly: "每小时", dimensions: "运行器与模型",
    tableCaption: "所选时段的用量。费用仅为已记录的美元金额。每行会话数均已去重。", date: "日期", hour: "小时", provider: "提供商", coverage: "采集覆盖情况",
    coverageNote: "来源诊断对应最近一次采集，不受当前筛选影响。", diagnostics: "来源诊断", noDiagnostics: "暂无来源诊断。", source: "来源", files: "文件", records: "记录",
    duplicates: "已跳过重复项", invalidRecords: "无效记录", missingTimestamps: "缺少时间戳", unreadableFiles: "无法读取的文件", limitations: "限制", clean: "来源无警告",
    warning: "来源有警告", sources: "来源", timezone: "时区", other: "其他", tableView: "查看表格", texture: "图表纹理", dismiss: "关闭提示",
    unavailable: "不可用", partialCost: "部分请求未记录费用", incomplete: "部分来源记录无法采集。",
  },
  "zh-TW": {
    title: "用量分析", subtitle: "一覽本機使用情況。", refresh: "立即收集", collecting: "收集中…", loading: "正在載入用量…", refreshing: "正在更新用量…",
    updated: "上次收集", never: "尚未收集", failed: "無法載入用量，請重試。", collectionFailed: "上次收集發生錯誤。", retry: "重試",
    day: "單日", seven: "7 天", thirty: "30 天", endDay: "截至日期", harness: "執行器", model: "模型", allHarnesses: "所有執行器", allModels: "所有模型",
    unknownModel: "未指定模型", unknownProvider: "未指定提供者", metric: "圖表指標", totalTokens: "總 Token", inputTokens: "輸入", outputTokens: "輸出",
    cacheReadTokens: "快取讀取", cacheWriteTokens: "快取寫入", requests: "請求", sessions: "獨立工作階段", cost: "已記錄費用", messages: "訊息", toolCalls: "工具呼叫",
    errors: "錯誤", costKnownRequests: "費用已知", costUnknownRequests: "費用未知", previous: "較上一時段", noBaseline: "上一時段無活動", unchanged: "無變化",
    unknown: "未知", partial: "不完整", costNote: "僅彙總已記錄的美元費用，不作估算。未記錄費用的請求不計入，不代表免費。",
    sessionsNote: "以整個時段去重；每天的工作階段數不能直接相加。", dailyTrend: "每日趨勢", hourlyActivity: "每小時活動", byHarness: "執行器排行", byModel: "模型排行",
    hourlyNote: "將所選時段的活動按當地小時彙總。", hourlyMissing: "目前選取範圍沒有附時間戳記的活動。", ranksNote: "按總 Token 排序", noData: "此時段尚無活動",
    emptyNote: "收集本機用量，或嘗試其他日期及篩選條件。", clearFilters: "重設篩選", table: "用量明細", daily: "每日", hourly: "每小時", dimensions: "執行器與模型",
    tableCaption: "所選時段的用量。費用僅為已記錄的美元金額。每列工作階段數均已去重。", date: "日期", hour: "小時", provider: "提供者", coverage: "收集涵蓋情況",
    coverageNote: "來源診斷對應最近一次收集，不受目前篩選影響。", diagnostics: "來源診斷", noDiagnostics: "尚無來源診斷。", source: "來源", files: "檔案", records: "記錄",
    duplicates: "已略過重複項", invalidRecords: "無效記錄", missingTimestamps: "缺少時間戳記", unreadableFiles: "無法讀取的檔案", limitations: "限制", clean: "來源無警告",
    warning: "來源有警告", sources: "來源", timezone: "時區", other: "其他", tableView: "檢視表格", texture: "圖表紋理", dismiss: "關閉提示",
    unavailable: "無法使用", partialCost: "部分請求未記錄費用", incomplete: "部分來源記錄無法收集。",
  },
};
const numberKeys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costKnownRequests", "costUnknownRequests", "requests", "messages", "toolCalls", "errors"] as const;
const tableKeys = ["totalTokens", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "requests", "sessions", "cost", "costKnownRequests", "costUnknownRequests", "messages", "toolCalls", "errors"] as const;
const harnessNames: Record<string, string> = { pi: "pi", dsh: "dsh", grok: "Grok", "claude-code": "Claude Code" };

function emptyMetrics(): UsageMetrics {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: null, costKnownRequests: 0, costUnknownRequests: 0, requests: 0, messages: 0, toolCalls: 0, sessions: 0, errors: 0 };
}
function sum(buckets: UsageBucket[]): UsageMetrics {
  const total = emptyMetrics();
  const sessions = new Set<string>();
  for (const bucket of buckets) {
    for (const key of numberKeys) total[key] += bucket[key];
    if (bucket.cost !== null) total.cost = (total.cost ?? 0) + bucket.cost;
    for (const id of bucket.sessionIds) sessions.add(id);
  }
  total.sessions = sessions.size;
  return total;
}
function shiftDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
function dayInZone(timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const get = (type: string) => parts.find((part) => part.type === type)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch { return dayInZone(); }
}
function validDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}
function grouped(buckets: UsageBucket[], key: (bucket: UsageBucket) => string) {
  const groups = new Map<string, UsageBucket[]>();
  for (const bucket of buckets) {
    const id = key(bucket);
    const group = groups.get(id) ?? [];
    group.push(bucket);
    groups.set(id, group);
  }
  return [...groups].map(([name, rows]) => ({ name, ...sum(rows) }));
}
function useUsage() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [busy, setBusy] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [error, setError] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const load = useCallback(async (collect = false) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setCollecting(collect);
    setError(false);
    try {
      if (collect) {
        const response = await fetch("/api/usage", { method: "POST", signal: controller.signal });
        if (!response.ok) throw new Error("Collection failed");
      }
      const response = await fetch("/api/usage", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Usage request failed");
      const next: UsageResponse = await response.json();
      if (!Array.isArray(next.days) || !Array.isArray(next.buckets) || !next.sync) throw new Error("Invalid usage response");
      if (!controller.signal.aborted) setData(next);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) { setBusy(false); setCollecting(false); }
    }
  }, []);
  useEffect(() => {
    void load();
    return () => pending.current?.abort();
  }, [load]);
  useEffect(() => {
    if (!data?.sync.running || busy || error) return;
    const timer = window.setTimeout(() => { void load(); }, 2000);
    return () => window.clearTimeout(timer);
  }, [data, busy, error, load]);
  return { data, busy, collecting, error, load };
}

interface Point { label: string; value: number | null; detail?: string }
function moveFocus(event: KeyboardEvent<SVGRectElement>, index: number, count: number) {
  const next = event.key === "ArrowRight" ? Math.min(index + 1, count - 1)
    : event.key === "ArrowLeft" ? Math.max(index - 1, 0)
      : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null;
  if (next === null) return;
  event.preventDefault();
  event.currentTarget.parentElement?.querySelectorAll<SVGRectElement>("[data-hit]")[next]?.focus();
}
function Plot({ points, title, kind, format, unknown, dismiss }: {
  points: Point[]; title: string; kind: "line" | "bar"; format: (value: number) => string; unknown: string; dismiss: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const id = useId();
  const width = 680, height = 216, left = 54, right = 26, top = 20, bottom = 32;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maxValue = Math.max(...points.map((point) => point.value ?? 0), 1);
  const step = 10 ** Math.floor(Math.log10(maxValue));
  const max = Math.ceil(maxValue / step / 2) * step * 2;
  const x = (index: number) => kind === "bar" ? left + (index + 0.5) * plotWidth / points.length : left + (points.length === 1 ? plotWidth / 2 : index * plotWidth / (points.length - 1));
  const y = (value: number) => top + plotHeight * (1 - value / max);
  const path = points.map((point, index) => point.value === null ? "" : `${index === 0 || points[index - 1].value === null ? "M" : "L"}${x(index)},${y(point.value)}`).join(" ");
  const selected = active === null ? null : points[active];
  const tickEvery = Math.max(1, Math.ceil(points.length / 6));
  return (
    <div className={styles.plot} onMouseLeave={() => setActive(null)}>
      <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label={title}>
        <title>{title}</title>
        <defs><pattern id={`${id}-pattern`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="6" fill="currentColor" /></pattern></defs>
        {[0, 0.5, 1].map((ratio) => <g key={ratio}><line className={styles.gridline} x1={left} x2={width - right} y1={y(max * ratio)} y2={y(max * ratio)} /><text className={styles.axis} x={left - 10} y={y(max * ratio) + 4} textAnchor="end">{format(max * ratio)}</text></g>)}
        {kind === "line" && <path className={styles.trendLine} d={path} fill="none" />}
        {points.map((point, index) => {
          const barWidth = Math.min(14, plotWidth / points.length - 4);
          const barHeight = point.value === null ? 0 : plotHeight * point.value / max;
          return <g key={`${point.label}-${index}`}>
            {kind === "bar" && point.value !== null && point.value > 0 && <path className={styles.bar} d={`M${x(index) - barWidth / 2},${y(0)}v-${Math.max(0, barHeight - Math.min(4, barHeight))}q0,-${Math.min(4, barHeight)} ${Math.min(4, barWidth / 2)},-${Math.min(4, barHeight)}h${Math.max(0, barWidth - 8)}q${Math.min(4, barWidth / 2)},0 ${Math.min(4, barWidth / 2)},${Math.min(4, barHeight)}V${y(0)}Z`} />}
            {kind === "bar" && point.value !== null && point.value > 0 && <rect className={styles.patternMark} x={x(index) - barWidth / 2} y={y(point.value)} width={barWidth} height={barHeight} fill={`url(#${id}-pattern)`} />}
            {kind === "line" && point.value !== null && (points.length === 1 || index === points.length - 1 || index === active || points[index - 1]?.value == null || points[index + 1]?.value == null) && <circle className={styles.point} cx={x(index)} cy={y(point.value)} r="4" />}
            {(index % tickEvery === 0 || index === points.length - 1) && <text className={styles.axis} x={x(index)} y={height - 8} textAnchor="middle">{point.label}</text>}
          </g>;
        })}
        {active !== null && kind === "line" && <line className={styles.crosshair} x1={x(active)} x2={x(active)} y1={top} y2={height - bottom} />}
        {points.map((point, index) => <rect key={`hit-${index}`} data-hit="" className={styles.hitTarget} tabIndex={0} role="img" aria-label={`${point.label}: ${point.value === null ? unknown : format(point.value)}${point.detail ? `; ${point.detail}` : ""}`} aria-describedby={active === index ? `${id}-tooltip` : undefined} x={kind === "bar" ? x(index) - plotWidth / points.length / 2 : Math.max(left - 12, x(index) - plotWidth / Math.max(1, points.length - 1) / 2)} y={top - 6} width={kind === "bar" ? plotWidth / points.length : points.length === 1 ? plotWidth : plotWidth / Math.max(1, points.length - 1)} height={plotHeight + 12} fill="transparent" onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} onBlur={() => setActive(null)} onKeyDown={(event) => { if (event.key === "Escape") setActive(null); else moveFocus(event, index, points.length); }} />)}
      </svg>
      {selected && <div role="tooltip" id={`${id}-tooltip`} className={styles.tooltip} style={{ left: `${Math.min(78, Math.max(20, (x(active!) / width) * 100))}%` }}><strong>{selected.value === null ? unknown : format(selected.value)}</strong><span>{selected.label} · {title}</span>{selected.detail && <span>{selected.detail}</span>}<button type="button" className={styles.srOnly} onClick={() => setActive(null)} aria-label={dismiss}>×</button></div>}
    </div>
  );
}

function RankedBars({ buckets, dimension, l, format }: { buckets: UsageBucket[]; dimension: "harness" | "model"; l: Labels; format: (n: number) => string }) {
  const [active, setActive] = useState<string | null>(null);
  const rows = grouped(buckets, (bucket) => dimension === "harness" ? bucket.harness : (bucket.model ?? ""))
    .sort((a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name));
  const shown = rows.slice(0, 6);
  if (rows.length > 6) shown.push({ name: "\0other", ...sum(buckets.filter((bucket) => !shown.some((row) => row.name === (dimension === "harness" ? bucket.harness : (bucket.model ?? ""))))) });
  const max = Math.max(1, ...shown.map((row) => row.totalTokens));
  const total = rows.reduce((value, row) => value + row.totalTokens, 0);
  const name = (key: string) => key === "\0other" ? l.other : dimension === "harness" ? (harnessNames[key] ?? key) : (key || l.unknownModel);
  return <div className={styles.rankList}>
    {shown.length === 0 && <p className={styles.chartEmpty}>{l.noData}</p>}
    {shown.map((row) => <div key={row.name} className={styles.rankRow} tabIndex={0} onMouseEnter={() => setActive(row.name)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(row.name)} onBlur={() => setActive(null)} onKeyDown={(event) => { if (event.key === "Escape") setActive(null); }} aria-label={`${name(row.name)}, ${l.totalTokens}: ${format(row.totalTokens)}, ${l.requests}: ${format(row.requests)}, ${l.sessions}: ${format(row.sessions)}`}>
      <div className={styles.rankHeading}><span title={name(row.name)}>{name(row.name)}</span><strong>{format(row.totalTokens)}</strong><small>{total ? Math.round(row.totalTokens / total * 100) : 0}%</small></div>
      <div className={styles.rankTrack}><div className={styles.rankFill} style={{ width: `${row.totalTokens / max * 100}%` }} /></div>
      {active === row.name && <div className={styles.rankTooltip} role="tooltip"><strong>{format(row.requests)}</strong> {l.requests} · <strong>{format(row.sessions)}</strong> {l.sessions}</div>}
    </div>)}
  </div>;
}

function DiagnosticDetails({ entries, l, format }: { entries: unknown[]; l: Labels; format: (n: number) => string }) {
  const known = ["files", "records", "duplicates", "invalidRecords", "missingTimestamps", "unreadableFiles"] as const;
  return <div className={styles.diagnosticList}>{entries.length === 0 ? <p className={styles.muted}>{l.noDiagnostics}</p> : entries.map((entry, index) => {
    const diagnostic = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const root = typeof diagnostic.root === "string" ? diagnostic.root : "";
    const harness = typeof diagnostic.harness === "string" ? diagnostic.harness : "";
    const limitations = Array.isArray(diagnostic.limitations) ? diagnostic.limitations.filter((item): item is string => typeof item === "string") : [];
    return <article key={`${harness}-${root}-${index}`} className={styles.diagnostic}>
      <div className={styles.diagnosticTitle}><strong>{harnessNames[harness] ?? (harness || `${l.source} ${index + 1}`)}</strong>{root && <code>{root}</code>}</div>
      <dl>{known.map((key) => typeof diagnostic[key] === "number" ? <div key={key}><dt>{l[key]}</dt><dd>{format(diagnostic[key] as number)}</dd></div> : null)}</dl>
      {limitations.length > 0 && <p><span className={styles.muted}>{l.limitations}: </span>{limitations.join(" · ")}</p>}
      {typeof entry === "string" && <p>{entry}</p>}
    </article>;
  })}</div>;
}

export function UsageAnalytics() {
  const { locale } = useI18n();
  const l = labels[locale] ?? en;
  const { data, busy, collecting, error, load } = useUsage();
  const [range, setRange] = useState<Range>(1);
  const [endDay, setEndDay] = useState("");
  const [harness, setHarness] = useState("");
  const [model, setModel] = useState("");
  const [metric, setMetric] = useState<Metric>("totalTokens");
  const [tableView, setTableView] = useState<TableView>("daily");
  const [texture, setTexture] = useState(false);
  const id = useId();
  const tableRef = useRef<HTMLElement | null>(null);
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const compact = useMemo(() => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }), [locale]);
  const usd = useMemo(() => new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 4 }), [locale]);
  const shortDate = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }), [locale]);
  const dateLabel = (day: string) => shortDate.format(new Date(`${day}T12:00:00Z`));
  const today = dayInZone(data?.timeZone);
  const end = endDay || today;
  const start = shiftDay(end, 1 - range);
  const previousStart = shiftDay(start, -range);
  const allBuckets = data?.buckets;
  const dailyBuckets = useMemo(() => (allBuckets ?? []).filter((bucket) => bucket.hour === -1), [allBuckets]);
  const filtered = useMemo(() => dailyBuckets.filter((bucket) => (!harness || bucket.harness === harness) && (!model || (bucket.model ?? "\0unknown") === model)), [dailyBuckets, harness, model]);
  const selected = useMemo(() => filtered.filter((bucket) => bucket.day >= start && bucket.day <= end), [filtered, start, end]);
  const previous = useMemo(() => sum(filtered.filter((bucket) => bucket.day >= previousStart && bucket.day < start)), [filtered, previousStart, start]);
  const totals = useMemo(() => sum(selected), [selected]);
  const days = useMemo(() => Array.from({ length: range }, (_, index) => {
    const day = shiftDay(start, index);
    return { day, ...sum(selected.filter((bucket) => bucket.day === day)) };
  }), [range, start, selected]);
  const hourlyBuckets = useMemo(() => (allBuckets ?? []).filter((bucket) => bucket.hour >= 0 && bucket.hour <= 23 && bucket.day >= start && bucket.day <= end && (!harness || bucket.harness === harness) && (!model || (bucket.model ?? "\0unknown") === model)), [allBuckets, start, end, harness, model]);
  const hours = useMemo(() => Array.from({ length: 24 }, (_, hour) => ({ hour, ...sum(hourlyBuckets.filter((bucket) => bucket.hour === hour)) })), [hourlyBuckets]);
  const harnesses = [...new Set(dailyBuckets.map((bucket) => bucket.harness))].sort();
  const models = [...new Set(dailyBuckets.filter((bucket) => !harness || bucket.harness === harness).map((bucket) => bucket.model ?? "\0unknown"))].sort();
  const diagnostics = data?.diagnostics ?? data?.sync.diagnostics ?? [];
  const warningCount = diagnostics.filter((entry) => {
    if (!entry || typeof entry !== "object") return true;
    const row = entry as Record<string, unknown>;
    return ["invalidRecords", "missingTimestamps", "unreadableFiles"].some((key) => typeof row[key] === "number" && (row[key] as number) > 0) || (Array.isArray(row.limitations) && row.limitations.length > 0);
  }).length;
  const formatMetric = (value: number) => metric === "cost" ? usd.format(value) : compact.format(value);
  const chartValue = (row: UsageMetrics) => metric === "cost" ? row.cost : row[metric];
  const costDetail = (row: UsageMetrics) => metric === "cost" ? `${l.costUnknownRequests}: ${nf.format(row.costUnknownRequests)}` : undefined;
  const delta = (key: "totalTokens" | "requests" | "sessions" | "cost") => {
    const current = totals[key], before = previous[key];
    if (key === "cost" && (totals.costUnknownRequests > 0 || previous.costUnknownRequests > 0)) return l.partialCost;
    if (current === null || before === null) return l.unknown;
    if (before === 0) return current === 0 ? l.unchanged : l.noBaseline;
    const percent = (current - before) / before * 100;
    return `${percent > 0 ? "+" : ""}${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(percent)}% ${l.previous}`;
  };
  const openTable = (view: TableView) => { setTableView(view); tableRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); tableRef.current?.focus({ preventScroll: true }); };
  const tableRows: (UsageMetrics & { day: string; hour?: number; harness?: string; model?: string | null; provider?: string | null })[] = tableView === "daily" ? days : tableView === "dimensions" ? [...selected].sort((a, b) => b.day.localeCompare(a.day) || a.harness.localeCompare(b.harness) || (a.model ?? "").localeCompare(b.model ?? "")) : grouped(hourlyBuckets, (bucket) => `${bucket.day}|${bucket.hour}`).map((row) => ({ ...row, day: row.name.split("|")[0], hour: Number(row.name.split("|")[1]) })).sort((a, b) => b.day.localeCompare(a.day) || (a.hour ?? 0) - (b.hour ?? 0));
  const noActivity = selected.length === 0;
  const running = collecting || data?.sync.running;
  const lastCollected = data?.sync.lastCollectedAt;

  return <section className={`${styles.root} ${texture ? styles.textured : ""}`} aria-labelledby={`${id}-title`}>
    <header className={styles.header}>
      <div><h2 id={`${id}-title`}>{l.title}</h2><p className={styles.muted}>{l.subtitle}</p></div>
      <div className={styles.syncControls}><button type="button" className={styles.primaryButton} onClick={() => void load(true)} disabled={busy || !!running}><svg className={running ? styles.spinning : ""} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 6.1a8 8 0 0 1 13.3 3M4.6 14.9a8 8 0 0 0 13.3 3" /></svg>{running ? l.collecting : l.refresh}</button>
        <span className={styles.syncTime}>{lastCollected != null ? <>{l.updated} <time dateTime={new Date(lastCollected).toISOString()}>{new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: data?.timeZone }).format(new Date(lastCollected))}</time></> : l.never}</span></div>
    </header>

    {(error || data?.sync.error) && <div className={styles.alert} role="alert"><span aria-hidden="true">!</span><span>{error ? l.failed : l.collectionFailed}</span><button type="button" className={styles.textButton} disabled={busy} onClick={() => void load()}>{l.retry}</button></div>}
    <div className={styles.filterBar}>
      <div className={styles.segmented} role="group" aria-label={l.date}>{([1, 7, 30] as const).map((value) => <button key={value} type="button" aria-pressed={range === value} onClick={() => setRange(value)}>{value === 1 ? l.day : value === 7 ? l.seven : l.thirty}</button>)}</div>
      <label className={styles.control}><span>{range === 1 ? l.date : l.endDay}</span><input type="date" value={end} onChange={(event) => { if (validDay(event.target.value)) setEndDay(event.target.value); }} /></label>
      <label className={styles.control}><span>{l.harness}</span><select aria-label={l.harness} value={harness} onChange={(event) => { setHarness(event.target.value); setModel(""); }}><option value="">{l.allHarnesses}</option>{harnesses.map((value) => <option value={value} key={value}>{harnessNames[value] ?? value}</option>)}</select></label>
      <label className={styles.control}><span>{l.model}</span><select aria-label={l.model} value={model} onChange={(event) => setModel(event.target.value)}><option value="">{l.allModels}</option>{models.map((value) => <option value={value} key={value}>{value === "\0unknown" ? l.unknownModel : value}</option>)}</select></label>
      <label className={styles.control}><span>{l.metric}</span><select aria-label={l.metric} value={metric} onChange={(event) => setMetric(event.target.value as Metric)}><option value="totalTokens">{l.totalTokens}</option><option value="requests">{l.requests}</option><option value="cost">{l.cost}</option></select></label>
    </div>
    <div className={styles.period}><span>{range === 1 ? dateLabel(end) : `${dateLabel(start)} — ${dateLabel(end)}`} <span className={styles.muted}>· {data?.timeZone ?? l.timezone}</span></span><label className={styles.textureToggle}><input type="checkbox" checked={texture} onChange={(event) => setTexture(event.target.checked)} />{l.texture}</label></div>
    <p className={styles.srOnly} role="status" aria-live="polite">{busy ? data ? l.refreshing : l.loading : ""}</p>
    {busy && !data && <div className={styles.loading} role="status"><span className={styles.loadingDot} />{l.loading}</div>}

    {data && <div className={`${styles.content} ${busy ? styles.updating : ""}`} aria-busy={busy}>
      <div className={styles.kpiGrid}>
        <article className={`${styles.kpi} ${styles.hero}`}><span>{l.totalTokens}</span><strong title={nf.format(totals.totalTokens)}>{compact.format(totals.totalTokens)}</strong><small>{delta("totalTokens")}</small></article>
        <article className={styles.kpi}><span>{l.requests}</span><strong title={nf.format(totals.requests)}>{compact.format(totals.requests)}</strong><small>{delta("requests")}</small></article>
        <article className={styles.kpi}><span>{l.sessions}</span><strong title={l.sessionsNote}>{nf.format(totals.sessions)}</strong><small>{delta("sessions")}</small></article>
        <article className={styles.kpi}><span>{l.cost}{totals.costUnknownRequests > 0 && totals.cost !== null && <em>{l.partial}</em>}</span><strong>{totals.cost === null ? l.unknown : usd.format(totals.cost)}</strong><small>{delta("cost")}</small></article>
      </div>
      <div className={styles.tokenBreakdown}>{(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const).map((key) => <div key={key}><span>{l[key]}</span><strong title={nf.format(totals[key])}>{compact.format(totals[key])}</strong></div>)}</div>
      <p className={styles.costNote}>{l.costNote} <span>{l.costKnownRequests}: <strong>{nf.format(totals.costKnownRequests)}</strong> · {l.costUnknownRequests}: <strong>{nf.format(totals.costUnknownRequests)}</strong></span></p>
      {noActivity && <div className={styles.empty}><svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true"><path d="M5 28h26M10 23v-6m8 6V9m8 14V14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg><h3>{l.noData}</h3><p>{l.emptyNote}</p>{(harness || model || endDay) && <button type="button" className={styles.secondaryButton} onClick={() => { setHarness(""); setModel(""); setEndDay(""); }}>{l.clearFilters}</button>}</div>}
      {!noActivity && <>
        <section className={styles.chartCard} aria-labelledby={`${id}-trend`}><div className={styles.cardHeading}><div><h3 id={`${id}-trend`}>{l.dailyTrend}</h3><p>{l[metric]}</p></div><button type="button" className={styles.textButton} onClick={() => openTable("daily")}>{l.tableView}<span aria-hidden="true"> ↗</span></button></div><Plot key={`${start}-${end}-${harness}-${model}-${metric}`} title={l[metric]} kind="line" points={days.map((row) => ({ label: dateLabel(row.day), value: chartValue(row), detail: costDetail(row) }))} format={formatMetric} unknown={l.unknown} dismiss={l.dismiss} /></section>
        <section className={styles.chartCard} aria-labelledby={`${id}-hourly`}><div className={styles.cardHeading}><div><h3 id={`${id}-hourly`}>{l.hourlyActivity}</h3><p>{l.hourlyNote}</p></div><button type="button" className={styles.textButton} onClick={() => openTable("hourly")}>{l.tableView}<span aria-hidden="true"> ↗</span></button></div>{hourlyBuckets.length ? <Plot key={`hour-${start}-${end}-${harness}-${model}-${metric}`} title={l[metric]} kind="bar" points={hours.map((row) => ({ label: `${String(row.hour).padStart(2, "0")}:00`, value: chartValue(row), detail: costDetail(row) }))} format={formatMetric} unknown={l.unknown} dismiss={l.dismiss} /> : <p className={styles.chartEmpty}>{l.hourlyMissing}</p>}</section>
        <div className={styles.rankGrid}>{(["harness", "model"] as const).map((dimension) => <section className={styles.chartCard} key={dimension} aria-labelledby={`${id}-${dimension}`}><div className={styles.cardHeading}><div><h3 id={`${id}-${dimension}`}>{dimension === "harness" ? l.byHarness : l.byModel}</h3><p>{l.ranksNote}</p></div><button type="button" className={styles.textButton} onClick={() => openTable("dimensions")}>{l.tableView}</button></div><RankedBars buckets={selected} dimension={dimension} l={l} format={(value) => nf.format(value)} /></section>)}</div>
      </>}
      <section className={styles.tableCard} ref={tableRef} tabIndex={-1} aria-labelledby={`${id}-table`}>
        <div className={styles.cardHeading}><h3 id={`${id}-table`}>{l.table}</h3><div className={styles.segmented} role="group" aria-label={l.table}>{(["daily", "hourly", "dimensions"] as const).map((value) => <button type="button" key={value} aria-pressed={tableView === value} onClick={() => setTableView(value)}>{l[value]}</button>)}</div></div>
        <div className={styles.detailRows} role="region" aria-label={l.table}>
          {tableRows.map((row, index) => <article className={styles.detailRow} key={`${row.day}-${row.hour ?? ""}-${row.harness ?? ""}-${row.model ?? ""}-${row.provider ?? ""}-${index}`}>
            <h4 className={styles.detailTitle}><time dateTime={row.day}>{row.day}</time>{tableView === "hourly" && <span>{String(row.hour).padStart(2, "0")}:00</span>}{tableView === "dimensions" && <><span>{harnessNames[row.harness ?? ""] ?? row.harness}</span><span>{row.model ?? l.unknownModel}</span><span className={styles.muted}>{row.provider ?? l.unknownProvider}</span></>}</h4>
            <dl className={styles.detailMetrics}>{tableKeys.map((key) => <div key={key}><dt>{l[key]}</dt><dd>{key === "cost" ? row.cost === null ? l.unknown : usd.format(row.cost) : nf.format(row[key])}</dd></div>)}</dl>
          </article>)}
          {tableRows.length === 0 && <p className={styles.chartEmpty}>{l.noData}</p>}
        </div>
        <p className={styles.tableNote}>{l.sessionsNote}</p>
      </section>
    </div>}
    {data && <section className={styles.coverage} aria-labelledby={`${id}-coverage`}><div className={styles.cardHeading}><div><h3 id={`${id}-coverage`}>{l.coverage}</h3><p>{l.coverageNote}</p></div><span className={styles.coverageBadge}><span aria-hidden="true">{warningCount ? "!" : "✓"}</span> {diagnostics.length ? warningCount ? l.warning : l.clean : l.unavailable}</span></div><div className={styles.coverageStats}><span>{l.sources} <strong>{nf.format(diagnostics.length)}</strong></span><span>{l.timezone} <strong>{data.timeZone ?? l.unknown}</strong></span>{warningCount > 0 && <span>{l.incomplete}</span>}</div><details><summary>{l.diagnostics}<span>{nf.format(diagnostics.length)}</span></summary><DiagnosticDetails entries={diagnostics} l={l} format={(value) => nf.format(value)} /></details></section>}
  </section>;
}

export default UsageAnalytics;

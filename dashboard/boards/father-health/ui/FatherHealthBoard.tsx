"use client";

import { useEffect, useState, type ReactNode } from "react";
import { flagLabel, formatValue, metricChange, metricSeries, type HealthData } from "../model";
import { HealthDetails, type DetailSelection } from "./HealthDetails";
import { MetricChart } from "./MetricChart";
import styles from "./father-health.module.css";

const tones = ["rust", "blue", "amber", "purple"];

function Panel({ title, symbol = "⌁", children, action }: { title: string; symbol?: string; children: ReactNode; action?: ReactNode }) {
  return <section className={styles.panel}>
    <header className={styles.panelHeading}><h2 lang="en"><span aria-hidden="true">{symbol}</span>{title}</h2>{action}</header>
    {children}
  </section>;
}

export function FatherHealthBoard({ active }: { active: boolean }) {
  const [data, setData] = useState<HealthData | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setPending(true);
    setError("");
    void (async () => {
      try {
        const response = await fetch("/api/dashboard/father-health", { cache: "no-store", signal: controller.signal });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || `读取失败（HTTP ${response.status}）`);
        if (!controller.signal.aborted) setData(value);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "健康数据读取失败");
      } finally {
        if (!controller.signal.aborted) setPending(false);
      }
    })();
    return () => controller.abort();
  }, [active, revision]);
  return <div hidden={!active}><FatherHealthView active={active} data={data} error={error} pending={pending} onRefresh={() => setRevision((value) => value + 1)} /></div>;
}

export function FatherHealthView({ active = true, data, error, pending, onRefresh }: { active?: boolean; data: HealthData | null; error: string; pending: boolean; onRefresh: () => void }) {
  const [range, setRange] = useState<{ start: string; end: string } | null>(null);
  const [metricId, setMetricId] = useState("egfr");
  const [group, setGroup] = useState("重点指标");
  const [detail, setDetail] = useState<DetailSelection | null>(null);
  useEffect(() => { if (!active) setDetail(null); }, [active]);
  const allReports = [...(data?.reports ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const latestDate = allReports.at(-1)?.date ?? "";
  const start = range?.start ?? allReports[0]?.date ?? "";
  const end = range?.end ?? latestDate;
  const invalidRange = Boolean(start && end && start > end);
  const reports = allReports.filter((report) => (!start || report.date >= start) && (!end || report.date <= end));
  const core = data?.metrics.filter((metric) => metric.core) ?? [];
  const metric = data?.metrics.find((item) => item.id === metricId) ?? core[0];
  const points = data && metric ? metricSeries(data, metric.id, start, end) : [];
  const selectedReport = reports.at(-1);
  const comparisonMetrics = data?.metrics.filter((item) => group === "全部指标" || (group === "重点指标" ? item.core || ["urine_albumin_24h", "potassium", "hemoglobin", "uric_acid"].includes(item.id) : item.group === group)) ?? [];
  const source = (sourceId: string, title: string) => setDetail({ sourceId, title });
  const showMetric = (id: string) => {
    const item = data?.metrics.find((row) => row.id === id);
    setDetail({ title: `${item?.label ?? id} · 指标详情`, metricId: id, sourceId: reports.at(-1)?.sourceId ?? data?.profile.sourceId });
  };
  const resultFor = (id: string) => selectedReport?.results.find((row) => row.metricId === id);
  const lastMedicationDate = data?.medications.filter((row) => row.status === "confirmed").map((row) => row.asOf).sort().at(-1);

  function preset(days: number | "year" | "all") {
    if (days === "all") { setRange(null); return; }
    if (!latestDate) return;
    const beginning = new Date(`${latestDate}T00:00:00Z`);
    if (days === "year") beginning.setUTCMonth(0, 1);
    else beginning.setUTCDate(beginning.getUTCDate() - days + 1);
    setRange({ start: beginning.toISOString().slice(0, 10), end: latestDate });
  }

  return <section className={styles.board} aria-label="Father's Health" lang="zh-CN">
    <header className={styles.header}>
      <div><h1 lang="en">Father&apos;s Health</h1><p>{latestDate ? `最近检查 ${latestDate}` : "个人健康档案"}<span> · Asia/Shanghai (UTC+08:00)</span></p></div>
      <div className={styles.headerTools}><span className={styles.localSource}><i />本地 JSON</span><button type="button" disabled={!data} onClick={() => setDetail({ title: "健康资料索引", library: true })}>资料索引 ↗</button><button type="button" disabled={pending} onClick={onRefresh} aria-busy={pending}>{pending ? "读取中…" : "↻ 刷新"}</button></div>
    </header>
    <div className={styles.toolbar}>
      <label>开始<input type="date" aria-label="健康记录开始日期" value={start} onChange={(event) => setRange({ start: event.target.value, end })} /></label>
      <label>结束<input type="date" aria-label="健康记录结束日期" value={end} onChange={(event) => setRange({ start, end: event.target.value })} /></label>
      <div className={styles.presets}><button type="button" onClick={() => preset("all")} aria-pressed={range === null}>全部</button><button type="button" onClick={() => preset(30)}>近30天</button><button type="button" onClick={() => preset(90)}>近90天</button><button type="button" onClick={() => preset("year")}>今年</button></div>
      <span className={styles.rangeNote}>{reports.length} 次检查 · {start || "不限"} → {end || "不限"}<small>快捷范围截至最新报告</small></span>
    </div>
    {error && <div className={styles.error} role="alert">{error}{data ? "；保留上次成功读取的数据。" : ""}</div>}
    {invalidRange && <div className={styles.error} role="alert">开始日期不能晚于结束日期。</div>}
    {!data ? <div className={styles.loading} role="status">{error ? "暂无可展示的健康数据，请检查本地 JSON 后刷新。" : "正在读取本地健康资料…"}</div> : <>
      <div className={styles.sections} aria-busy={pending}>
        <Panel title="Key Metrics" symbol="⌁" action={<span>所选区间 · 最近结果与前次变化</span>}>
          <div className={styles.coreGrid} aria-label="核心健康指标">
            {core.map((item, index) => {
              const series = metricSeries(data, item.id, start, end);
              const last = series.at(-1);
              const previous = series.at(-2);
              const change = metricChange(series);
              const historical = last && last.date !== selectedReport?.date;
              return <article className={styles.metricCard} key={item.id} data-tone={tones[index % tones.length]}>
                <button type="button" className={styles.cardTitle} onClick={() => showMetric(item.id)} aria-label={`查看${item.label}详情`}><span>{item.shortLabel}</span><small>{last ? historical ? "历史值" : "最近值" : "未测"} ↗</small></button>
                <div className={styles.metricValue}><strong>{formatValue(last?.value, item.decimals)}</strong><span>{last?.unit ?? item.unit}</span></div>
                <div className={styles.metricMeta}><time>{last?.date ?? "无实测记录"}</time><span>{last ? flagLabel[last.result.flag] : "—"}</span></div>
                <div className={styles.metricCompare}><div><small>前次结果</small><strong>{formatValue(previous?.value, item.decimals)}</strong><small>{previous?.date ?? "无前次记录"}</small></div><div><small>{change === null ? "可比测点不足" : "较前次报告值"}</small><strong>{change === null ? "—" : `${change > 0 ? "+" : ""}${formatValue(change, item.decimals)}`}</strong></div></div>
                <MetricChart points={series} label={item.label} compact decimals={item.decimals} />
              </article>;
            })}
          </div>
          <p className={styles.panelNote}>各指标保留各自检测日期。未复查的历史值不代表当前状态；口述、估算和缺测值不混入正式曲线。</p>
        </Panel>

        <Panel title="Trends" symbol="⌁" action={<select aria-label="选择健康趋势指标" value={metric?.id ?? ""} onChange={(event) => setMetricId(event.target.value)}>{data.metrics.filter((item) => metricSeries(data, item.id).length > 0).map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select>}>
          <div className={styles.trendSummary}><div><small>{metric?.label} · 所选区间最后一次</small><strong>{formatValue(points.at(-1)?.value, metric?.decimals)} <em>{points.at(-1)?.unit ?? metric?.unit}</em></strong></div><div><small>正式测点</small><strong>{points.length}<em>个</em></strong></div><div><small>首次 → 末次</small><strong>{points[0]?.date ?? "—"} <em>→</em> {points.at(-1)?.date ?? "—"}</strong></div><button type="button" disabled={!metric} onClick={() => metric && showMetric(metric.id)}>查看原始测点 ↗</button></div>
          <div className={styles.trendChart} data-tone={tones[Math.max(0, core.findIndex((item) => item.id === metric?.id)) % tones.length]}><MetricChart points={points} label={metric?.label ?? "指标"} decimals={metric?.decimals} /></div>
          <p className={styles.panelNote}>{points.length === 1 ? "只有一个实测值，不构成趋势。" : "虚线只连接实际测点，不代表缺测日期数据。"} {metric?.note} 不外推、不预测透析时间。</p>
        </Panel>

        <Panel title="Medications" symbol="✣" action={<span>最后确认 {lastMedicationDate ?? "—"} · 非当前处方</span>}>
          <div className={styles.medicationList}>{data.medications.map((medication, index) => <article className={styles.medication} key={medication.name}>
            <header><button type="button" aria-label={`查看${medication.name}用药详情`} onClick={() => setDetail({ title: `${medication.name} · 用药记录`, sourceId: medication.sourceId, medicationIndex: index })}>{medication.name}<span>详情 ↗</span></button><span className={medication.status === "confirmed" ? styles.confirmed : styles.unconfirmed}><i />{medication.status === "confirmed" ? "当时确认在服" : "服用待核实"}</span></header>
            <dl><dt>功效 / 定位</dt><dd>{medication.purpose}</dd><dt>剂量 / 频次</dt><dd>{medication.dose}</dd><dt>说明与注意</dt><dd>{medication.note}</dd></dl>
            <footer>记录于 {medication.asOf}</footer>
          </article>)}</div>
          <p className={styles.panelNote}>保留药物各自的确认时间与完整说明。规格不等于每次用量，功效说明不等于当前处方；不据此自行增减或停药。</p>
        </Panel>

        <Panel title="Health Overview" symbol="✧" action={<button type="button" onClick={() => source(data.profile.sourceId, "病情总览与时间线")}>病情总览 ↗</button>}>
          <div className={styles.profileMeta}><span>{data.profile.sex} · 档案记录年龄 {data.profile.ageAtLastReport} 岁</span><span>所选区间最近检查 {selectedReport?.date ?? "—"} · {selectedReport?.hospital ?? "暂无报告"}</span></div>
          <dl className={styles.profileFacts}><dt>基础病史</dt><dd>{data.profile.conditions.join(" / ")}</dd><dt>病史摘要</dt><dd>{data.profile.summary}</dd><dt>档案说明</dt><dd>{data.profile.context.map((note) => <p key={note}>{note}</p>)}</dd></dl>
          <div className={styles.systems}>{["potassium", "hemoglobin", "albumin", "uric_acid"].map((id, index) => {
            const item = data.metrics.find((row) => row.id === id);
            const result = resultFor(id);
            return <button type="button" key={id} data-tone={["teal", "blue", "purple", "amber"][index]} onClick={() => showMetric(id)}><div><small>{item?.label}</small><strong>{formatValue(result?.value)}<em>{result?.unit}</em></strong><small>{result ? `参考 ${result.reference}` : "本次未测"}</small></div><span className={styles.statusRing}>{result?.flag === "normal" ? "参考内" : result?.flag === "high" ? "↑" : result?.flag === "low" ? "↓" : "—"}</span><div className={styles.systemSpark}><MetricChart points={metricSeries(data, id, start, end)} compact label={item?.label ?? id} /></div></button>;
          })}</div>
          <div className={styles.vitalStrips}><button type="button" onClick={() => showMetric("urine_volume_24h")}><small>24h尿量</small><strong>{formatValue(resultFor("urine_volume_24h")?.value)} <em>L/24h</em></strong><span>检测日期 {selectedReport?.date ?? "—"}</span></button><button type="button" onClick={() => showMetric("urine_glucose")}><small>尿糖 / 用药背景</small><strong>{formatValue(resultFor("urine_glucose")?.value)}</strong><span>需结合达格列净实际用药核对</span></button></div>
        </Panel>

        <Panel title="Lab Results" symbol="▤" action={<select aria-label="筛选化验指标分组" value={group} onChange={(event) => setGroup(event.target.value)}>{["重点指标", "全部指标", ...new Set(data.metrics.map((item) => item.group))].map((value) => <option key={value}>{value}</option>)}</select>}>
          <div className={styles.comparisonWrap} role="region" aria-label="历次化验对照，可横向滚动" tabIndex={0}><table className={styles.comparison}><caption className={styles.srOnly}>各次报告原始数值、单位及参考区间。没有检测的项目显示未测，不填零。</caption><thead><tr><th>指标</th>{reports.map((report) => <th key={report.id}>{report.date}<small>{report.hospital}</small></th>)}<th>详情</th></tr></thead><tbody>{comparisonMetrics.map((item) => <tr key={item.id}><th scope="row">{item.label}</th>{reports.map((report) => {
            const result = report.results.find((row) => row.metricId === item.id);
            return <td key={report.id}><strong data-flag={result?.flag}>{formatValue(result?.value, item.decimals)} {result?.flag === "high" ? "↑" : result?.flag === "low" ? "↓" : ""}<em>{result?.unit}</em></strong><small>{result ? `参考 ${result.reference}` : "未测"}</small></td>;
          })}<td><button type="button" aria-label={`查看${item.label}报告详情`} onClick={() => showMetric(item.id)}>详情 ↗</button></td></tr>)}</tbody></table></div>
          <p className={styles.panelNote}>{reports.length} 次检查 · 当前分组 {comparisonMetrics.length} / 全部 {data.metrics.length} 项指标。参考范围按每次报告保留；新增报告按日期自然扩展，项目未测不填零。</p>
        </Panel>

        <Panel title="To Review" symbol="⊕">
          <div className={styles.alerts}>{data.alerts.map((alert) => <button key={alert.title} type="button" data-tone={alert.tone} onClick={() => source(alert.sourceId, alert.title)}><strong><i />{alert.title}<span>原文 ↗</span></strong><p>{alert.detail}</p></button>)}</div>
        </Panel>
        <Panel title="Follow-up Plan" symbol="▦" action={<button type="button" onClick={() => source(data.followUp.sourceId, "肾功能复查计划")}>详情 ↗</button>}>
          <div className={styles.followUp}><strong>{data.followUp.date}</strong><small>{data.followUp.status}</small><ul>{data.followUp.items.map((item) => <li key={item}>{item}</li>)}</ul></div>
        </Panel>
        <Panel title="Medical Timeline" symbol="⌁" action={<span>全部病史 · 近似记录单独标明</span>}>
          <div className={styles.timeline}>{data.events.map((event, index) => <button type="button" key={`${event.date}-${index}`} data-plan={event.kind === "plan" || undefined} onClick={() => source(event.sourceId, event.title)}><time>{event.date}</time><strong>{event.title}</strong><p>{event.detail}</p></button>)}</div>
        </Panel>
        {data.findings.length > 0 && <Panel title="Other Examinations" symbol="▤"><div className={styles.findings}>{data.findings.map((finding, index) => <article key={`${finding.date}-${index}`}><header><strong>{finding.title}</strong><time>{finding.date}</time><button type="button" onClick={() => source(finding.sourceId, finding.title)}>详情 ↗</button></header><p>{finding.detail}</p></article>)}</div></Panel>}
        <Panel title="Missing Records" symbol="⊕"><ul className={styles.notesList}>{data.profile.missing.map((note) => <li key={note}>{note}</li>)}</ul></Panel>
        <Panel title="Nutrition" symbol="♧" action={<button type="button" onClick={() => source(data.nutrition.sourceId, "饮食与营养")}>详情 ↗</button>}><ul className={styles.notesList}>{data.nutrition.summary.map((note) => <li key={note}>{note}</li>)}</ul></Panel>
      </div>
      <footer className={styles.footer}><p>数据来自本地病历和正式报告，非实时监测。{data.reports.length} 次化验 · {data.documents.length} 份资料 · 仅供记录与复诊沟通，不替代医学诊断。</p><p>{data.emergency.join(" ")}</p><span>本地私有数据 · 只读展示</span></footer>
      {detail && active && <HealthDetails key={`${detail.title}-${detail.sourceId ?? ""}`} data={data} selection={detail} onClose={() => setDetail(null)} />}
    </>}
  </section>;
}

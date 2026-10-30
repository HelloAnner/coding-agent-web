/* eslint-disable @next/next/no-img-element -- Private local report images must bypass the image optimizer/cache. */
import { useId, useLayoutEffect, useRef, useState } from "react";
import { flagLabel, formatValue, type HealthData } from "../model";
import styles from "./father-health.module.css";

export interface DetailSelection {
  title: string;
  sourceId?: string;
  metricId?: string;
  medicationIndex?: number;
  library?: boolean;
}

export function HealthDetails({ data, selection, onClose }: { data: HealthData; selection: DetailSelection; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [sourceId, setSourceId] = useState(selection.sourceId ?? data.profile.sourceId);
  const [query, setQuery] = useState("");
  const document = data.documents.find((row) => row.id === sourceId);
  const metric = data.metrics.find((row) => row.id === selection.metricId);
  const medication = selection.medicationIndex === undefined ? null : data.medications[selection.medicationIndex];
  const readings = metric ? data.reports.flatMap((report) => {
    const result = report.results.find((row) => row.metricId === metric.id);
    return result ? [{ ...report, result }] : [];
  }).sort((a, b) => a.date.localeCompare(b.date)) : [];
  const relatedReports = data.reports.filter((row) => row.sourceId === sourceId);
  const attachmentIds = new Set([document?.attachmentId, ...relatedReports.flatMap((row) => row.attachmentIds)]);
  const attachments = data.attachments.filter((row) => attachmentIds.has(row.id)
    || ((medication || document?.title.includes("用药") || document?.title.includes("体重增加")) && row.kind === "medication")
    || (document?.title.includes("录音") && row.kind === "transcript"));

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  return <dialog ref={dialog} className={styles.drawer} aria-labelledby={`${id}-title`} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={styles.drawerInner}>
      <header className={styles.drawerHeader}><div><span>健康 / 原始资料</span><h2 id={`${id}-title`}>{selection.title}</h2></div><button type="button" onClick={onClose} aria-label="关闭健康详情">×</button></header>
      <div className={styles.drawerBody}>
        {metric && <section className={styles.detailSection}><h3>{metric.label} · 全部正式报告测点</h3><p>{metric.note}</p>
          <table className={styles.detailTable}><thead><tr><th>日期 / 医院</th><th>结果 / 单位</th><th>当次参考区间</th><th>原文</th></tr></thead><tbody>{readings.map((reading) => <tr key={reading.id}><td>{reading.date}<small>{reading.hospital}</small></td><td>{formatValue(reading.result.value, metric.decimals)}<small>{reading.result.unit}</small></td><td>{reading.result.reference}<small>{flagLabel[reading.result.flag]}</small></td><td><button type="button" onClick={() => setSourceId(reading.sourceId)}>查看</button></td></tr>)}</tbody></table>
          {readings.length < 2 && <p>仅有{readings.length}个实测值，不构成连续趋势；未检测的日期不补值。</p>}
        </section>}
        {medication && <section className={styles.detailSection}><h3>{medication.name}</h3><p>{medication.purpose}</p><dl><dt>最后记录</dt><dd>{medication.asOf} · {medication.status === "confirmed" ? "当时确认在服，之后未核实" : "既往方案，当前是否服用待核实"}</dd><dt>剂量 / 频次</dt><dd>{medication.dose}</dd><dt>注意事项</dt><dd>{medication.note}</dd></dl><p>这是既往用药记录，不是当前处方；不据此自行增减或停药。</p></section>}
        {selection.library && <section className={styles.detailSection}><h3>全部资料 · {data.documents.length} 份</h3><input className={styles.archiveSearch} type="search" aria-label="搜索健康资料" placeholder="搜索病历、用药、食谱或原文…" value={query} onChange={(event) => setQuery(event.target.value)} /><div className={styles.documentList}>
          {data.documents.filter((row) => `${row.title} ${row.category} ${row.content}`.toLowerCase().includes(query.toLowerCase())).map((row) => <button type="button" key={row.id} aria-pressed={row.id === sourceId} onClick={() => setSourceId(row.id)}><span>{row.title}</span><small>{row.category}</small></button>)}
        </div></section>}
        {document && <section className={styles.detailSection}><h3>{document.title}</h3><p className={styles.detailCaution}>{document.note}</p><pre className={styles.sourceText}>{document.content}</pre><details className={styles.sourcePath}><summary>查看来源路径</summary>{document.sourcePath}</details></section>}
        <section className={styles.detailSection}><h3>相关附件 · {attachments.length}</h3><div className={styles.attachmentList}>
          {attachments.map((attachment) => {
            const href = `/api/dashboard/father-health/attachments/${encodeURIComponent(attachment.id)}`;
            return <article className={styles.attachment} key={attachment.id}>
              <strong>{attachment.title}</strong><small>{attachment.date ?? "日期未核实"} · {attachment.status === "missing" ? "原文件未找到" : `${Math.ceil(attachment.sizeBytes / 1024)} KB · 已复制到本地 data`}</small>
              {attachment.status === "available" ? <>
                {attachment.mime.startsWith("image/") && <a href={href} target="_blank" rel="noopener noreferrer"><img src={href} alt={attachment.title} loading="lazy" /></a>}
                <a href={href} target="_blank" rel="noopener noreferrer">打开原始{attachment.mime === "application/pdf" ? " PDF" : "文件"} ↗</a>
              </> : <p>仅有文字记录，未伪造或替代原图。</p>}
              <details className={styles.sourcePath}><summary>文件来源与保存位置</summary><div>来源：{attachment.sourcePath}</div><div>本地：{attachment.path ?? "未找到原文件"}</div>{attachment.sha256 && <div>SHA-256：{attachment.sha256}</div>}</details>
            </article>;
          })}
        </div></section>
        {selection.library && <section className={styles.detailSection}><h3>数据核对与缺失说明</h3><ul>{data.provenance.notes.map((note) => <li key={note}>{note}</li>)}</ul><h3>未找到的原文件</h3>{data.attachments.filter((row) => row.status === "missing").map((row) => <p key={row.id}>{row.title}</p>)}</section>}
      </div>
    </div>
  </dialog>;
}

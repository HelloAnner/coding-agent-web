import { useId } from "react";
import { formatValue, type MetricPoint } from "../model";
import styles from "./father-health.module.css";

export function MetricChart({ points, label, decimals = 2, compact = false }: {
  points: MetricPoint[];
  label: string;
  decimals?: number;
  compact?: boolean;
}) {
  const id = useId();
  if (!points.length) return <div className={compact ? styles.sparkEmpty : styles.chartEmpty}>此范围无实测记录</div>;
  const width = compact ? 200 : 800;
  const height = compact ? 35 : 240;
  const left = compact ? 4 : 52;
  const right = width - (compact ? 4 : 28);
  const top = compact ? 5 : 24;
  const bottom = height - (compact ? 4 : 28);
  const values = points.map((point) => point.value);
  const low = Math.max(0, Math.min(...values) - Math.max(1, Math.max(...values) - Math.min(...values)) * 0.4);
  const high = Math.max(low + 1, Math.max(...values) * 1.08);
  const first = Date.parse(points[0].date);
  const last = Date.parse(points.at(-1)!.date);
  const x = (point: MetricPoint) => first === last ? (left + right) / 2 : left + (Date.parse(point.date) - first) / (last - first) * (right - left);
  const y = (value: number) => bottom - (value - low) / (high - low) * (bottom - top);
  return <svg className={compact ? styles.spark : styles.chart} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={id} preserveAspectRatio={compact ? "none" : "xMidYMid meet"}>
    <title id={id}>{`${label}：${points.map((point) => `${point.date} ${formatValue(point.value, decimals)} ${point.unit}（${point.hospital}）`).join("；")}。仅显示实际报告测点，连线不是每日实测数据。`}</title>
    {!compact && [0, 1, 2, 3].map((index) => {
      const value = low + (high - low) * index / 3;
      return <g key={index}><line x1={left} x2={right} y1={y(value)} y2={y(value)} className={styles.gridLine} /><text x={left - 9} y={y(value) + 3} textAnchor="end" className={styles.axis}>{formatValue(value, decimals)}</text></g>;
    })}
    {points.length > 1 && <polyline points={points.map((point) => `${x(point)},${y(point.value)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth={compact ? 1.4 : 1.7} strokeDasharray={compact ? undefined : "4 4"} vectorEffect="non-scaling-stroke" />}
    {points.map((point, index) => <g key={point.reportId}>
      <circle cx={x(point)} cy={y(point.value)} r={compact ? 2.2 : 3.5} fill="currentColor" stroke="white" strokeWidth="1" tabIndex={compact ? undefined : 0} aria-label={`${point.date}，${formatValue(point.value, decimals)} ${point.unit}，${point.hospital}`}><title>{`${point.date} · ${point.hospital} · ${formatValue(point.value, decimals)} ${point.unit}`}</title></circle>
      {!compact && (index % Math.max(1, Math.ceil(points.length / 6)) === 0 || index === points.length - 1) && <>
        <text x={x(point) + (index === 0 ? 7 : index === points.length - 1 ? -7 : 0)} y={y(point.value) - 10} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} className={styles.pointLabel}>{formatValue(point.value, decimals)}</text>
        <text x={x(point)} y={height - 8} textAnchor="middle" className={styles.axis}>{point.date.slice(5)}</text>
      </>}
    </g>)}
  </svg>;
}

export interface HealthMetric {
  id: string;
  label: string;
  shortLabel: string;
  unit: string;
  decimals: number;
  group: string;
  core: boolean;
  note: string;
}

export interface LabResult {
  metricId: string;
  value: number | string;
  unit: string;
  min: number | null;
  max: number | null;
  reference: string;
  flag: "high" | "low" | "normal" | "unclassified";
  note: string;
}

export interface HealthReport {
  id: string;
  date: string;
  hospital: string;
  sourceId: string;
  note: string;
  attachmentIds: string[];
  results: LabResult[];
}

export interface HealthDocument {
  id: string;
  title: string;
  category: string;
  date: string | null;
  sourcePath: string;
  content: string;
  attachmentId: string;
  note: string;
}

export interface HealthAttachment {
  id: string;
  title: string;
  kind: "report" | "medication" | "transcript" | "document";
  date: string | null;
  path: string | null;
  status: "available" | "missing";
  mime: string;
  sourcePath: string;
  sizeBytes: number;
  sha256: string | null;
}

export interface HealthData {
  version: 1;
  updatedAt: string;
  profile: {
    label: string;
    name: string;
    sex: string;
    ageAtLastReport: number;
    summary: string;
    conditions: string[];
    context: string[];
    missing: string[];
    sourceId: string;
  };
  metrics: HealthMetric[];
  reports: HealthReport[];
  events: { date: string; title: string; detail: string; sourceId: string; kind: "history" | "report" | "medication" | "plan" }[];
  medications: { name: string; status: "confirmed" | "unconfirmed"; asOf: string; dose: string; purpose: string; note: string; sourceId: string }[];
  followUp: { date: string; status: string; sourceId: string; items: string[] };
  alerts: { title: string; detail: string; tone: "rust" | "amber" | "teal"; sourceId: string }[];
  emergency: string[];
  nutrition: { sourceId: string; summary: string[] };
  findings: { date: string; title: string; detail: string; sourceId: string }[];
  documents: HealthDocument[];
  attachments: HealthAttachment[];
  provenance: { root: string; notes: string[] };
}

export interface MetricPoint {
  date: string;
  value: number;
  unit: string;
  hospital: string;
  sourceId: string;
  reportId: string;
  result: LabResult;
}

/** Only dated, numeric report results belong on a trend. History/estimates stay in the timeline. */
export function metricSeries(data: Pick<HealthData, "reports">, metricId: string, start = "", end = ""): MetricPoint[] {
  return data.reports.flatMap((report) => {
    if ((start && report.date < start) || (end && report.date > end)) return [];
    const result = report.results.find((row) => row.metricId === metricId);
    return result && typeof result.value === "number" ? [{
      date: report.date, value: result.value, unit: result.unit, hospital: report.hospital,
      sourceId: report.sourceId, reportId: report.id, result,
    }] : [];
  }).sort((a, b) => a.date.localeCompare(b.date));
}

export function metricChange(points: MetricPoint[]): number | null {
  return points.length < 2 ? null : points.at(-1)!.value - points.at(-2)!.value;
}

export function formatValue(value: number | string | undefined, decimals = 2): string {
  return value === undefined ? "—" : typeof value === "string" ? value : value.toLocaleString("zh-CN", { maximumFractionDigits: decimals });
}

export const flagLabel = { high: "↑ 偏高", low: "↓ 偏低", normal: "参考内", unclassified: "未分级" };

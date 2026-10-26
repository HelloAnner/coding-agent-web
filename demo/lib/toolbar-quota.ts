import type { UsageReport } from "./provider-usage";

export const TOOLBAR_QUOTA_PROVIDERS = [
  { id: "openai-codex", name: "Codex" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "kimi-coding", name: "Kimi" },
  { id: "opencode-go", name: "OpenCode" },
] as const;

export function toolbarQuotaValues(report: UsageReport): { label: string; value: string; empty: boolean; resetsAt?: number }[] {
  if (report.providerId === "deepseek") {
    return report.metrics.filter((metric) => metric.id.endsWith("-total") && typeof metric.value === "number")
      .map((metric) => ({ label: metric.currency ?? "", value: `${metric.currency === "CNY" ? "¥" : "$"}${Number(metric.value).toFixed(2)}`, empty: Number(metric.value) <= 0 }));
  }
  // Additional Codex limits belong to other products, not the main Codex quota.
  const buckets = report.buckets.filter((bucket) => report.providerId !== "openai-codex" || bucket.id.startsWith("codex:"));
  return buckets.flatMap((bucket) => {
    const remaining = bucket.remaining ?? (bucket.limit !== undefined && bucket.used !== undefined ? bucket.limit - bucket.used : undefined);
    if (remaining === undefined || !Number.isFinite(remaining) || !bucket.limit || bucket.limit <= 0) return [];
    const percent = Math.max(0, Math.min(100, remaining / bucket.limit * 100));
    return [{
      label: bucket.label,
      value: percent > 0 && percent < 1 ? "<1%" : `${Math.floor(percent)}%`,
      empty: percent === 0,
      resetsAt: bucket.resetsAt,
    }];
  });
}

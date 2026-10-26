import type { ProviderUsageId } from "./provider-usage-ids";

export type UsageUnit = "percent" | "currency" | "count";

export interface UsageBucket {
  id: string;
  label: string;
  groupLabel?: string;
  used?: number;
  remaining?: number;
  limit?: number;
  unit: UsageUnit;
  currency?: string;
  windowMinutes?: number;
  resetsAt?: number;
  period?: string;
}

export interface UsageMetric {
  id: string;
  label: string;
  value: number | string;
  unit?: UsageUnit;
  currency?: string;
}

export interface UsageReport {
  providerId: ProviderUsageId;
  providerName: string;
  capturedAt: number;
  buckets: UsageBucket[];
  metrics: UsageMetric[];
  notes?: string[];
}

export type ProviderUsageResult =
  | { providerId: ProviderUsageId; status: "ready"; report: UsageReport }
  | { providerId: ProviderUsageId; status: "auth-unavailable" | "query-failed"; message: string };


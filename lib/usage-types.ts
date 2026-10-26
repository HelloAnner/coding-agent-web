export type UsageHarness = "pi" | "dsh" | "grok" | "claude-code";

export interface UsageMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Sum of recorded USD costs only; null when no request has a recorded cost. Never a price estimate. */
  cost: number | null;
  costKnownRequests: number;
  costUnknownRequests: number;
  requests: number;
  messages: number;
  toolCalls: number;
  sessions: number;
  errors: number;
}

export interface UsageBucket extends UsageMetrics {
  day: string;
  /** 0..23 for hourly buckets; -1 for independently aggregated daily dimension buckets. */
  hour: number;
  harness: UsageHarness;
  model: string | null;
  provider: string | null;
  /** Opaque stable session keys for distinct unions across filtered buckets. */
  sessionIds: string[];
}

export interface UsageDaySummary extends UsageMetrics {
  day: string;
}

export interface UsageRoot {
  harness: UsageHarness;
  /** Session directory (searched recursively), or an individual session file. */
  path: string;
  /** Profile attribution fallback; transcript values take precedence. */
  provider?: string;
  model?: string;
}

export interface UsageSourceDiagnostic {
  harness: UsageHarness;
  root: string;
  files: number;
  records: number;
  duplicates: number;
  invalidRecords: number;
  missingTimestamps: number;
  unreadableFiles: number;
  /** Stable diagnostic codes only; never transcript text, credentials, or raw parse errors. */
  limitations: string[];
}

export interface UsageSnapshot {
  schemaVersion: 1;
  collectedAt: string;
  timeZone: string;
  startDay: string | null;
  endDay: string | null;
  /** False on an unreadable source or discovery/decompression failure. Skipped bad records are diagnosed. */
  complete: boolean;
  days: UsageDaySummary[];
  /** Includes BOTH hour=-1 daily buckets and 0..23 hourly buckets. Never sum both sets. */
  buckets: UsageBucket[];
  diagnostics: UsageSourceDiagnostic[];
}

export interface CollectUsageOptions {
  /** Inclusive local calendar dates YYYY-MM-DD; omitted bounds scan all history. */
  startDay?: string;
  endDay?: string;
  /** Additional session roots; default roots are also scanned unless discoverDefaults=false. */
  roots?: UsageRoot[];
  discoverDefaults?: boolean;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** IANA time zone; defaults to the host's local time zone. */
  timeZone?: string;
  signal?: AbortSignal;
}

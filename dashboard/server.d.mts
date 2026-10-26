// Types for the Next adapter only. The dashboard UI does not import them.

export interface DashboardOverview {
  app: "dashboard";
  generatedAt: string;
  serverStartedAt: string;
  serverUptimeSeconds: number;
  processUptimeSeconds: number;
  requestsServed: number;
  memory: {
    usedBytes: number;
    totalBytes: number;
    percent: number;
  };
  load: number[];
  host: {
    hostname: string;
    platform: string;
    release: string;
    arch: string;
    cpuCount: number;
    node: string;
    uptimeSeconds: number;
  };
}

export function dashboardOverview(): DashboardOverview;

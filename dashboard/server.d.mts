// Types for the Next adapters only. The dashboard itself does not import them.

import type { Server } from "node:http";

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

export interface DashboardServerOptions {
  port?: number;
  host?: string;
}

export function dashboardOverview(): DashboardOverview;
export function dashboardPage(): Promise<string>;
export function startDashboardServer(options?: DashboardServerOptions): Server;

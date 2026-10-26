// The dashboard's own backend. It knows nothing about the coding agent: only
// the host's figures, kept by this module, and its own board definitions.

import os from "node:os";

const startedAt = Date.now();
let requestsServed = 0;

/** What the dashboard shows. Its shape belongs to this app alone. */
export function dashboardOverview() {
  requestsServed += 1;
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  return {
    app: "dashboard",
    generatedAt: new Date().toISOString(),
    serverStartedAt: new Date(startedAt).toISOString(),
    serverUptimeSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
    processUptimeSeconds: Math.round(process.uptime()),
    requestsServed,
    memory: {
      usedBytes,
      totalBytes,
      percent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    },
    load: os.loadavg().map((value) => Math.round(value * 100) / 100),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      node: process.version,
      uptimeSeconds: Math.round(os.uptime()),
    },
  };
}

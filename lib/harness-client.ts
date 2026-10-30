import { agentStatusUrl } from "./agent-client";

/** Transport selection only; each harness owns its state and request behavior. */
export function runtimeStatusUrl(harness: string, id: string): string {
  if (harness === "omp" || harness === "claude-code" || harness === "grok" || harness === "dsh") return `/api/${harness}/${encodeURIComponent(id)}?state=1`;
  return agentStatusUrl(id);
}

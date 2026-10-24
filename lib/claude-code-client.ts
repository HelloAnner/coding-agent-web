import type { AgentMessage } from "./types";
import { agentStatusUrl } from "./agent-client";

export { newGrokSessionId as newClaudeSessionId } from "./grok-client";
export function claudeSessionUrl(id: string): string { return `/api/claude-code/${encodeURIComponent(id)}`; }
export function claudeEventsUrl(id: string): string { return `${claudeSessionUrl(id)}/events`; }
export function runtimeStatusUrl(harness: string, id: string): string { return harness === "claude-code" ? `${claudeSessionUrl(id)}?state=1` : agentStatusUrl(id); }

export class ClaudeTrustRequiredError extends Error {
  constructor(readonly cwd: string) { super(`Trust this Claude Code project: ${cwd}`); }
}

export async function sendClaudeCommand<T = unknown>(id: string, command: Record<string, unknown>): Promise<T> {
  const response = await fetch(claudeSessionUrl(id), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
  const body = await response.json().catch(() => ({})) as { data?: T; error?: string; requiresTrust?: boolean; cwd?: string };
  if (body.requiresTrust) throw new ClaudeTrustRequiredError(body.cwd ?? "");
  if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body.data as T;
}

function nativeId(message: AgentMessage): string | undefined { return (message as AgentMessage & { nativeId?: string }).nativeId; }

/** A native message can arrive both as streaming deltas and as an authoritative frame. */
export function upsertClaudeMessage(messages: AgentMessage[], message: AgentMessage): AgentMessage[] {
  const id = nativeId(message);
  const index = id ? messages.findIndex((existing) => nativeId(existing) === id) : -1;
  return index < 0 ? [...messages, message] : messages.map((existing, i) => i === index ? message : existing);
}

export function mergeClaudeHistory(history: AgentMessage[], current: AgentMessage[]): AgentMessage[] {
  const ids = new Set(history.map(nativeId));
  return [...history, ...current.filter((message) => { const id = nativeId(message); return id && !ids.has(id); })];
}

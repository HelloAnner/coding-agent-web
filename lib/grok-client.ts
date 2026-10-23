// Client-side helpers for the grok runtime (app/api/grok/[id]).
//
// The command envelope is the same one /api/agent/[id] uses, so the send path
// in hooks/useAgentSession.ts reads the same on both transports:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)

export function grokSessionUrl(sessionId: string, cwd: string): string {
  return `/api/grok/${encodeURIComponent(sessionId)}?cwd=${encodeURIComponent(cwd)}`;
}

/**
 * A UUID v4 for grok's `-s` (it refuses anything else).
 *
 * `crypto.randomUUID` only exists in a secure context, and this app is opened
 * over plain HTTP on the LAN, where it is undefined. `getRandomValues` is not
 * gated that way.
 */
export function newGrokSessionId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function grokEventsUrl(sessionId: string, model?: string | null): string {
  const base = `/api/grok/${encodeURIComponent(sessionId)}/events`;
  return model ? `${base}?model=${encodeURIComponent(model)}` : base;
}

export async function sendGrokCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`/api/grok/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
  };
  if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.data as T;
}

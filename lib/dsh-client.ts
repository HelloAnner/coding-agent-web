// Client-side helpers for the dsh runtime (app/api/dsh/[id]).
//
// The command envelope is the same one /api/agent/[id] uses, so the send path
// in hooks/useAgentSession.ts reads the same on both transports:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)

export function dshEventsUrl(sessionId: string): string {
  return `/api/dsh/${encodeURIComponent(sessionId)}/events`;
}

/** The transcript lives in the kernel's session directory, not behind a cwd. */
export function dshSessionUrl(sessionId: string, sessionPath: string): string {
  return `/api/dsh/${encodeURIComponent(sessionId)}?path=${encodeURIComponent(sessionPath)}`;
}

/** A web-side id for one dsh chat. The kernel picks its own session id. */
export function newDshSessionId(): string {
  return `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function sendDshCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`/api/dsh/${encodeURIComponent(sessionId)}`, {
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

export function ompSessionUrl(id: string): string { return `/api/omp/${encodeURIComponent(id)}`; }
export function ompEventsUrl(id: string): string { return `${ompSessionUrl(id)}/events`; }
export function newOmpId(): string {
  // getRandomValues works on LAN HTTP, where randomUUID is unavailable.
  return `omp-${Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16).padStart(8, "0")).join("")}`;
}
export class OmpClientError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "OmpClientError"; }
}
export async function sendOmpCommand<T = unknown>(id: string, command: Record<string, unknown>): Promise<T> {
  const response = await fetch(ompSessionUrl(id), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
  const body = await response.json().catch(() => ({})) as { success?: boolean; data?: T; error?: string };
  if (!response.ok || body?.error) throw new OmpClientError(body?.error ?? `HTTP ${response.status}`, response.status);
  if (body?.success !== true) throw new TypeError("Invalid response from OMP; send acceptance is unconfirmed");
  return body.data as T;
}

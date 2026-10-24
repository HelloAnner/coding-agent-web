"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClaudeTask, ClaudeTaskDetail, ClaudeTaskSnapshot } from "../tasks";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status });
  return body;
}

/** Two resources use the same visible-page, single-flight polling lifecycle. */
function poll(load: (signal: AbortSignal) => Promise<boolean>, onError: (error: string) => void) {
  let stopped = false;
  let queued = false;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => document.visibilityState !== "hidden";
  const refresh = async () => {
    clearTimeout(timer);
    if (stopped || !visible()) return;
    if (controller) { queued = true; return; }
    const current = new AbortController();
    controller = current;
    let repeat = false;
    try { repeat = await load(current.signal); }
    catch (error) {
      if (!current.signal.aborted) {
        onError(error instanceof Error ? error.message : String(error));
        const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
        repeat = !status || status >= 500 || status === 408 || status === 429;
      }
    } finally {
      controller = null;
      if (!stopped) {
        if (queued && visible()) { queued = false; void refresh(); }
        else if (!current.signal.aborted && repeat) timer = setTimeout(() => void refresh(), 2000);
      }
    }
  };
  const wake = () => { if (visible()) void refresh(); else { queued = false; clearTimeout(timer); controller?.abort(); } };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("focus", wake);
  void refresh();
  return { refresh: () => { void refresh(); }, stop: () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", wake); window.removeEventListener("focus", wake); } };
}

export function useClaudeTasks(sessionId: string, active: boolean) {
  const [snapshot, setSnapshot] = useState<ClaudeTaskSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClaudeTaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const generation = useRef(0);
  const refreshRef = useRef(() => {});
  const detailRefreshRef = useRef(() => {});
  const url = `/api/claude-code/${encodeURIComponent(sessionId)}/tasks`;

  useEffect(() => {
    generation.current += 1;
    setSnapshot(null); setSelectedId(null); setDetail(null); setError(null); setDetailError(null); setActionError(null); setPending(null);
    return () => { generation.current += 1; };
  }, [sessionId]);

  useEffect(() => {
    const watcher = poll(async (signal) => {
      const data = await request<ClaudeTaskSnapshot>(url, { signal });
      if (signal.aborted) return false;
      setSnapshot(data); setError(null);
      return data.connected || active;
    }, setError);
    refreshRef.current = watcher.refresh;
    return watcher.stop;
  }, [url, active]);

  const selected = snapshot?.tasks.find((task) => task.id === selectedId);
  const runId = selected?.runId;
  const taskStatus = selected?.status;
  const connected = snapshot?.connected ?? false;
  useEffect(() => {
    setDetail(null); setDetailError(null);
    if (!selectedId || !taskStatus) return;
    const query = new URLSearchParams({ task: selectedId });
    if (runId) query.set("run", runId);
    const watcher = poll(async (signal) => {
      const data = await request<ClaudeTaskDetail>(`${url}?${query}`, { signal });
      if (signal.aborted) return false;
      setDetail(data); setDetailError(null);
      return connected && ["pending", "running", "paused"].includes(taskStatus);
    }, setDetailError);
    detailRefreshRef.current = watcher.refresh;
    return () => { watcher.stop(); detailRefreshRef.current = () => {}; };
  }, [url, selectedId, runId, taskStatus, connected]);

  const act = useCallback(async (task: ClaudeTask, action: "stop" | "background") => {
    const version = generation.current;
    setPending(task.id); setActionError(null);
    try {
      await request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, taskId: task.id, runId: task.runId }) });
    } catch (error) {
      if (generation.current === version) setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation.current === version) { setPending(null); refreshRef.current(); }
    }
  }, [url]);

  const select = useCallback((id: string | null) => { setSelectedId(id); setDetail(null); setDetailError(null); }, []);
  const currentDetail = detail?.task.id === selectedId && detail?.task.runId === runId ? detail : null;
  return { snapshot, selectedId, select, detail: currentDetail, error, detailError, actionError, pending, act, refresh: () => { refreshRef.current(); detailRefreshRef.current(); } };
}

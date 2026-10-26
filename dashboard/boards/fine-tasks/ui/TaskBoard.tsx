"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { FineTask, FineTaskSnapshot } from "../types";
import "./task-board.css";

const POLL_INTERVAL_MS = 30_000;
const DAY_MS = 86_400_000;
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
const columns = [
  { key: "title", label: "任务" },
  { key: "createdAt", label: "创建时间" },
  { key: "testers", label: "测试人员" },
  { key: "version", label: "版本" },
  { key: "priority", label: "优先级" },
  { key: "daysInHand", label: "在手天数" },
  { key: "status", label: "状态" },
  { key: "category", label: "分类" },
] as const;
type SortKey = typeof columns[number]["key"];
type Sort = { key: SortKey; direction: "ascending" | "descending" };

export function safeTaskUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function taskDaysInHand(task: FineTask, now: number): number | null {
  return task.assignedAt !== null && Number.isFinite(task.assignedAt)
    ? Math.max(0, Math.floor((now - task.assignedAt) / DAY_MS)) : null;
}

function sortValue(task: FineTask, key: SortKey, now: number): string | number | null {
  switch (key) {
    case "daysInHand": return taskDaysInHand(task, now);
    case "testers": return task.testers.join("、") || null;
    case "priority": return task.priority && Number.isFinite(task.priorityRank) ? task.priorityRank : null;
    default: return task[key] === "" ? null : task[key];
  }
}

export function visibleTasks(tasks: FineTask[], search: string, status: string, category: string, sort: Sort, now: number): FineTask[] {
  const query = search.trim().toLocaleLowerCase("zh-CN");
  return tasks.filter((task) =>
    (!status || task.status === status) && (!category || task.category === category) &&
    (!query || [task.title, task.id, task.version, task.priority, task.status, task.category,
      ...task.testers, task.description, ...task.fields.flatMap((field) => [field.name, field.value])]
      .some((value) => value.toLocaleLowerCase("zh-CN").includes(query))),
  ).sort((a, b) => {
    const left = sortValue(a, sort.key, now);
    const right = sortValue(b, sort.key, now);
    // Missing values stay last in both directions.
    if (left === null || right === null) return left === right ? collator.compare(a.id, b.id) : left === null ? 1 : -1;
    const compared = typeof left === "number" && typeof right === "number"
      ? left - right : collator.compare(String(left), String(right));
    return (sort.direction === "ascending" ? compared : -compared) || collator.compare(a.id, b.id);
  });
}

function formatDate(value: number | null): string {
  return value !== null && Number.isFinite(value) ? dateFormat.format(value) : "—";
}

function filterOptions(tasks: FineTask[], key: "status" | "category"): string[] {
  return [...new Set(tasks.map((task) => task[key]).filter(Boolean))].sort(collator.compare);
}

export function TaskBoard({ active }: { active: boolean }) {
  const [snapshot, setSnapshot] = useState<FineTaskSnapshot | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "createdAt", direction: "descending" });
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<FineTask | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ id: string; message: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const ids = useId();

  const load = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setRequestError(null);
    try {
      const response = await fetch("/api/dashboard/tasks", { method: "GET", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
      const data: FineTaskSnapshot = await response.json();
      if (!data || !Array.isArray(data.tasks) || typeof data.syncing !== "boolean") {
        throw new Error("任务数据格式错误");
      }
      if (!controller.signal.aborted) {
        setSnapshot(data);
        setNow(Date.now());
      }
    } catch (error) {
      if (!controller.signal.aborted) setRequestError(error instanceof Error ? error.message : "任务加载失败");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(false);
      }
    }
  }, []);

  useEffect(() => {
    // This view only reads the database; scheduled synchronization runs on the server.
    void load();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [load]);

  useEffect(() => {
    if (!active) return;
    void load();
    const interval = window.setInterval(() => {
      setNow(Date.now());
      void load();
    }, POLL_INTERVAL_MS);
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [active, load]);

  useEffect(() => {
    const modal = dialog.current;
    if (selected && active) {
      if (!modal?.open) modal?.showModal();
    } else if (modal?.open) {
      modal.close();
    }
  }, [selected, active]);

  useEffect(() => {
    if (!selected || !active) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || !dialog.current?.open) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dialog.current.close();
      setSelected(null);
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [selected, active]);

  useEffect(() => {
    if (!copyFeedback) return;
    const timer = window.setTimeout(() => setCopyFeedback(null), 3500);
    return () => window.clearTimeout(timer);
  }, [copyFeedback]);

  const tasks = snapshot?.tasks;
  const rows = useMemo(() => visibleTasks(tasks ?? [], search, status, category, sort, now), [tasks, search, status, category, sort, now]);
  const statuses = useMemo(() => filterOptions(tasks ?? [], "status"), [tasks]);
  const categories = useMemo(() => filterOptions(tasks ?? [], "category"), [tasks]);
  const currentTask = selected ? tasks?.find((task) => task.id === selected.id) ?? selected : null;
  const originalUrl = currentTask ? safeTaskUrl(currentTask.url) : null;
  const syncing = snapshot?.syncing === true;
  const error = requestError || snapshot?.error;

  async function copyUrl(task: FineTask) {
    const url = safeTaskUrl(task.url);
    try {
      if (!url || !navigator.clipboard?.writeText) throw new Error("无法复制链接");
      await navigator.clipboard.writeText(url);
      setCopyFeedback({ id: task.id, message: "链接已复制" });
    } catch {
      setCopyFeedback({ id: task.id, message: "复制失败，请在详情中打开原任务" });
    }
  }

  function toggleSort(key: SortKey) {
    setSort((current) => ({ key, direction: current.key === key && current.direction === "ascending" ? "descending" : "ascending" }));
  }

  return (
    <section className="task-board" hidden={!active} aria-label="任务表">
      <div className="task-board-toolbar">
        <label className="task-board-search">
          <span className="task-board-sr-only">搜索任务</span>
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务" />
        </label>
        <label>
          <span className="task-board-sr-only">按状态筛选</span>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">全部状态</option>
            {[...new Set([...statuses, ...(status ? [status] : [])])].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>
          <span className="task-board-sr-only">按分类筛选</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">全部分类</option>
            {[...new Set([...categories, ...(category ? [category] : [])])].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <button type="button" className="task-board-button" onClick={() => void load()} disabled={pending} aria-busy={pending}>
          {pending ? "读取中…" : "刷新"}
        </button>
      </div>
      <div className="task-board-meta" role="status">
        <span>{snapshot ? `${rows.length} 项任务` : pending ? "正在读取任务…" : "尚未加载任务"}</span>
        <span>{snapshot?.lastSyncedAt != null ? `上次同步 ${formatDate(snapshot.lastSyncedAt)}` : "尚未同步"}{syncing ? " · 同步中…" : ""}</span>
        <span>每 30 秒刷新页面数据 · 每 10 分钟同步 Meegle</span>
      </div>
      {error && <p className="task-board-error" role="alert">{error}</p>}
      <div className="task-board-table-wrap" tabIndex={0} role="region" aria-label="任务表，可横向滚动" aria-busy={pending || syncing}>
        <table className="task-board-table">
          <caption className="task-board-sr-only">任务列表，点击列标题排序，点击任务名称查看详情</caption>
          <thead>
            <tr>{columns.map(({ key, label }) => (
              <th key={key} scope="col" aria-sort={sort.key === key ? sort.direction : "none"}>
                <button type="button" onClick={() => toggleSort(key)}>
                  {label}<span aria-hidden="true">{sort.key === key ? sort.direction === "ascending" ? "↑" : "↓" : "↕"}</span>
                </button>
              </th>
            ))}<th scope="col" className="task-board-actions"><span className="task-board-sr-only">复制链接</span></th></tr>
          </thead>
          <tbody>
            {rows.map((task) => (
              <tr key={task.id}>
                <td className="task-board-title-cell">
                  <button type="button" className="task-board-task-title" onClick={() => setSelected(task)} aria-haspopup="dialog">{task.title || "未命名任务"}</button>
                </td>
                <td>{formatDate(task.createdAt)}</td>
                <td>{task.testers.join("、") || "—"}</td>
                <td>{task.version || "—"}</td>
                <td>{task.priority || "—"}</td>
                <td className="task-board-number">{taskDaysInHand(task, now) ?? "—"}</td>
                <td>{task.status || "—"}</td>
                <td>{task.category || "—"}</td>
                <td className="task-board-actions">
                  <button type="button" className="task-board-copy" onClick={() => void copyUrl(task)} aria-label={`复制任务链接：${task.title || task.id}`} title="复制链接" disabled={!safeTaskUrl(task.url)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>
                  </button>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={columns.length + 1} className="task-board-empty">
              {!snapshot ? pending ? "正在加载任务…" : "任务加载失败，请重试" : tasks?.length ? "没有符合筛选条件的任务" : syncing ? "正在同步任务…" : "暂无任务"}
            </td></tr>}
          </tbody>
        </table>
      </div>
      <p className="task-board-copy-feedback" role="status" aria-live="polite" aria-atomic="true">{copyFeedback?.message ?? ""}</p>
      <dialog ref={dialog} className="task-board-dialog" aria-labelledby={`${ids}-title`} onClose={() => setSelected(null)}>
        {currentTask && <>
          <header className="task-board-dialog-header">
            <h2 id={`${ids}-title`}>{currentTask.title || "未命名任务"}</h2>
            <button type="button" className="task-board-button" autoFocus onClick={() => dialog.current?.close()}>关闭</button>
          </header>
          <div className="task-board-dialog-body">
            <dl className="task-board-fields">
              {[
                ["状态", currentTask.status], ["分类", currentTask.category], ["优先级", currentTask.priority],
                ["测试人员", currentTask.testers.join("、")], ["版本", currentTask.version],
                ["创建时间", formatDate(currentTask.createdAt)], ["分配时间", formatDate(currentTask.assignedAt)],
                ["在手天数", String(taskDaysInHand(currentTask, now) ?? "—")],
              ].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value || "—"}</dd></div>)}
            </dl>
            <h3>任务描述</h3>
            <p className="task-board-description">{currentTask.description || "暂无描述"}</p>
            {!!currentTask.fields.length && <>
              <h3>字段详情</h3>
              <dl className="task-board-fields">{currentTask.fields.map((field, index) => <div key={`${field.name}-${index}`}><dt>{field.name}</dt><dd>{field.value || "—"}</dd></div>)}</dl>
            </>}
          </div>
          <footer className="task-board-dialog-footer">
            {originalUrl ? <a className="task-board-button" href={originalUrl} target="_blank" rel="noopener noreferrer">打开原任务</a> : <span>原任务链接不可用</span>}
          </footer>
        </>}
      </dialog>
    </section>
  );
}

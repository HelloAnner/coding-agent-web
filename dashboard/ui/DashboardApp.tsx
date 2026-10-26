import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppSwitcher } from "@/components/AppSwitcher";
import { TaskBoard } from "../boards/fine-tasks/ui/TaskBoard";
import type { WebApp } from "@/lib/apps";
import {
  DASHBOARD_BOARDS,
  DASHBOARD_GROUPS,
  dashboardBoardForId,
  type DashboardBoard,
  type DashboardBoardId,
} from "../boards";

interface Overview {
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

type Status = "connecting" | "live" | "offline";

const clockFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad(seconds % 60)}s`;
  return `${seconds}s`;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, Number(bytes) || 0);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function formatClock(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : clockFormat.format(date);
}

function sparkPath(values: readonly number[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) {
    const y = 58 - (values[0] / 100) * 52;
    return `M0 ${y.toFixed(1)}L300 ${y.toFixed(1)}`;
  }
  return `M${values.map((value, index) => {
    const x = (index / (values.length - 1)) * 300;
    const y = 58 - (value / 100) * 52;
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join("L")}`;
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`session-tree-chevron${open ? " is-open" : ""}`}
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function MetricCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <article className="dashboard-card">
      <span className="dashboard-card-label">{label}</span>
      <strong>{value}</strong>
      <span className="dashboard-card-note">{note}</span>
    </article>
  );
}

function MemoryPanel({ overview, history }: { overview: Overview; history: readonly number[] }) {
  const { memory } = overview;
  const freeBytes = memory.totalBytes - memory.usedBytes;
  return (
    <article className="dashboard-panel">
      <header>
        <h2>Memory</h2>
        <span>{memory.percent.toFixed(1)}%</span>
      </header>
      <div className="dashboard-bar" role="img" aria-label={`${memory.percent.toFixed(1)} percent of memory in use`}>
        <div
          className={`dashboard-bar-fill${memory.percent >= 90 ? " is-bad" : memory.percent >= 70 ? " is-warn" : ""}`}
          style={{ width: `${Math.max(0, Math.min(100, memory.percent))}%` }}
        />
      </div>
      <p className="dashboard-panel-note">
        {formatBytes(memory.usedBytes)} used · {formatBytes(freeBytes)} free of {formatBytes(memory.totalBytes)}
      </p>
      <svg className="dashboard-spark" viewBox="0 0 300 60" preserveAspectRatio="none" aria-hidden="true">
        <path d={sparkPath(history)} vectorEffect="non-scaling-stroke" />
      </svg>
    </article>
  );
}

function LoadPanel({ overview }: { overview: Overview }) {
  const cores = Math.max(1, overview.host.cpuCount);
  return (
    <article className="dashboard-panel">
      <header>
        <h2>Load average</h2>
        <span>{cores} {cores === 1 ? "core" : "cores"}</span>
      </header>
      {overview.load.map((value, index) => {
        const percent = Math.max(0, Math.min(100, (value / cores) * 100));
        return (
          <div className="dashboard-load-row" key={index}>
            <span>{["1m", "5m", "15m"][index]}</span>
            <div className="dashboard-bar">
              <div
                className={`dashboard-bar-fill${percent >= 90 ? " is-bad" : percent >= 70 ? " is-warn" : ""}`}
                style={{ width: `${percent}%` }}
              />
            </div>
            <strong>{value.toFixed(2)}</strong>
          </div>
        );
      })}
      <p className="dashboard-panel-note">Bars scale to the number of CPU cores.</p>
    </article>
  );
}

function HostPanel({ overview }: { overview: Overview }) {
  const rows: [string, string][] = [
    ["Hostname", overview.host.hostname],
    ["Platform", `${overview.host.platform} ${overview.host.release}`],
    ["Architecture", overview.host.arch],
    ["Node", overview.host.node],
    ["CPU cores", String(overview.host.cpuCount)],
    ["Host uptime", formatDuration(overview.host.uptimeSeconds)],
  ];
  return (
    <article className="dashboard-panel dashboard-host-panel">
      <header>
        <h2>Host</h2>
        <span>read-only</span>
      </header>
      <dl className="dashboard-host-grid">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd title={value}>{value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function BoardContent({ boardId, overview, history }: {
  boardId: DashboardBoardId;
  overview: Overview | null;
  history: readonly number[];
}) {
  if (!overview) {
    return <div className="dashboard-empty">Waiting for the dashboard backend…</div>;
  }

  const cores = Math.max(1, overview.host.cpuCount);
  const freeBytes = overview.memory.totalBytes - overview.memory.usedBytes;

  if (boardId === "memory") {
    return (
      <>
        <section className="dashboard-cards" aria-label="Memory metrics">
          <MetricCard label="Memory in use" value={`${overview.memory.percent.toFixed(1)}%`} note={`${formatBytes(overview.memory.usedBytes)} of ${formatBytes(overview.memory.totalBytes)}`} />
          <MetricCard label="Free" value={formatBytes(freeBytes)} note="available to the host" />
          <MetricCard label="Total" value={formatBytes(overview.memory.totalBytes)} note="physical memory" />
        </section>
        <section className="dashboard-panels">
          <MemoryPanel overview={overview} history={history} />
        </section>
      </>
    );
  }

  if (boardId === "load") {
    return (
      <>
        <section className="dashboard-cards" aria-label="Load metrics">
          {overview.load.map((value, index) => (
            <MetricCard key={index} label={`Load ${["1m", "5m", "15m"][index]}`} value={value.toFixed(2)} note={`of ${cores} ${cores === 1 ? "core" : "cores"}`} />
          ))}
          <MetricCard label="CPU cores" value={String(cores)} note={overview.host.node} />
        </section>
        <section className="dashboard-panels">
          <LoadPanel overview={overview} />
        </section>
      </>
    );
  }

  if (boardId === "host") {
    return (
      <>
        <section className="dashboard-cards" aria-label="Host metrics">
          <MetricCard label="Hostname" value={overview.host.hostname} note={overview.host.arch} />
          <MetricCard label="Host uptime" value={formatDuration(overview.host.uptimeSeconds)} note="since boot" />
          <MetricCard label="CPU cores" value={String(cores)} note={overview.host.node} />
        </section>
        <section className="dashboard-panels">
          <HostPanel overview={overview} />
        </section>
      </>
    );
  }

  if (boardId === "requests") {
    return (
      <>
        <section className="dashboard-cards" aria-label="Request metrics">
          <MetricCard label="Requests served" value={new Intl.NumberFormat().format(overview.requestsServed)} note="by this backend" />
          <MetricCard label="Server uptime" value={formatDuration(overview.serverUptimeSeconds)} note={`since ${formatClock(overview.serverStartedAt)}`} />
          <MetricCard label="Process uptime" value={formatDuration(overview.processUptimeSeconds)} note="Node process" />
        </section>
        <section className="dashboard-panels">
          <article className="dashboard-panel">
            <header>
              <h2>Requests</h2>
              <span>live</span>
            </header>
            <p className="dashboard-panel-note">
              Each dashboard refresh asks this app&apos;s own backend for one overview.
              The counter lives in the backend and resets when it restarts.
            </p>
          </article>
        </section>
      </>
    );
  }

  return (
    <>
      <section className="dashboard-cards" aria-label="System metrics">
        <MetricCard label="Server uptime" value={formatDuration(overview.serverUptimeSeconds)} note={`since ${formatClock(overview.serverStartedAt)}`} />
        <MetricCard label="Host uptime" value={formatDuration(overview.host.uptimeSeconds)} note="since boot" />
        <MetricCard label="Requests served" value={new Intl.NumberFormat().format(overview.requestsServed)} note="by this backend" />
        <MetricCard label="Memory in use" value={`${overview.memory.percent.toFixed(1)}%`} note={`${formatBytes(overview.memory.usedBytes)} of ${formatBytes(overview.memory.totalBytes)}`} />
        <MetricCard label="Load 1m" value={overview.load[0].toFixed(2)} note={`of ${cores} ${cores === 1 ? "core" : "cores"}`} />
        <MetricCard label="CPU cores" value={String(cores)} note={overview.host.node} />
      </section>
      <section className="dashboard-panels">
        <MemoryPanel overview={overview} history={history} />
        <LoadPanel overview={overview} />
      </section>
    </>
  );
}

/**
 * The dashboard app inside the shell: the shell's brand and a tree of boards
 * on the left, the selected board on the right. Both apps stay mounted, so
 * switching between them is instant and loses no state.
 */
export function DashboardApp({
  active,
  currentApp,
  onSwitchApp,
}: {
  active: boolean;
  currentApp: WebApp;
  onSwitchApp: (app: WebApp) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The board shown is kept locally so the switch is immediate even while the
  // route catches up; the URL is the source when the dashboard route changes.
  const urlBoard = dashboardBoardForId(searchParams.get("board"));
  const [boardId, setBoardId] = useState<DashboardBoardId>(urlBoard.id);
  const board = dashboardBoardForId(boardId);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ system: true, machine: true });
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [history, setHistory] = useState<number[]>([]);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const response = await fetch("/api/dashboard/overview", {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json() as Overview;
      setOverview(next);
      setStatus("live");
      setHistory((values) => [...values, next.memory.percent].slice(-60));
    } catch {
      setStatus("offline");
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  // One fetch while hidden, so the first switch already has figures; then
  // poll only while the dashboard is the app in view.
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  useEffect(() => {
    if (!active) setSidebarOpen(false);
  }, [active]);

  // On the dashboard route the URL wins (a reload, a link, Back/Forward).
  // While the coding route is in view, its session query must not reset the
  // board the dashboard will show on its next switch.
  useEffect(() => {
    if (!pathname?.startsWith("/dashboard")) return;
    setBoardId(urlBoard.id);
  }, [pathname, urlBoard.id]);

  // The URL carries the board, so a reload (or a shared link) opens the same
  // one. replace: board picks do not add history entries.
  const selectBoard = (next: DashboardBoard) => {
    setBoardId(next.id);
    setSidebarOpen(false);
    const url = next.id === "overview" ? "/dashboard" : `/dashboard?board=${next.id}`;
    router.replace(url, { scroll: false });
  };

  const normalizedQuery = query.trim().toLowerCase();
  const groups = useMemo(
    () => DASHBOARD_GROUPS
      .map((group) => ({
        ...group,
        boards: group.boards.filter((item) => !normalizedQuery || `${group.parentLabel ?? ""} ${group.label} ${item.label}`.toLowerCase().includes(normalizedQuery)),
      }))
      .filter((group) => group.boards.length > 0),
    [normalizedQuery],
  );

  const metaFor = (item: DashboardBoard): string => {
    if (item.id === "fine-tasks") return "Meegle";
    if (!overview) return "—";
    if (item.id === "memory") return `${overview.memory.percent.toFixed(1)}%`;
    if (item.id === "load") return overview.load[0].toFixed(2);
    if (item.id === "requests") return new Intl.NumberFormat().format(overview.requestsServed);
    if (item.id === "host") return "read-only";
    return "live";
  };

  const statusText = status === "live" ? "Live" : status === "offline" ? "Offline" : "Connecting";

  return (
    <div
      className="dashboard-app"
      role="region"
      aria-label="Dashboard"
      aria-hidden={!active}
      hidden={!active}
    >
      <aside className={`dashboard-sidebar${sidebarOpen ? " is-open" : ""}`} aria-label="Dashboards">
        <div className="sidebar-header">
          <AppSwitcher current={currentApp} onSwitch={onSwitchApp} />
          <span className="sidebar-header-spacer" />
          <button
            type="button"
            className="sidebar-search-toggle"
            title="Refresh"
            aria-label="Refresh"
            onClick={() => void refresh()}
          >
            <RefreshIcon />
          </button>
          <button
            type="button"
            className={`sidebar-search-toggle${searchOpen ? " is-active" : ""}`}
            title="Search dashboards"
            aria-label="Search dashboards"
            aria-expanded={searchOpen}
            aria-controls="dashboard-search-input"
            onClick={() => setSearchOpen((open) => !open)}
          >
            <SearchIcon />
          </button>
        </div>

        {searchOpen && (
          <div className="sidebar-search">
            <input
              id="dashboard-search-input"
              type="search"
              autoFocus
              value={query}
              aria-label="Search dashboards"
              placeholder="Search dashboards…"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
              className="sidebar-search-input"
            />
          </div>
        )}

        <div className="session-tree dashboard-tree">
          <div className="session-tree-scroll">
            <div className="session-tree-inner">
              {groups.map((group) => {
                const expanded = normalizedQuery.length > 0 || openGroups[group.id] !== false;
                return (
                  <div key={group.id}>
                    {group.parentLabel && <div className="session-tree-row session-tree-group dashboard-tree-row"><span className="session-tree-group-name">{group.parentLabel}</span></div>}
                    <div className="session-tree-row session-tree-group dashboard-tree-row">
                      <button
                        type="button"
                        className="session-tree-group-toggle"
                        aria-expanded={expanded}
                        onClick={() => setOpenGroups((open) => ({ ...open, [group.id]: !expanded }))}
                      >
                        <ChevronIcon open={expanded} />
                        <span className="session-tree-group-name">{group.label}</span>
                      </button>
                      <span className="dashboard-group-meta">{group.boards.length}</span>
                    </div>
                    {expanded && group.boards.map((item) => {
                      const selected = item.id === boardId;
                      return (
                        <div
                          key={item.id}
                          className={`session-tree-row session-tree-session dashboard-tree-row${selected ? " is-selected" : ""}`}
                        >
                          <button
                            type="button"
                            className="session-tree-main"
                            aria-current={selected ? "page" : undefined}
                            title={item.label}
                            onClick={() => selectBoard(item)}
                          >
                            <span className="session-tree-title">{item.label}</span>
                            <span className="dashboard-row-meta">{metaFor(item)}</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {groups.length === 0 && <div className="session-tree-message">No dashboards match</div>}
            </div>
          </div>
        </div>

        <div className="dashboard-sidebar-footer">
          <span>{DASHBOARD_BOARDS.length} boards</span>
          <span>{overview ? `updated ${formatClock(overview.generatedAt)}` : "waiting for data"}</span>
        </div>
      </aside>

      {sidebarOpen && (
        <button
          type="button"
          className="dashboard-sidebar-backdrop"
          aria-label="Hide dashboard list"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="dashboard-main">
        <header className="dashboard-topbar">
          <button
            type="button"
            className="dashboard-menu-button"
            aria-label="Show dashboard list"
            onClick={() => setSidebarOpen(true)}
          >
            <MenuIcon />
          </button>
          <span className="dashboard-board-title">{board.label}</span>
          {boardId !== "fine-tasks" && <span className="dashboard-status" title={overview ? new Date(overview.generatedAt).toLocaleString() : undefined}>
            <span className={`dashboard-status-dot${status === "live" ? " is-live" : status === "offline" ? " is-offline" : ""}`} />
            {statusText}
            {overview ? ` · ${formatClock(overview.generatedAt)}` : ""}
          </span>}
        </header>
        <div className="dashboard-content">
          <div className={`dashboard-board${boardId === "fine-tasks" ? " dashboard-board-full-width" : ""}`}>
            {boardId === "fine-tasks" ? <TaskBoard active={active} /> : <BoardContent boardId={boardId} overview={overview} history={history} />}
          </div>
        </div>
      </main>
    </div>
  );
}

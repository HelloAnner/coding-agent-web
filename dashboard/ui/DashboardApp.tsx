import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
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

const IncomeExpensesBoard = dynamic(() => import("../boards/income-expenses/ui/IncomeExpensesBoard").then((module) => module.IncomeExpensesBoard));
const FatherHealthBoard = dynamic(() => import("../boards/father-health/ui/FatherHealthBoard").then((module) => module.FatherHealthBoard));

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

function MenuIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
    </svg>
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
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
    const url = `/dashboard?board=${next.id}`;
    router.replace(url, { scroll: false });
  };

  const normalizedQuery = query.trim().toLowerCase();
  const groups = useMemo(
    () => DASHBOARD_GROUPS
      .map((group) => ({
        ...group,
        boards: group.boards.filter((item) => !normalizedQuery || `${group.label} ${item.label}`.toLowerCase().includes(normalizedQuery)),
      }))
      .filter((group) => group.boards.length > 0),
    [normalizedQuery],
  );

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
                            <span className="dashboard-row-meta">{item.source}</span>
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
        </header>
        <div className="dashboard-content">
          <div className="dashboard-board dashboard-board-full-width">
            {board.id === "father-health" ? <FatherHealthBoard active={active} /> : board.id === "income-expenses" ? <IncomeExpensesBoard active={active} /> : <TaskBoard active={active} />}
          </div>
        </div>
      </main>
    </div>
  );
}

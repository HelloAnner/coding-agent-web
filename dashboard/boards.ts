/** Boards registered in the dashboard sidebar. */
export type DashboardBoardId = "fine-tasks" | "income-expenses" | "father-health";

export interface DashboardBoard {
  id: DashboardBoardId;
  label: string;
  source: string;
  /**
   * The board's fixed working directory, relative to the project root. The
   * right-hand chat starts its harness sessions here, so the harness reads the
   * AGENTS.md in this folder and grows the data inside it.
   */
  dataDir: string;
  /**
   * The board's canvas tint, as a shared token name. The shell paints the
   * board area with it (dashboard/shared/tokens.css `.db-canvas`), so the
   * board's own stylesheet only deals with layout.
   */
  tint: string;
}

export interface DashboardGroup {
  id: string;
  label: string;
  boards: readonly DashboardBoard[];
}

export const DASHBOARD_GROUPS: readonly DashboardGroup[] = [
  {
    id: "fine",
    label: "Fine",
    boards: [{ id: "fine-tasks", label: "任务看板", source: "Meegle", dataDir: "data/dashboard/fine-tasks", tint: "--db-tone-blue" }],
  },
  {
    id: "finance",
    label: "财务",
    boards: [{ id: "income-expenses", label: "收入支出分析", source: "JSON", dataDir: "data/dashboard/财务", tint: "--db-tone-orange" }],
  },
  {
    id: "health",
    label: "Health",
    boards: [{ id: "father-health", label: "Father's Health", source: "JSON", dataDir: "data/dashboard/健康/父亲", tint: "--db-tone-rust" }],
  },
];

export const DASHBOARD_BOARDS: readonly DashboardBoard[] = DASHBOARD_GROUPS.flatMap((group) => group.boards);
export const DEFAULT_BOARD_ID: DashboardBoardId = "fine-tasks";

/** Removed or unknown board links open the default board. */
export function dashboardBoardForId(value: string | null | undefined): DashboardBoard {
  return DASHBOARD_BOARDS.find((board) => board.id === value) ?? DASHBOARD_BOARDS[0];
}

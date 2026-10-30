/** Boards registered in the dashboard sidebar. */
export type DashboardBoardId = "fine-tasks" | "income-expenses";

export interface DashboardBoard {
  id: DashboardBoardId;
  label: string;
  source: string;
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
    boards: [{ id: "fine-tasks", label: "任务看板", source: "Meegle" }],
  },
  {
    id: "finance",
    label: "财务",
    boards: [{ id: "income-expenses", label: "收入支出分析", source: "JSON" }],
  },
];

export const DASHBOARD_BOARDS: readonly DashboardBoard[] = DASHBOARD_GROUPS.flatMap((group) => group.boards);
export const DEFAULT_BOARD_ID: DashboardBoardId = "fine-tasks";

/** Removed or unknown board links open the default board. */
export function dashboardBoardForId(value: string | null | undefined): DashboardBoard {
  return DASHBOARD_BOARDS.find((board) => board.id === value) ?? DASHBOARD_BOARDS[0];
}

/**
 * The dashboard's boards, hardcoded here: there is no way to create one at
 * runtime. The sidebar renders this tree; the main area picks its board by id.
 */
export type DashboardBoardId = "overview" | "memory" | "load" | "host" | "requests";

export interface DashboardBoard {
  id: DashboardBoardId;
  label: string;
}

export interface DashboardGroup {
  id: string;
  label: string;
  boards: readonly DashboardBoard[];
}

export const DASHBOARD_GROUPS: readonly DashboardGroup[] = [
  {
    id: "system",
    label: "System",
    boards: [
      { id: "overview", label: "Overview" },
      { id: "memory", label: "Memory" },
      { id: "load", label: "Load average" },
    ],
  },
  {
    id: "machine",
    label: "Machine",
    boards: [
      { id: "host", label: "Host details" },
      { id: "requests", label: "Requests" },
    ],
  },
];

export const DASHBOARD_BOARDS: readonly DashboardBoard[] = DASHBOARD_GROUPS.flatMap((group) => group.boards);
export const DEFAULT_BOARD_ID: DashboardBoardId = "overview";

/** The board named by a URL's `?board=` (another app's, a typo, nothing: the default). */
export function dashboardBoardForId(value: string | null | undefined): DashboardBoard {
  return DASHBOARD_BOARDS.find((board) => board.id === value)
    ?? DASHBOARD_BOARDS.find((board) => board.id === DEFAULT_BOARD_ID)
    ?? DASHBOARD_BOARDS[0];
}

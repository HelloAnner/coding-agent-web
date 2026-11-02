export const PLAN_HORIZONS = ["quarter", "year", "future"] as const;
export const PLAN_STATUSES = ["active", "paused", "done"] as const;

export type PlanHorizon = typeof PLAN_HORIZONS[number];
export type PlanStatus = typeof PLAN_STATUSES[number];

export interface PlanArea {
  id: string;
  name: string;
  vision: string;
  color: string;
}

export interface PlanGoal {
  id: string;
  areaId: string;
  title: string;
  detail: string;
  horizon: PlanHorizon;
  startDate: string;
  dueDate: string;
  status: PlanStatus;
  progress: number;
  createdAt: number;
  updatedAt: number;
}

export interface PlanMilestone {
  id: string;
  goalId: string;
  title: string;
  dueDate: string;
  done: boolean;
}

export interface PlanAttachment {
  id: string;
  goalId: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
}

export interface PlanSnapshot {
  areas: PlanArea[];
  goals: PlanGoal[];
  milestones: PlanMilestone[];
  attachments: PlanAttachment[];
  meta: {
    vision: string;
    focus: string;
  };
}

export interface PlanGoalInput {
  areaId: string;
  title: string;
  detail: string;
  horizon: PlanHorizon;
  startDate: string;
  dueDate: string;
  status: PlanStatus;
  progress: number;
}

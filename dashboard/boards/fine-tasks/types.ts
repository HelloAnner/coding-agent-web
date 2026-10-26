export interface FineTask {
  id: string;
  completed?: boolean;
  title: string;
  url: string;
  createdAt: number | null;
  testers: string[];
  version: string;
  priority: string;
  priorityRank: number;
  status: string;
  category: string;
  assignedAt: number | null;
  description: string;
  fields: { name: string; value: string }[];
}

export interface FineTaskSnapshot {
  tasks: FineTask[];
  lastSyncedAt: number | null;
  error: string | null;
  syncing: boolean;
  refreshIntervalMs: number;
}

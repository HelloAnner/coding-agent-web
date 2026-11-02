import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { PlanArea, PlanGoal, PlanGoalInput, PlanSnapshot } from "./types";

let open: { file: string; db: DatabaseSync } | null = null;

export function planDataRoot(): string {
  return process.env.PLAN_DATA_DIR || path.join(process.cwd(), "data", "plan");
}

export function planFilesRoot(): string {
  return path.join(planDataRoot(), "files");
}

function dateAfter(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function database(): DatabaseSync {
  const file = path.join(planDataRoot(), "plan.db");
  if (open?.file === file) return open.db;
  open?.db.close();
  mkdirSync(planDataRoot(), { recursive: true, mode: 0o700 });
  mkdirSync(planFilesRoot(), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  try { chmodSync(file, 0o600); } catch { /* Some filesystems do not support modes. */ }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS plan_areas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      vision TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS plan_goals (
      id TEXT PRIMARY KEY,
      area_id TEXT NOT NULL REFERENCES plan_areas(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      horizon TEXT NOT NULL,
      start_date TEXT NOT NULL DEFAULT '',
      due_date TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS plan_goals_area ON plan_goals(area_id);
    CREATE TABLE IF NOT EXISTS plan_milestones (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES plan_goals(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      due_date TEXT NOT NULL DEFAULT '',
      done INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS plan_milestones_goal ON plan_milestones(goal_id);
    CREATE TABLE IF NOT EXISTS plan_attachments (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES plan_goals(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plan_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  seed(db);
  open = { file, db };
  return db;
}

/** A small editable example on first launch, never recreated after deletion. */
function seed(db: DatabaseSync): void {
  const initialized = db.prepare("SELECT value FROM plan_meta WHERE key = 'initialized'").get();
  if (initialized) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const areas: PlanArea[] = [
      { id: "career", name: "事业", color: "#7567e8", vision: "做有价值、可持续、拥有长期复利的事业。" },
      { id: "growth", name: "成长", color: "#4d8df7", vision: "保持好奇，建立跨领域的认知与创造能力。" },
      { id: "health", name: "健康", color: "#43c6a0", vision: "拥有充沛精力、稳定情绪和可持续的身体状态。" },
      { id: "wealth", name: "财务", color: "#f2ad55", vision: "建立安全垫，让金钱支持选择而非制造焦虑。" },
      { id: "relationships", name: "关系", color: "#ef7e9b", vision: "认真经营亲密、真诚、彼此支持的关系。" },
      { id: "life", name: "生活", color: "#65b9c8", vision: "保留体验、审美和玩耍的空间。" },
    ];
    const insertArea = db.prepare("INSERT INTO plan_areas (id, name, vision, color, sort_order) VALUES (?, ?, ?, ?, ?)");
    areas.forEach((area, index) => insertArea.run(area.id, area.name, area.vision, area.color, index));

    const now = Date.now();
    const goals = [
      ["goal-product", "career", "完成独立产品的核心价值验证", "从真实问题出发验证价值，而不是只增加功能。", "quarter", 35, 90],
      ["goal-learning", "growth", "建立稳定的阅读与输出系统", "每月一个主题，把输入转化为可复用的思考。", "year", 20, 240],
      ["goal-health", "health", "形成每周三次的运动节奏", "先建立稳定节奏，再逐步提升强度。", "quarter", 60, 90],
      ["goal-fund", "wealth", "建立 12 个月安全储备", "用清晰的安全边界换取长期选择的自由。", "future", 25, 720],
      ["goal-together", "relationships", "留出高质量的陪伴时间", "每周安排不被屏幕打断的共同时间。", "quarter", 50, 60],
      ["goal-travel", "life", "完成一次期待已久的旅行", "留出空白，认真体验一个向往的地方。", "year", 10, 180],
    ] as const;
    const insertGoal = db.prepare(`INSERT INTO plan_goals
      (id, area_id, title, detail, horizon, start_date, due_date, progress, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    goals.forEach((goal, index) => insertGoal.run(goal[0], goal[1], goal[2], goal[3], goal[4], dateAfter(0), dateAfter(goal[6]), goal[5], index, now, now));

    const insertMilestone = db.prepare("INSERT INTO plan_milestones (id, goal_id, title, due_date, done, sort_order) VALUES (?, ?, ?, ?, ?, ?)");
    [
      ["ms-interviews", "goal-product", "访谈 5 位目标用户", 14, 1],
      ["ms-demo", "goal-product", "完成可演示的最小版本", 45, 0],
      ["ms-feedback", "goal-product", "获得首批真实使用反馈", 75, 0],
      ["ms-training", "goal-health", "连续四周完成运动计划", 28, 0],
      ["ms-reading", "goal-learning", "完成第一个主题阅读与总结", 30, 0],
    ].forEach((row, index) => insertMilestone.run(row[0], row[1], row[2], dateAfter(Number(row[3])), Number(row[4]), index));

    const meta = db.prepare("INSERT INTO plan_meta (key, value) VALUES (?, ?)");
    meta.run("vision", "成为长期主义的创造者：事业有复利，身体有能量，关系有温度，生活有选择。");
    meta.run("focus", "聚焦少数重要目标，让每个领域都朝着同一个方向前进。");
    meta.run("initialized", "1");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function readPlan(): PlanSnapshot {
  const db = database();
  const areas = db.prepare("SELECT id, name, vision, color FROM plan_areas ORDER BY sort_order, name").all() as unknown as PlanArea[];
  const goalRows = db.prepare(`SELECT id, area_id, title, detail, horizon, start_date, due_date, status, progress, created_at, updated_at
    FROM plan_goals ORDER BY sort_order, created_at`).all() as {
      id: string; area_id: string; title: string; detail: string; horizon: PlanGoal["horizon"];
      start_date: string; due_date: string; status: PlanGoal["status"]; progress: number;
      created_at: number; updated_at: number;
    }[];
  const milestoneRows = db.prepare("SELECT id, goal_id, title, due_date, done FROM plan_milestones ORDER BY sort_order, due_date").all() as {
    id: string; goal_id: string; title: string; due_date: string; done: number;
  }[];
  const attachmentRows = db.prepare("SELECT id, goal_id, name, mime, size, created_at FROM plan_attachments ORDER BY created_at DESC").all() as {
    id: string; goal_id: string; name: string; mime: string; size: number; created_at: number;
  }[];
  const metaRows = db.prepare("SELECT key, value FROM plan_meta").all() as { key: string; value: string }[];
  const meta = new Map(metaRows.map((row) => [row.key, row.value]));
  return {
    areas,
    goals: goalRows.map((row) => ({
      id: row.id, areaId: row.area_id, title: row.title, detail: row.detail, horizon: row.horizon,
      startDate: row.start_date, dueDate: row.due_date, status: row.status, progress: row.progress,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })),
    milestones: milestoneRows.map((row) => ({ id: row.id, goalId: row.goal_id, title: row.title, dueDate: row.due_date, done: Boolean(row.done) })),
    attachments: attachmentRows.map((row) => ({ id: row.id, goalId: row.goal_id, name: row.name, mime: row.mime, size: row.size, createdAt: row.created_at })),
    meta: { vision: meta.get("vision") ?? "", focus: meta.get("focus") ?? "" },
  };
}

export function savePlanMeta(key: "vision" | "focus", value: string): void {
  database().prepare("INSERT INTO plan_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function createArea(input: Omit<PlanArea, "id">): string {
  const id = randomUUID();
  const db = database();
  const order = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM plan_areas").get() as { value: number };
  db.prepare("INSERT INTO plan_areas (id, name, vision, color, sort_order) VALUES (?, ?, ?, ?, ?)").run(id, input.name, input.vision, input.color, order.value);
  return id;
}

export function updateArea(area: PlanArea): void {
  database().prepare("UPDATE plan_areas SET name = ?, vision = ?, color = ? WHERE id = ?").run(area.name, area.vision, area.color, area.id);
}

export function hasArea(id: string): boolean {
  return Boolean(database().prepare("SELECT 1 AS found FROM plan_areas WHERE id = ?").get(id));
}

export function hasGoal(id: string): boolean {
  return Boolean(database().prepare("SELECT 1 AS found FROM plan_goals WHERE id = ?").get(id));
}

export function createGoal(input: PlanGoalInput): string {
  const id = randomUUID();
  const now = Date.now();
  const db = database();
  const order = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM plan_goals").get() as { value: number };
  db.prepare(`INSERT INTO plan_goals
    (id, area_id, title, detail, horizon, start_date, due_date, status, progress, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.areaId, input.title, input.detail, input.horizon, input.startDate, input.dueDate,
      input.status, input.progress, order.value, now, now,
    );
  return id;
}

export function updateGoal(id: string, input: PlanGoalInput): void {
  database().prepare(`UPDATE plan_goals SET area_id = ?, title = ?, detail = ?, horizon = ?, start_date = ?,
    due_date = ?, status = ?, progress = ?, updated_at = ? WHERE id = ?`).run(
      input.areaId, input.title, input.detail, input.horizon, input.startDate, input.dueDate,
      input.status, input.progress, Date.now(), id,
    );
}

export function deleteGoal(id: string): void {
  database().prepare("DELETE FROM plan_goals WHERE id = ?").run(id);
}

export function createMilestone(goalId: string, title: string, dueDate: string): string {
  const id = randomUUID();
  const db = database();
  const order = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM plan_milestones WHERE goal_id = ?").get(goalId) as { value: number };
  db.prepare("INSERT INTO plan_milestones (id, goal_id, title, due_date, sort_order) VALUES (?, ?, ?, ?, ?)").run(id, goalId, title, dueDate, order.value);
  return id;
}

export function setMilestoneDone(id: string, done: boolean): void {
  database().prepare("UPDATE plan_milestones SET done = ? WHERE id = ?").run(done ? 1 : 0, id);
}

export function deleteMilestone(id: string): void {
  database().prepare("DELETE FROM plan_milestones WHERE id = ?").run(id);
}

export function addAttachment(goalId: string, name: string, storedName: string, mime: string, size: number): string {
  const id = randomUUID();
  database().prepare("INSERT INTO plan_attachments (id, goal_id, name, stored_name, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, goalId, name, storedName, mime, size, Date.now());
  return id;
}

export function attachmentLocation(id: string): { goalId: string; name: string; storedName: string; mime: string } | null {
  const row = database().prepare("SELECT goal_id, name, stored_name, mime FROM plan_attachments WHERE id = ?").get(id) as {
    goal_id: string; name: string; stored_name: string; mime: string;
  } | undefined;
  return row ? { goalId: row.goal_id, name: row.name, storedName: row.stored_name, mime: row.mime } : null;
}

export function deleteAttachment(id: string): { goalId: string; storedName: string } | null {
  const location = attachmentLocation(id);
  if (!location) return null;
  database().prepare("DELETE FROM plan_attachments WHERE id = ?").run(id);
  return { goalId: location.goalId, storedName: location.storedName };
}

export function closePlanDb(): void {
  open?.db.close();
  open = null;
}

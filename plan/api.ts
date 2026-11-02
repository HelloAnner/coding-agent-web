import { rm } from "node:fs/promises";
import path from "node:path";
import { createArea, createGoal, createMilestone, deleteGoal, deleteMilestone, hasArea, hasGoal, planFilesRoot, readPlan, savePlanMeta, setMilestoneDone, updateArea, updateGoal } from "./db";
import { PLAN_HORIZONS, PLAN_STATUSES, type PlanGoalInput, type PlanHorizon, type PlanStatus } from "./types";

export class PlanError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlanError("请求内容无效");
  return value as Record<string, unknown>;
}

function text(body: Record<string, unknown>, key: string, max: number, required = false): string {
  const value = body[key];
  if (typeof value !== "string") throw new PlanError(`${key} 必须是文本`);
  const result = value.trim();
  if (required && !result) throw new PlanError("请填写必填内容");
  if (result.length > max) throw new PlanError(`内容不能超过 ${max} 个字符`);
  return result;
}

function id(body: Record<string, unknown>, key = "id"): string {
  const value = text(body, key, 100, true);
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new PlanError("记录标识无效");
  return value;
}

function date(body: Record<string, unknown>, key: string): string {
  const value = text(body, key, 10);
  if (!value) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new PlanError("日期格式无效");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new PlanError("日期无效");
  return value;
}

function color(body: Record<string, unknown>): string {
  const value = text(body, "color", 7, true);
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new PlanError("颜色格式无效");
  return value;
}

function goalInput(body: Record<string, unknown>): PlanGoalInput {
  const horizon = text(body, "horizon", 20, true) as PlanHorizon;
  const status = text(body, "status", 20, true) as PlanStatus;
  if (!PLAN_HORIZONS.includes(horizon) || !PLAN_STATUSES.includes(status)) throw new PlanError("目标状态或时间范围无效");
  if (typeof body.progress !== "number" || !Number.isInteger(body.progress) || body.progress < 0 || body.progress > 100) {
    throw new PlanError("完成度必须是 0–100 的整数");
  }
  const areaId = id(body, "areaId");
  if (!hasArea(areaId)) throw new PlanError("人生领域不存在", 404);
  return {
    areaId,
    title: text(body, "title", 160, true),
    detail: text(body, "detail", 5000),
    horizon,
    startDate: date(body, "startDate"),
    dueDate: date(body, "dueDate"),
    status,
    progress: body.progress,
  };
}

function snapshot(): Response {
  return Response.json(readPlan(), { headers: { "Cache-Control": "no-store" } });
}

export function GET(): Response {
  return snapshot();
}

export async function POST(request: Request): Promise<Response> {
  try {
    const length = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(length) && length > 1024 * 1024) throw new PlanError("请求内容过大", 413);
    const body = object(await request.json());
    const action = text(body, "action", 40, true);
    switch (action) {
      case "saveMeta": {
        const key = text(body, "key", 10, true);
        if (key !== "vision" && key !== "focus") throw new PlanError("规划字段无效");
        savePlanMeta(key, text(body, "value", 5000));
        break;
      }
      case "createArea":
        createArea({ name: text(body, "name", 40, true), vision: text(body, "vision", 2000), color: color(body) });
        break;
      case "updateArea": {
        const areaId = id(body);
        if (!hasArea(areaId)) throw new PlanError("人生领域不存在", 404);
        updateArea({ id: areaId, name: text(body, "name", 40, true), vision: text(body, "vision", 2000), color: color(body) });
        break;
      }
      case "createGoal":
        createGoal(goalInput(body));
        break;
      case "updateGoal": {
        const goalId = id(body);
        if (!hasGoal(goalId)) throw new PlanError("目标不存在", 404);
        updateGoal(goalId, goalInput(body));
        break;
      }
      case "deleteGoal": {
        const goalId = id(body);
        if (!hasGoal(goalId)) throw new PlanError("目标不存在", 404);
        deleteGoal(goalId);
        await rm(path.join(planFilesRoot(), goalId), { recursive: true, force: true });
        break;
      }
      case "createMilestone": {
        const goalId = id(body, "goalId");
        if (!hasGoal(goalId)) throw new PlanError("目标不存在", 404);
        createMilestone(goalId, text(body, "title", 200, true), date(body, "dueDate"));
        break;
      }
      case "setMilestoneDone":
        if (typeof body.done !== "boolean") throw new PlanError("里程碑状态无效");
        setMilestoneDone(id(body), body.done);
        break;
      case "deleteMilestone":
        deleteMilestone(id(body));
        break;
      default:
        throw new PlanError("不支持的规划操作");
    }
    return snapshot();
  } catch (error) {
    if (error instanceof PlanError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return Response.json({ error: "请求 JSON 无效" }, { status: 400 });
    console.error("Plan mutation failed", error);
    return Response.json({ error: "规划数据保存失败，请稍后重试" }, { status: 500 });
  }
}

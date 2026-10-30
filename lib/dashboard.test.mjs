import assert from "node:assert/strict";
import test from "node:test";
import {
  DASHBOARD_BOARDS,
  DASHBOARD_GROUPS,
  DEFAULT_BOARD_ID,
  dashboardBoardForId,
} from "../dashboard/boards.ts";

test("navigation groups register independent boards and their own data sources", () => {
  assert.deepEqual(DASHBOARD_GROUPS, [
    { id: "fine", label: "Fine", boards: [{ id: "fine-tasks", label: "任务看板", source: "Meegle" }] },
    { id: "finance", label: "财务", boards: [{ id: "income-expenses", label: "收入支出分析", source: "JSON" }] },
    { id: "health", label: "Health", boards: [{ id: "father-health", label: "Father's Health", source: "JSON" }] },
  ]);
  assert.deepEqual(DASHBOARD_BOARDS.map((board) => board.id), ["fine-tasks", "income-expenses", "father-health"]);
  assert.equal(DEFAULT_BOARD_ID, "fine-tasks");
});

test("income analysis has its own link; removed and unknown links resolve to the task board", () => {
  assert.equal(dashboardBoardForId("income-expenses").id, "income-expenses");
  assert.equal(dashboardBoardForId("father-health").id, "father-health");
  for (const value of ["fine-tasks", null, undefined, "", "nope", "overview", "memory", "load", "host", "requests"]) {
    assert.equal(dashboardBoardForId(value).id, "fine-tasks");
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  DASHBOARD_BOARDS,
  DASHBOARD_GROUPS,
  DEFAULT_BOARD_ID,
  dashboardBoardForId,
} from "../dashboard/boards.ts";

test("the dashboard contains only Fine and its task board", () => {
  assert.deepEqual(DASHBOARD_GROUPS, [{ id: "fine", label: "Fine", boards: [{ id: "fine-tasks", label: "任务看板" }] }]);
  assert.deepEqual(DASHBOARD_BOARDS.map((board) => board.id), ["fine-tasks"]);
  assert.equal(DEFAULT_BOARD_ID, "fine-tasks");
});

test("removed and unknown board URLs resolve to the task board", () => {
  for (const value of ["fine-tasks", null, undefined, "", "nope", "overview", "memory", "load", "host", "requests"]) {
    assert.equal(dashboardBoardForId(value).id, "fine-tasks");
  }
});

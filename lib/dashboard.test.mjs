import assert from "node:assert/strict";
import test from "node:test";
import {
  DASHBOARD_BOARDS,
  DASHBOARD_GROUPS,
  DEFAULT_BOARD_ID,
  dashboardBoardForId,
} from "../dashboard/boards.ts";
import { dashboardOverview } from "../dashboard/server.mjs";

test("the dashboard tree is hardcoded and every board id is unique", () => {
  assert.ok(DASHBOARD_GROUPS.length > 1);
  assert.ok(DASHBOARD_GROUPS.every((group) => group.label && group.boards.length > 0));
  assert.deepEqual(DASHBOARD_BOARDS.map((board) => board.id), [
    "overview", "memory", "load", "host", "requests",
  ]);
  assert.equal(new Set(DASHBOARD_BOARDS.map((board) => board.id)).size, DASHBOARD_BOARDS.length);
  assert.equal(new Set(DASHBOARD_GROUPS.map((group) => group.id)).size, DASHBOARD_GROUPS.length);
  assert.equal(DEFAULT_BOARD_ID, "overview");
});

test("a board from the URL resolves to its tree item, anything else to the default", () => {
  for (const board of DASHBOARD_BOARDS) {
    assert.equal(dashboardBoardForId(board.id).id, board.id);
  }
  for (const value of [null, undefined, "", "nope", "Overview"]) {
    assert.equal(dashboardBoardForId(value).id, DEFAULT_BOARD_ID);
  }
});

test("the dashboard's own backend reports host figures", () => {
  const first = dashboardOverview();
  const second = dashboardOverview();
  assert.equal(first.app, "dashboard");
  assert.equal(Number.isNaN(Date.parse(first.generatedAt)), false);
  assert.ok(first.serverUptimeSeconds >= 0);
  assert.ok(first.processUptimeSeconds >= 0);
  assert.equal(second.requestsServed, first.requestsServed + 1);
  assert.ok(first.memory.totalBytes > 0);
  assert.ok(first.memory.usedBytes >= 0);
  assert.ok(first.memory.percent >= 0 && first.memory.percent <= 100);
  assert.equal(first.load.length, 3);
  assert.ok(first.load.every((value) => Number.isFinite(value) && value >= 0));
  assert.ok(first.host.hostname);
  assert.ok(first.host.cpuCount >= 1);
  assert.equal(typeof first.host.node, "string");
  assert.ok(first.host.uptimeSeconds >= 0);
});

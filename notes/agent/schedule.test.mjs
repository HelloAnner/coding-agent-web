import assert from "node:assert/strict";
import { test } from "node:test";

const { nextRunAt } = await import("./schedule.ts");

test("everyMinutes counts from the given time", () => {
  const from = new Date(2026, 0, 1, 10, 0, 0, 0);
  assert.equal(nextRunAt({ everyMinutes: 30 }, from), from.getTime() + 30 * 60_000);
});

test("dailyAt later today stays today", () => {
  const next = new Date(nextRunAt({ dailyAt: "08:30" }, new Date(2026, 0, 1, 8, 0, 0, 0)));
  assert.deepEqual([next.getDate(), next.getHours(), next.getMinutes()], [1, 8, 30]);
});

test("dailyAt moves to tomorrow once today's time has passed", () => {
  const next = new Date(nextRunAt({ dailyAt: "08:30" }, new Date(2026, 0, 1, 9, 30, 0, 0)));
  assert.deepEqual([next.getDate(), next.getHours(), next.getMinutes()], [2, 8, 30]);
});

test("an invalid or absent schedule never fires", () => {
  assert.equal(nextRunAt({}, new Date()), null);
  assert.equal(nextRunAt({ everyMinutes: 0 }, new Date()), null);
  assert.equal(nextRunAt({ dailyAt: "8:30am" }, new Date()), null);
});

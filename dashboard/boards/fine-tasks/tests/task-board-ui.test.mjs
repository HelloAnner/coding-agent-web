import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" } });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const source = await readFile(new URL("../ui/TaskBoard.tsx", import.meta.url), "utf8");
// CSS is tested by the app bundler, not Node's module loader.
const { TaskBoard, filterValues, safeTaskUrl, taskDaysInHand, visibleTasks } = jiti.evalModule(
  source.replace('import "./task-board.css";', ""),
  { filename: fileURLToPath(new URL("../ui/TaskBoard.tsx", import.meta.url)) },
);
const day = 86_400_000;
const now = 1_750_000_000_000;
const makeTask = (overrides = {}) => ({
  id: "1", title: "测试任务", url: "https://example.com/tasks/1", createdAt: now,
  testers: ["张三"], version: "v2", priority: "高", priorityRank: 1,
  status: "进行中", category: "需求", assignedAt: now - 3 * day,
  description: "任务描述", fields: [{ name: "产品", value: "编辑器" }], ...overrides,
});
const sort = (key, direction = "ascending") => ({ key, direction });

test("original links only allow absolute HTTPS without embedded credentials", () => {
  assert.equal(safeTaskUrl("https://example.com/tasks/1?q=a#details"), "https://example.com/tasks/1?q=a#details");
  for (const value of ["javascript:alert(1)", "data:text/html,hello", "http://example.com", "//example.com", "/tasks/1", "https://user:pass@example.com", "not a link", ""]) {
    assert.equal(safeTaskUrl(value), null, value);
  }
});

test("days in hand uses epoch milliseconds and does not invent an assignment date", () => {
  assert.equal(taskDaysInHand(makeTask(), now), 3);
  assert.equal(taskDaysInHand(makeTask({ assignedAt: now - day + 1 }), now), 0);
  assert.equal(taskDaysInHand(makeTask({ assignedAt: now + day }), now), 0);
  assert.equal(taskDaysInHand(makeTask({ assignedAt: null }), now), null);
  assert.equal(taskDaysInHand(makeTask({ assignedAt: Number.NaN }), now), null);
  assert.equal(taskDaysInHand(makeTask({ assignedAt: 0 }), 3 * day), 3);
});

test("search combines with status and category filters without mutating cached tasks", () => {
  const tasks = [makeTask(), makeTask({ id: "2", status: "已完成" }), makeTask({ id: "3", category: "缺陷" })];
  const status = [{ field: "status", value: "进行中" }];
  const both = [...status, { field: "category", value: "需求" }];
  assert.deepEqual(visibleTasks(tasks, " 编辑器 ", both, sort("title"), now).map((task) => task.id), ["1"]);
  assert.equal(visibleTasks(tasks, "张三", [], sort("title"), now).length, 3);
  assert.equal(visibleTasks(tasks, "not present", [], sort("title"), now).length, 0);
  assert.deepEqual(tasks.map((task) => task.id), ["1", "2", "3"]);
});

test("multiple fields filter together: recent creation time plus priority", () => {
  const urgentRecent = makeTask({ id: "urgent-recent", priority: "紧急", priorityRank: 1, createdAt: now - day });
  const urgentOld = makeTask({ id: "urgent-old", priority: "紧急", priorityRank: 1, createdAt: now - 10 * day });
  const normalRecent = makeTask({ id: "normal-recent", priority: "一般紧急", priorityRank: 2, createdAt: now - day });
  const tasks = [urgentRecent, urgentOld, normalRecent];
  assert.deepEqual(visibleTasks(tasks, "", [{ field: "priority", value: "紧急" }, { field: "createdWithin", value: "3" }], sort("title"), now).map((task) => task.id), ["urgent-recent"]);
  // Same field twice is OR, different fields are AND.
  assert.deepEqual(visibleTasks(tasks, "", [{ field: "priority", value: "紧急" }, { field: "priority", value: "一般紧急" }], sort("title"), now).map((task) => task.id), ["normal-recent", "urgent-old", "urgent-recent"]);
  // Rows without a chosen value do not filter anything.
  assert.equal(visibleTasks(tasks, "", [{ field: "status", value: "" }], sort("title"), now).length, 3);
});

test("filter values come from the tasks, and creation time offers recent ranges", () => {
  const tasks = [makeTask(), makeTask({ id: "2", testers: ["李四", "张三"], priority: "紧急" })];
  assert.deepEqual(filterValues(tasks, "priority").map((option) => option.value).sort(), ["紧急", "高"].sort());
  assert.deepEqual(filterValues(tasks, "tester").map((option) => option.value).sort(), ["张三", "李四"].sort());
  assert.deepEqual(filterValues(tasks, "createdWithin").map((option) => option.value), ["1", "3", "7", "30"]);
});

test("all columns support ascending and descending sorts", () => {
  const first = makeTask({ id: "a", title: "a", createdAt: 1, testers: ["a"], version: "v2", priorityRank: 1, assignedAt: now - day, status: "a", category: "a" });
  const second = makeTask({ id: "b", title: "b", createdAt: 2, testers: ["b"], version: "v10", priorityRank: 2, assignedAt: now - 2 * day, status: "b", category: "b" });
  for (const key of ["title", "createdAt", "testers", "version", "priority", "daysInHand", "status", "category"]) {
    assert.deepEqual(visibleTasks([second, first], "", [], sort(key), now).map((task) => task.id), ["a", "b"], key);
    assert.deepEqual(visibleTasks([first, second], "", [], sort(key, "descending"), now).map((task) => task.id), ["b", "a"], key);
  }
});

test("unknown timestamps, testers, version and priority stay last in either direction", () => {
  const known = makeTask({ id: "known" });
  const unknown = makeTask({ id: "unknown", createdAt: null, assignedAt: null, testers: [], version: "", priority: "" });
  for (const key of ["createdAt", "daysInHand", "testers", "version", "priority"]) {
    for (const direction of ["ascending", "descending"]) {
      assert.deepEqual(visibleTasks([unknown, known], "", [], sort(key, direction), now).map((task) => task.id), ["known", "unknown"]);
    }
  }
});

test("initial view has accessible sortable headers, named filters and no fabricated rows", () => {
  const html = renderToStaticMarkup(React.createElement(TaskBoard, { active: true }));
  assert.equal((html.match(/aria-sort=/g) ?? []).length, 8);
  assert.match(html, /<th scope="col" class="task-board-actions">/);
  assert.match(html, /colSpan="9"/i);
  assert.match(source, /<td>\{task.category \|\| "—"\}<\/td>\s*<td className="task-board-actions">\s*<button[^>]*className="task-board-copy"/);
  assert.match(html, /aria-sort="descending"/);
  for (const label of ["搜索任务", "添加筛选", "可横向滚动"]) assert.ok(html.includes(label));
  // Filter rows only appear after 添加筛选, so their accessible names live in source.
  assert.match(source, /按字段筛选/);
  assert.match(source, /aria-label={`移除\$\{label\}筛选`}/);
  assert.match(html, /<dialog[^>]*aria-labelledby=/);
  assert.ok(!html.includes("测试任务"));
  assert.match(renderToStaticMarkup(React.createElement(TaskBoard, { active: false })), /hidden=""/);
});

test("refresh, active-only polling and native dialog safety are wired explicitly", () => {
  assert.match(source, /const POLL_INTERVAL_MS = 30_000/);
  assert.match(source, /if \(!active\) return;[\s\S]*window\.setInterval/);
  assert.match(source, /window\.addEventListener\("focus", refreshVisible\)/);
  assert.match(source, /document\.addEventListener\("visibilitychange", refreshVisible\)/);
  assert.match(source, /method: "GET"/);
  assert.ok(!source.includes('"POST"'));
  assert.match(source, /window\.addEventListener\("keydown", closeOnEscape, true\)/);
  assert.match(source, /window\.removeEventListener\("keydown", closeOnEscape, true\)/);
  assert.match(source, /event\.key !== "Escape" \|\| event\.isComposing \|\| !dialog\.current\?\.open/);
  assert.match(source, /event\.stopImmediatePropagation\(\);\s*dialog\.current\.close\(\);\s*setSelected\(null\)/);
  assert.match(source, /modal\?\.showModal\(\)/);
  assert.match(source, /onClose=\{\(\) => setSelected\(null\)\}/);
  assert.match(source, /autoFocus/);
  assert.match(source, /navigator\.clipboard\.writeText\(url\)/);
  assert.match(source, /链接已复制/);
  assert.match(source, /复制失败/);
  assert.match(source, /rel="noopener noreferrer"/);
  assert.ok(!source.includes("dangerouslySetInnerHTML"));
});

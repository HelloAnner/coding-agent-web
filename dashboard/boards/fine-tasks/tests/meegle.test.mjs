import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { normalizeTask, timestamp, fetchMyTasks } = await createJiti(import.meta.url).import("../meegle.ts");

test("Meegle fields map to task columns without inventing assignment dates", () => {
  const task = normalizeTask({
    work_item_attribute: {
      work_item_id: "123", work_item_name: "任务", create_time: "2026-10-01T00:00:00Z",
      work_item_type: { key: "issue", name: "缺陷" }, owned_project: { key: "project", simple_name: "fine" },
      work_item_status: { name: "开发中" }, role_members: [{ name: "测试者", members: [{ key: "u", name: "测试同事" }] }],
    },
    work_item_fields: [
      { key: "priority", value: { label: "一般紧急", value: "option_2" } },
      { key: "resolve_version", value: [{ name: "v6.1" }] },
      { key: "description", value: "详细说明" },
    ],
  }, {});
  assert.equal(task.title, "任务");
  assert.equal(task.url, "https://project.feishu.cn/fine/issue/detail/123");
  assert.deepEqual(task.testers, ["测试同事"]);
  assert.equal(task.version, "v6.1");
  assert.equal(task.priorityRank, 1);
  assert.equal(task.assignedAt, null);
  assert.equal(task.description, "详细说明");
  assert.equal(timestamp("bad"), null);
  assert.equal(timestamp(1760000000), 1760000000000);
});

test("only current in-progress personal work is fetched and reassigned tasks are completed", async () => {
  const tasks = await fetchMyTasks(async (command, params) => {
    if (command[0] === "user") return { user_key: "me" };
    if (command[0] === "mywork") {
      assert.equal(params["todo-scope"], "in_progress");
      return { total: 2, list: [1, 2].map(id => ({ project_key: "p", work_item_info: { work_item_id: id, work_item_type_key: "issue" } })) };
    }
    return {
      work_item_attribute: { work_item_id: params["work-item-id"], owned_project: { key: "p" }, work_item_type: { key: "issue" } },
      work_item_fields: [{ key: "current_status_operator", value: [{ key: params["work-item-id"] === "1" ? "me" : "other" }] }],
    };
  });
  assert.equal(tasks.find(task => task.id === "p:issue:1").completed, false);
  assert.equal(tasks.find(task => task.id === "p:issue:2").completed, true);
});

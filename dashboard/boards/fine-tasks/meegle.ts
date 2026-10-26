import { meegle } from "./cli";
import type { FineTask } from "./types";

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function fieldText(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join("、");
  if (typeof value === "object") {
    const record = object(value);
    return fieldText(record.name ?? record.label ?? record.text ?? record.iso_time ?? "");
  }
  return String(value);
}
export function timestamp(value: unknown): number | null {
  if (value == null || value === "") return null;
  const record = object(value);
  if (record.timestamp != null) return timestamp(record.timestamp);
  if (record.iso_time != null) return timestamp(record.iso_time);
  const number = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(String(value));
  return Number.isFinite(number) ? number : null;
}

const VERSION_KEYS = ["resolve_version", "actual_online_version", "field_763488", "planning_version", "field_094e08"];
const EXTRA_FIELDS = [...VERSION_KEYS, "current_status_operator", "priority", "description"].join(",");

export function normalizeTask(detail: unknown, todo: unknown): FineTask {
  const data = object(detail);
  const item = object(todo);
  const attribute = object(data.work_item_attribute);
  const info = object(item.work_item_info);
  const project = object(attribute.owned_project);
  const fields = list(data.work_item_fields).map(object);
  const get = (key: string) => fields.find((field) => field.key === key)?.value;
  const role = list(attribute.role_members).map(object).find((entry) => entry.name === "测试者");
  const id = String(attribute.work_item_id ?? info.work_item_id ?? "");
  const projectKey = String(project.key ?? item.project_key ?? "");
  const typeKey = String(object(attribute.work_item_type).key ?? info.work_item_type_key ?? "");
  const priority = fieldText(get("priority"));
  const version = VERSION_KEYS.map((key) => fieldText(get(key))).find(Boolean) ?? "";
  return {
    id: `${projectKey}:${typeKey}:${id}`,
    title: String(attribute.work_item_name ?? info.work_item_name ?? id),
    url: `https://project.feishu.cn/${encodeURIComponent(String(project.simple_name || projectKey))}/${encodeURIComponent(typeKey)}/detail/${encodeURIComponent(id)}`,
    createdAt: timestamp(attribute.create_time),
    testers: list(role?.members).map((member) => fieldText(member)).filter(Boolean),
    version,
    priority,
    priorityRank: /非常紧急|最高|P0|紧急且重要/i.test(priority) ? 0 : /一般紧急|P1|高/i.test(priority) ? 1 : /不紧急|P3|低/i.test(priority) ? 3 : 2,
    status: fieldText(attribute.work_item_status) || fieldText(object(item.node_info).node_name),
    category: fieldText(attribute.work_item_type) || String(info.work_item_type_key ?? ""),
    // Neither creation time nor a planned schedule is a real assignment timestamp.
    assignedAt: null,
    description: fieldText(get("description")),
    fields: [
      { name: "项目", value: fieldText(project) || String(item.project_name ?? "") },
      { name: "当前处理人", value: fieldText(get("current_status_operator")) },
      { name: "待办节点", value: fieldText(object(item.node_info).node_name) },
    ].filter((field) => field.value),
  };
}

export async function fetchMyTasks(query: typeof meegle = meegle): Promise<FineTask[]> {
  const currentUser = object(await query(["user", "me"]));
  if (!currentUser.user_key) throw new Error("Missing current Meegle identity");
  const todos: RecordValue[] = [];
  let total: number | null = null;
  for (let page = 1; page <= 1000; page += 1) {
    const response = object(await query(["mywork", "todo"], { action: "todo", "todo-scope": "in_progress", "page-num": page }));
    if (!("list" in response) || typeof response.total !== "number") throw new Error("Invalid Meegle todo response");
    if (total === null) total = response.total;
    const rows = list(response.list).map(object);
    todos.push(...rows);
    if (todos.length >= total) break;
    if (!rows.length || page === 1000) throw new Error("Incomplete Meegle task pages");
  }
  const unique = new Map<string, RecordValue>();
  for (const todo of todos) {
    const item = object(todo.work_item_info);
    if (!todo.project_key || !item.work_item_id) throw new Error("Invalid Meegle task identity");
    const key = `${todo.project_key}:${item.work_item_id}`;
    const previous = unique.get(key);
    const nodes = [fieldText(object(previous?.node_info).node_name), fieldText(object(todo.node_info).node_name)].filter(Boolean);
    unique.set(key, { ...todo, node_info: { ...object(todo.node_info), node_name: [...new Set(nodes)].join("、") } });
  }
  const input = [...unique.values()];
  const output: FineTask[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, input.length) }, async () => {
    while (cursor < input.length) {
      const todo = input[cursor++];
      const item = object(todo.work_item_info);
      const detail = await query(["workitem", "get"], { "project-key": todo.project_key, "work-item-id": String(item.work_item_id), fields: EXTRA_FIELDS });
      if (!object(detail).work_item_attribute) throw new Error("Incomplete Meegle task detail");
      const owners = list(object(detail).work_item_fields).map(object).find((field) => field.key === "current_status_operator")?.value;
      if (!Array.isArray(owners)) throw new Error("Unknown current task ownership");
      const task = normalizeTask(detail, todo);
      task.completed = !owners.some((owner) => String(object(owner).key) === String(currentUser.user_key));
      output.push(task);
    }
  }));
  return output;
}

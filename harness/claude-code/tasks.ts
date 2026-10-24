import { object } from "./index";

export type ClaudeTaskStatus = "pending" | "running" | "paused" | "completed" | "failed" | "stopped" | "unknown";
export interface ClaudeTask {
  id: string;
  runId?: string;
  type: string;
  status: ClaudeTaskStatus;
  description: string;
  background: boolean;
  ambient: boolean;
  toolUseId?: string;
  parentTaskId?: string;
  agentType?: string;
  command?: string;
  prompt?: string;
  summary?: string;
  error?: string;
  lastToolName?: string;
  startedAt?: number;
  endedAt?: number;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
}
export interface ClaudeTaskSnapshot {
  connected: boolean;
  foreground: boolean;
  tasks: ClaudeTask[];
}
export interface ClaudeTaskDetail {
  task: ClaudeTask;
  output?: string;
  totalBytes?: number;
  truncated?: boolean;
  messages?: import("../../lib/types").AgentMessage[];
}
export const CLAUDE_TASK_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;
export function claudeTaskActive(task: ClaudeTask): boolean { return ["pending", "running", "paused"].includes(task.status); }
const text = (value: unknown, max = 2000): string | undefined => typeof value === "string" ? value.slice(0, max) : undefined;
const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
function status(value: unknown): ClaudeTaskStatus | undefined {
  if (value === "killed") return "stopped";
  return typeof value === "string" && ["pending", "running", "paused", "completed", "failed", "stopped"].includes(value) ? value as ClaudeTaskStatus : undefined;
}
function taskType(value: unknown): string {
  if (value === "local_bash") return "shell";
  if (value === "local_agent" || value === "remote_agent") return "subagent";
  if (value === "local_workflow") return "workflow";
  return text(value, 100) || "task";
}

/** Process-lifetime task state, separate from any one foreground message mapper. */
export class ClaudeTasks {
  readonly rows = new Map<string, ClaudeTask>();
  readonly backgroundIds = new Set<string>();
  private levelReceived = false;
  private readonly tools = new Map<string, { name: string; input: Record<string, unknown>; parentTaskId?: string }>();

  get hasActivity(): boolean { return [...this.backgroundIds].some((id) => { const task = this.rows.get(id); return task && claudeTaskActive(task) && !task.ambient; }); }

  private task(id: unknown, runId?: unknown): ClaudeTask | null {
    if (typeof id !== "string" || !CLAUDE_TASK_ID.test(id)) return null;
    const prior = this.rows.get(id);
    const run = text(runId, 200);
    if (run && prior?.runId && run < prior.runId) return null;
    if (prior && (!run || run === prior.runId || (!prior.runId && claudeTaskActive(prior)))) {
      if (run) prior.runId = run;
      return prior;
    }
    const task: ClaudeTask = { id, runId: run, type: "task", status: "unknown", description: "", background: false, ambient: false };
    this.backgroundIds.delete(id);
    this.rows.set(id, task);
    return task;
  }

  private admitted(task: ClaudeTask): boolean { return !this.levelReceived || !task.background || this.backgroundIds.has(task.id); }

  private metadata(task: ClaudeTask, record: Record<string, unknown>): void {
    if (typeof record.task_type === "string") task.type = taskType(record.task_type);
    if (typeof record.description === "string") task.description = text(record.description)!;
    if (typeof record.tool_use_id === "string") task.toolUseId = text(record.tool_use_id, 200);
    if (typeof record.subagent_type === "string") { task.agentType = text(record.subagent_type, 200); if (task.type === "task") task.type = "subagent"; }
    if (typeof record.parent_task_id === "string" && CLAUDE_TASK_ID.test(record.parent_task_id)) task.parentTaskId = record.parent_task_id;
    if (typeof record.is_backgrounded === "boolean") task.background = record.is_backgrounded;
    if (typeof record.ambient === "boolean") task.ambient = record.ambient;
    if (record.skip_transcript === true) task.ambient = true;
    if (typeof record.prompt === "string") task.prompt = text(record.prompt, 16_000);
    if (typeof record.summary === "string") task.summary = text(record.summary, 8000);
    if (typeof record.error === "string") task.error = text(record.error, 4000);
    if (typeof record.last_tool_name === "string") task.lastToolName = text(record.last_tool_name, 200);
    if (typeof record.end_time === "number") task.endedAt = number(record.end_time);
    if (record.usage && typeof record.usage === "object") {
      const usage = object(record.usage);
      task.usage = { totalTokens: number(usage.total_tokens), toolUses: number(usage.tool_uses), durationMs: number(usage.duration_ms) };
    }
    const tool = task.toolUseId ? this.tools.get(task.toolUseId) : undefined;
    if (!tool) return;
    if (tool.name === "Monitor") task.type = "monitor";
    else if (tool.name === "Bash" && task.type === "task") task.type = "shell";
    else if (["Agent", "Task"].includes(tool.name)) task.type = "subagent";
    else if (tool.name === "Workflow") task.type = "workflow";
    task.description ||= text(tool.input.description) || "";
    task.command = text(tool.input.command, 8000) || text(object(tool.input.ws).url, 8000) || task.command;
    task.prompt ||= text(tool.input.prompt, 16_000);
    task.agentType ||= text(tool.input.subagent_type, 200);
    task.parentTaskId ||= tool.parentTaskId;
  }

  observe(record: Record<string, unknown>): void {
    if (record.type === "assistant") {
      const raw = object(record.message).content;
      for (const value of Array.isArray(raw) ? raw : []) {
        const block = object(value);
        if (block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") continue;
        const input = object(block.input);
        this.tools.set(block.id, { name: block.name, input: { description: text(input.description), command: text(input.command, 8000), prompt: text(input.prompt, 16_000), subagent_type: text(input.subagent_type, 200), ws: { url: text(object(input.ws).url, 8000) } }, parentTaskId: text(record.agent_id, 200) });
        for (const task of this.rows.values()) if (task.toolUseId === block.id) this.metadata(task, {});
      }
    }
    if (record.type === "user") this.toolResult(record);
    if (record.type !== "system") return;
    if (record.subtype === "background_tasks_changed" && Array.isArray(record.tasks)) {
      const before = new Set(this.backgroundIds);
      this.backgroundIds.clear();
      this.levelReceived = true;
      for (const value of record.tasks) {
        const raw = object(value);
        const task = this.task(raw.task_id, raw.run_id);
        if (!task) {
          if (typeof raw.task_id === "string" && before.has(raw.task_id)) this.backgroundIds.add(raw.task_id);
          continue;
        }
        this.metadata(task, raw);
        task.background = true;
        if (task.status === "unknown") task.status = "running";
        if (claudeTaskActive(task)) this.backgroundIds.add(task.id);
      }
      for (const id of before) {
        const task = this.rows.get(id);
        if (!this.backgroundIds.has(id) && task && claudeTaskActive(task)) task.status = "unknown";
      }
      return;
    }
    if (typeof record.subtype !== "string" || !["task_started", "task_updated", "task_progress", "task_notification"].includes(record.subtype)) return;
    const task = this.task(record.task_id, record.run_id);
    if (!task) return;
    this.metadata(task, record);
    if (record.subtype === "task_updated") {
      const patch = object(record.patch);
      this.metadata(task, patch);
      const next = status(patch.status);
      if (next && (!["pending", "running", "paused"].includes(next) || (this.admitted(task) && (task.status === "unknown" || claudeTaskActive(task))))) task.status = next;
    } else if (record.subtype === "task_notification") {
      task.status = status(record.status) ?? task.status;
      task.endedAt ??= Date.now();
    } else if (task.status === "unknown" && this.admitted(task)) task.status = "running";
    if (record.subtype === "task_started") {
      task.startedAt ??= Date.now();
      // Older CLIs omit the foreground/background field and the level signal.
      if (record.is_backgrounded === undefined) task.background = true;
    }
    if (!claudeTaskActive(task)) this.backgroundIds.delete(task.id);
    else if (!this.levelReceived && task.background) this.backgroundIds.add(task.id);
  }

  private toolResult(record: Record<string, unknown>): void {
    const raw = object(record.message).content;
    const result = object(record.toolUseResult ?? record.tool_use_result);
    for (const value of Array.isArray(raw) ? raw : []) {
      const block = object(value);
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const id = result.backgroundTaskId ?? result.taskId ?? result.agentId;
      const task = typeof id === "string" ? this.task(id) : [...this.rows.values()].find((task) => task.toolUseId === block.tool_use_id);
      if (!task || (task.runId && task.toolUseId && task.toolUseId !== block.tool_use_id)) continue;
      this.metadata(task, { tool_use_id: block.tool_use_id, description: result.description, prompt: result.prompt });
      const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
      if (Number.isFinite(timestamp)) task.startedAt ??= timestamp;
      // Tool results have no run_id. Modern lifecycle events alone own the status.
      if (!task.runId) {
        if (result.status === "async_launched" || result.backgroundTaskId || result.taskId) task.background = true;
        if (result.interrupted === true) task.status = "stopped";
        else if (result.status === "completed" || block.is_error === true) task.status = block.is_error ? "failed" : "completed";
        else if (!id) task.status = "completed";
        else if (task.status === "unknown" && this.admitted(task)) task.status = "running";
      }
      if (!claudeTaskActive(task)) this.backgroundIds.delete(task.id);
      else if (!this.levelReceived && task.background) this.backgroundIds.add(task.id);
    }
    // Only CLI-owned notification records are parsed, never arbitrary user XML.
    if (object(record.origin).kind === "task-notification") this.notification(object(record.message).content, object(record.origin).runId);
  }

  private notification(content: unknown, runId?: unknown): void {
    if (typeof content !== "string") return;
    const tag = (name: string) => content.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
    const task = this.task(tag("task-id"), runId);
    if (!task) return;
    task.status = status(tag("status")) ?? task.status;
    task.summary = text(tag("result") || tag("event") || tag("summary"), 8000) || task.summary;
    task.toolUseId ||= text(tag("tool-use-id"), 200);
    if (tag("usage")) task.usage = { totalTokens: number(Number(tag("subagent_tokens"))), toolUses: number(Number(tag("tool_uses"))), durationMs: number(Number(tag("duration_ms"))) };
    if (!claudeTaskActive(task)) this.backgroundIds.delete(task.id);
  }

  restore(records: Iterable<Record<string, unknown>>): void {
    this.rows.clear(); this.tools.clear(); this.backgroundIds.clear(); this.levelReceived = false;
    for (const record of records) {
      this.observe(record);
      const attachment = object(record.attachment);
      if (record.type === "attachment" && attachment.type === "queued_command" && attachment.commandMode === "task-notification") this.notification(attachment.prompt, attachment.runId);
    }
    this.disconnect();
  }

  disconnect(): void {
    this.backgroundIds.clear(); this.levelReceived = false;
    for (const task of this.rows.values()) if (claudeTaskActive(task)) task.status = "unknown";
  }
}

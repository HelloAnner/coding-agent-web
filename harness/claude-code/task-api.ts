import { readFileSync } from "node:fs";
import { readCatalogSession } from "../../lib/catalog-db";
import { resolveClaudeProfile } from "./index";
import { findClaudeRun } from "./runtime";
import { ClaudeTasks, CLAUDE_TASK_ID, claudeTaskActive, type ClaudeTaskSnapshot } from "./tasks";
import { claudeNativeRecords, claudeSubagentIds, claudeTranscriptFile, CLAUDE_UUID, readClaudeSubagentTranscript } from "./transcript";

type Context = { params: Promise<{ id: string }> };
const headers = { "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });

function scope(id: string) {
  if (!CLAUDE_UUID.test(id)) return reply({ error: "Invalid Claude Code session id" }, 400);
  const session = readCatalogSession(id);
  if (!session || session.harness !== "claude-code") return reply({ error: "Session not found" }, 404);
  const run = findClaudeRun(id);
  // Stopping an existing native process must remain possible after its profile is disabled.
  const profile = run?.profile ?? resolveClaudeProfile(session.model, session.provider, true);
  if (profile.id !== session.model || profile.provider !== session.provider || profile.configDir !== session.sessionPath) return reply({ error: "This session keeps its original Claude Code profile" }, 409);
  return { profile, run };
}

function snapshot(id: string, scoped: Exclude<ReturnType<typeof scope>, Response>): ClaudeTaskSnapshot {
  if (scoped.run?.child?.stdin.writable) return scoped.run.taskSnapshot();
  const tasks = new ClaudeTasks();
  const file = claudeTranscriptFile(scoped.profile.configDir, id);
  // ponytail: rebuild metadata from the native log when offline; cache by file stat if large histories make this slow.
  if (file) tasks.restore(claudeNativeRecords(readFileSync(file, "utf8")));
  for (const agentId of claudeSubagentIds(scoped.profile.configDir, id)) {
    if (!tasks.rows.has(agentId)) tasks.rows.set(agentId, { id: agentId, type: "subagent", status: "unknown", description: "", background: false, ambient: false });
  }
  return { connected: false, foreground: false, tasks: [...tasks.rows.values()] };
}

export async function GET(req: Request, { params }: Context) {
  try {
    const { id } = await params;
    const scoped = scope(id);
    if (scoped instanceof Response) return scoped;
    const state = snapshot(id, scoped);
    const query = new URL(req.url).searchParams;
    const taskId = query.get("task");
    if (taskId === null) return reply(state);
    if (!CLAUDE_TASK_ID.test(taskId)) return reply({ error: "Invalid Claude Code task id" }, 400);
    const task = state.tasks.find((task) => task.id === taskId);
    if (!task) return reply({ error: "Task not found in this session" }, 404);
    if (query.has("run") && query.get("run") !== task.runId) return reply({ error: "This task has started a different run. Refresh its state." }, 409);
    if (task.type === "subagent") {
      const messages = readClaudeSubagentTranscript(scoped.profile.configDir, id, taskId);
      // ponytail: show the last 120 native messages; add paging when long agent runs need earlier work.
      return reply({ task, messages: messages.slice(-120), truncated: messages.length > 120 });
    }
    if (task.type !== "shell" && task.type !== "monitor") return reply({ task });
    if (!scoped.run?.child?.stdin.writable) return reply({ error: "The native Claude Code process is offline; live task output is unavailable" }, 409);
    const result = await scoped.run.request({ subtype: "get_task_output", task_id: taskId });
    if (scoped.run.tasks.rows.get(taskId)?.runId !== task.runId) return reply({ error: "This task has started a different run. Refresh its state." }, 409);
    if (typeof result.output !== "string") return reply({ error: "Claude Code did not return task output. Update the native CLI." }, 400);
    const output = result.output;
    return reply({ task, output: scoped.run.redactOutput(output.slice(-8192)), totalBytes: typeof result.total_bytes === "number" ? result.total_bytes : 0, truncated: result.truncated === true || output.length > 8192 });
  } catch (error) { return reply({ error: error instanceof Error ? error.message : "Could not read Claude Code tasks" }, 400); }
}

export async function POST(req: Request, { params }: Context) {
  try {
    const { id } = await params;
    const scoped = scope(id);
    if (scoped instanceof Response) return scoped;
    const raw = await req.text();
    if (raw.length > 2048) return reply({ error: "Task request is too large" }, 413);
    let body: { action?: unknown; taskId?: unknown; runId?: unknown } | null;
    try { body = JSON.parse(raw); } catch { return reply({ error: "Expected a task JSON object" }, 400); }
    if (!body || (body.action !== "stop" && body.action !== "background") || typeof body.taskId !== "string" || !CLAUDE_TASK_ID.test(body.taskId) || (body.runId !== undefined && (typeof body.runId !== "string" || body.runId.length > 200))) return reply({ error: "Invalid Claude Code task action" }, 400);
    const run = scoped.run;
    if (!run?.child?.stdin.writable) return reply({ error: "The native Claude Code process is offline" }, 409);
    const task = run.tasks.rows.get(body.taskId);
    if (!task) return reply({ error: "Task not found in this session" }, 404);
    if (body.runId !== undefined && task.runId !== body.runId) return reply({ error: "This task has started a different run. Refresh its state." }, 409);
    if (!claudeTaskActive(task)) return reply({ error: "This task is no longer running" }, 409);
    if (body.action === "background") {
      if (task.background || !task.toolUseId || (task.type !== "shell" && task.type !== "subagent")) return reply({ error: "This task cannot be moved to the background" }, 400);
      const result = await run.request({ subtype: "background_tasks", tool_use_id: task.toolUseId });
      if (result.backgrounded === false) return reply({ error: "The foreground task has already changed. Refresh its state." }, 409);
    } else await run.request({ subtype: "stop_task", task_id: task.id });
    // The native lifecycle events, not the button click, determine the resulting status.
    return reply({ success: true });
  } catch (error) { return reply({ error: error instanceof Error ? error.message : "Claude Code task action failed" }, 400); }
}

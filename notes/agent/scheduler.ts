import { SubagentQueue } from "@/lib/subagent-queue";
import type { NotesTaskDefinition, NotesTaskPreparation, NotesTaskRun, NotesTaskStatus, NotesTaskView } from "../types";
import { createNotesSession } from "./profile";
import { nextRunAt } from "./schedule";
import { NOTES_SCHEDULED_TASKS } from "./tasks";

/**
 * The timed pool behind the notes agent. Tasks are declared in tasks.ts; each
 * fire takes a slot in one FIFO queue and builds its own short-lived session
 * (own tools, skills, system prompt) on the shared model runtime. Nothing here
 * touches the interactive panel's session.
 *
 * Run state is in memory: a restart clears history but keeps the definitions.
 */

/** Model calls at once. More parallel notes jobs mostly means rate limits. */
export const NOTES_TASK_CONCURRENCY = 2;

const TICK_MS = 15_000;
const DEFAULT_TIMEOUT_MINUTES = 15;
const KEPT_RUNS = 10;
const TEXT_LIMIT = 4000;
const QUEUE_PARENT = "notes-scheduler";

export class NotesTaskError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
  }
}

interface Entry {
  task: NotesTaskDefinition;
  /** When the pool should fire it next; null while it has no schedule. */
  nextAt: number | null;
  status: NotesTaskStatus;
  lastRun?: NotesTaskRun;
  runs: NotesTaskRun[];
}

function textOf(chunk: string): string {
  return chunk.length > TEXT_LIMIT ? `${chunk.slice(0, TEXT_LIMIT)}…` : chunk;
}

class NotesTaskScheduler {
  private readonly entries = new Map<string, Entry>();
  private readonly queue = new SubagentQueue<void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Register the declared tasks and start the clock. Safe to call twice. */
  start(tasks: readonly NotesTaskDefinition[] = NOTES_SCHEDULED_TASKS): void {
    for (const task of tasks) this.register(task);
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  /** Add or replace one definition; run state survives a definition update. */
  register(task: NotesTaskDefinition): void {
    const nextAt = nextRunAt(task, new Date());
    if (task.enabled === false || nextAt === null) {
      this.entries.delete(task.id);
      return;
    }
    const existing = this.entries.get(task.id);
    if (existing) existing.task = task;
    else this.entries.set(task.id, { task, nextAt, status: "idle", runs: [] });
  }

  /** Fire every task whose slot has come. */
  tick(): void {
    const now = Date.now();
    for (const entry of this.entries.values()) {
      if (entry.status === "queued" || entry.status === "running") continue;
      if (entry.nextAt === null || now < entry.nextAt) continue;
      this.enqueue(entry);
    }
  }

  list(): NotesTaskView[] {
    return [...this.entries.values()]
      .sort((a, b) => a.task.id.localeCompare(b.task.id))
      .map((entry) => ({
        ...entry.task,
        status: entry.status,
        nextRunAt: entry.nextAt,
        ...(entry.lastRun ? { lastRun: entry.lastRun } : {}),
      }));
  }

  /** Queue one task now and reschedule its regular slot from this run. */
  runNow(id: string): NotesTaskView {
    const entry = this.entries.get(id);
    if (!entry) throw new NotesTaskError(`没有这个定时任务：${id}`, 404);
    if (entry.status === "queued" || entry.status === "running") {
      throw new NotesTaskError("任务正在运行", 409);
    }
    this.enqueue(entry);
    return this.list().find((view) => view.id === id)!;
  }

  private enqueue(entry: Entry): void {
    entry.status = "queued";
    // Reserve the next slot before the run starts, so a slow task skips beats
    // instead of firing back-to-back.
    entry.nextAt = nextRunAt(entry.task, new Date());
    void this.queue.enqueue(QUEUE_PARENT, NOTES_TASK_CONCURRENCY, () => this.run(entry), () => {});
  }

  private async run(entry: Entry): Promise<void> {
    const { task } = entry;
    entry.status = "running";
    const started = Date.now();
    let text = "";
    let timedOut = false;
    let preparation: NotesTaskPreparation | null = null;
    try {
      preparation = task.prepare ? await task.prepare() : { prompt: task.prompt };
    } catch (error) {
      preparation = null;
      this.finish(entry, started, "error", "", error instanceof Error ? error.message : String(error));
      return;
    }
    if (!preparation) {
      // Nothing to do this round: no session, no model call, nothing logged.
      entry.status = "skipped";
      return;
    }
    let prompted = false;
    let status: NotesTaskStatus = "error";
    try {
      const { session } = await createNotesSession({
        systemPrompt: task.systemPrompt,
        skills: task.skills,
        tools: task.tools,
      });
      const unsubscribe = session.subscribe((event) => {
        const delta = (event as { assistantMessageEvent?: { type?: string; delta?: unknown } }).assistantMessageEvent;
        if (delta?.type === "text_delta" && typeof delta.delta === "string") text += delta.delta;
      });
      const timeout = Math.max(1, task.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES);
      const timer = setTimeout(() => {
        timedOut = true;
        void session.abort();
      }, timeout * 60_000);
      try {
        prompted = true;
        await session.prompt(preparation.prompt);
      } finally {
        clearTimeout(timer);
        unsubscribe();
        session.dispose();
      }
      status = timedOut ? "timeout" : "ok";
      this.finish(entry, started, status, text, timedOut ? `超过 ${timeout} 分钟未完成` : undefined);
    } catch (error) {
      status = timedOut ? "timeout" : "error";
      const message = error instanceof Error ? error.message : String(error);
      this.finish(entry, started, status, text, message);
    }
    // Only a turn that actually ran consumed the session it was given; one
    // that never got a session leaves the work for the next tick.
    if (prompted && preparation.after) {
      try {
        await preparation.after(status);
      } catch (error) {
        console.error(`[notes-task] ${task.id} after failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private finish(entry: Entry, started: number, status: NotesTaskStatus, text: string, error?: string): void {
    const run: NotesTaskRun = {
      at: started,
      durationMs: Date.now() - started,
      status,
      ...(text.trim() ? { text: textOf(text.trim()) } : {}),
      ...(error ? { error } : {}),
    };
    entry.status = status;
    entry.lastRun = run;
    entry.runs.unshift(run);
    entry.runs.length = Math.min(entry.runs.length, KEPT_RUNS);
    console.log(`[notes-task] ${entry.task.id} ${status} ${run.durationMs}ms${error ? `: ${error}` : ""}`);
  }
}

declare global {
  // Survives a Next dev reload; tasks and run state are process-wide.
  var __piWebNotesScheduler: NotesTaskScheduler | undefined;
}

export function getNotesTaskScheduler(): NotesTaskScheduler {
  globalThis.__piWebNotesScheduler ??= new NotesTaskScheduler();
  return globalThis.__piWebNotesScheduler;
}

/** Boot entry: register tasks.ts and start ticking. */
export function startNotesScheduler(): void {
  getNotesTaskScheduler().start();
}

export function listNotesTasks(): NotesTaskView[] {
  return getNotesTaskScheduler().list();
}

export function runNotesTaskNow(id: string): NotesTaskView {
  return getNotesTaskScheduler().runNow(id);
}

/**
 * When a scheduled notes task runs next. Pure time math, no agent imports, so
 * it can be tested without building a session.
 */

export interface NotesTaskSchedule {
  /** Run every N seconds, counted from the previous run. */
  everySeconds?: number;
  /** Run every N minutes, counted from the previous run. */
  everyMinutes?: number;
  /** Run once a day at local "HH:MM". */
  dailyAt?: string;
}

const DAILY_AT = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function positive(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** The first scheduled time strictly after `from`, or null without a schedule. */
export function nextRunAt(schedule: NotesTaskSchedule, from: Date): number | null {
  const seconds = positive(schedule.everySeconds);
  if (seconds !== null) return from.getTime() + Math.round(seconds) * 1000;
  const every = positive(schedule.everyMinutes);
  if (every !== null) {
    return from.getTime() + Math.round(every) * 60_000;
  }
  const match = typeof schedule.dailyAt === "string" ? DAILY_AT.exec(schedule.dailyAt.trim()) : null;
  if (!match) return null;
  const next = new Date(from);
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

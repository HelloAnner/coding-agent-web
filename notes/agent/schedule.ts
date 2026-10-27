/**
 * When a scheduled notes task runs next. Pure time math, no agent imports, so
 * it can be tested without building a session.
 */

export interface NotesTaskSchedule {
  /** Run every N minutes, counted from the previous run. */
  everyMinutes?: number;
  /** Run once a day at local "HH:MM". */
  dailyAt?: string;
}

const DAILY_AT = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** The first scheduled time strictly after `from`, or null without a schedule. */
export function nextRunAt(schedule: NotesTaskSchedule, from: Date): number | null {
  const every = schedule.everyMinutes;
  if (typeof every === "number" && Number.isFinite(every) && every > 0) {
    return from.getTime() + Math.round(every) * 60_000;
  }
  const match = typeof schedule.dailyAt === "string" ? DAILY_AT.exec(schedule.dailyAt.trim()) : null;
  if (!match) return null;
  const next = new Date(from);
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

import { CronExpressionParser } from "cron-parser";

export function validateCron(expr: string, timezone = "UTC"): { ok: true; next: Date[] } | { ok: false; error: string } {
  try {
    if (expr.trim().split(/\s+/).length !== 5) return { ok: false, error: "Use 5 fields: minute hour day-of-month month day-of-week" };
    const it = CronExpressionParser.parse(expr, { tz: timezone });
    const next = [it.next().toDate(), it.next().toDate(), it.next().toDate()];
    // Refuse schedules more frequent than once a minute (not expressible in 5 fields anyway) or invalid timezones.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return { ok: true, next };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function nextRun(expr: string, timezone: string, after: Date): Date {
  return CronExpressionParser.parse(expr, { tz: timezone, currentDate: after }).next().toDate();
}

/** True when a run is due between `from` (exclusive) and `to` (inclusive). */
export function isDue(expr: string, timezone: string, from: Date, to: Date): boolean {
  try {
    return nextRun(expr, timezone, from).getTime() <= to.getTime();
  } catch {
    return false;
  }
}

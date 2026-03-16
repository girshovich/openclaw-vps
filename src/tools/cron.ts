import { createCronJob, deleteCronJob, listCronJobs } from '../memory/sqlite.js';

export function parseSchedule(schedule: string): { nextRunAt: number; recurrent: boolean } | null {
  const now = Date.now();

  const everyMatch = schedule.match(/^every\s+(\d+)(m|h|d)$/i);
  if (everyMatch) {
    const n = parseInt(everyMatch[1]!);
    const unit = everyMatch[2]!.toLowerCase();
    const ms = unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000;
    return { nextRunAt: now + ms, recurrent: true };
  }

  const dailyMatch = schedule.match(/^daily\s+(\d{1,2}):(\d{2})$/i);
  if (dailyMatch) {
    const h = parseInt(dailyMatch[1]!);
    const m = parseInt(dailyMatch[2]!);
    const next = new Date();
    next.setHours(h, m, 0, 0);
    if (next.getTime() <= now) next.setDate(next.getDate() + 1);
    return { nextRunAt: next.getTime(), recurrent: true };
  }

  const ts = Date.parse(schedule);
  if (!isNaN(ts)) return { nextRunAt: ts, recurrent: false };

  return null;
}

export function nextRunAfter(schedule: string, lastRunAt: number): number | null {
  const everyMatch = schedule.match(/^every\s+(\d+)(m|h|d)$/i);
  if (everyMatch) {
    const n = parseInt(everyMatch[1]!);
    const unit = everyMatch[2]!.toLowerCase();
    const ms = unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000;
    return lastRunAt + ms;
  }

  const dailyMatch = schedule.match(/^daily\s+(\d{1,2}):(\d{2})$/i);
  if (dailyMatch) {
    const h = parseInt(dailyMatch[1]!);
    const m = parseInt(dailyMatch[2]!);
    const next = new Date(lastRunAt);
    next.setHours(h, m, 0, 0);
    next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  return null; // one-time
}

export function executeCronCreate(sessionId: string, description: string, schedule: string): string {
  const parsed = parseSchedule(schedule);
  if (!parsed) {
    return `Invalid schedule: "${schedule}". Use "every Xm/h/d", "daily HH:MM", or an ISO datetime.`;
  }
  const id = createCronJob({ sessionId, description, schedule, recurrent: parsed.recurrent, nextRunAt: parsed.nextRunAt });
  const next = new Date(parsed.nextRunAt).toISOString();
  return `Cron job created (id: ${id}). Next run: ${next}. Recurring: ${parsed.recurrent}.`;
}

export function executeCronList(sessionId: string): string {
  const jobs = listCronJobs(sessionId);
  if (jobs.length === 0) return 'No active cron jobs.';
  return jobs.map((j) => {
    const next = new Date(j.next_run_at).toISOString();
    return `[${j.id.slice(0, 8)}] "${j.description}" — ${j.schedule} — next: ${next}`;
  }).join('\n');
}

export function executeCronDelete(id: string): string {
  deleteCronJob(id);
  return `Cron job ${id} deleted.`;
}

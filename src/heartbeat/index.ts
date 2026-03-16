import {
  getActiveSessions,
  getAllPendingTasks,
  getDueCronJobs,
  updateCronJobAfterRun,
  updateSessionStatus,
  incrementTaskRetry,
} from '../memory/sqlite.js';
import { runTurn } from '../runtime/index.js';
import { archiveSession } from '../runtime/archive.js';
import { flushPendingEmbeddings } from '../memory/embeddings.js';
import { nextRunAfter } from '../tools/cron.js';
import { enqueue, isLaneActive } from '../gateway/lane-queue.js';

const HEARTBEAT_MS = 5 * 60 * 1000;    // 5 minutes
const CRON_MS = 60 * 1000;             // 1 minute
const EMBED_FLUSH_MS = 10 * 60 * 1000; // 10 minutes
const IDLE_AFTER_MS = 4 * 60 * 60 * 1000;     // 4 hours
const ARCHIVE_AFTER_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

const FIRST_RETRY_MS  = 5 * 60 * 1000;  // 5 minutes after last activity
const SECOND_RETRY_MS = 60 * 60 * 1000; // 1 hour after first retry

export function startHeartbeat(): void {
  setInterval(() => void heartbeatTick(), HEARTBEAT_MS);
  setInterval(() => void cronTick(), CRON_MS);
  setInterval(() => void flushPendingEmbeddings(), EMBED_FLUSH_MS);
  console.log('[heartbeat] started');
}

async function heartbeatTick(): Promise<void> {
  const now = Date.now();

  for (const session of getActiveSessions()) {
    const age = now - session.updated_at;

    if (session.status === 'active' && age > IDLE_AFTER_MS) {
      updateSessionStatus(session.session_id, 'idle');
      continue;
    }

    if (session.status === 'idle' && age > ARCHIVE_AFTER_MS) {
      await archiveSession(session.session_id).catch((err) =>
        console.error('[heartbeat] archive error:', err),
      );
    }
  }

  // Trigger agent for sessions with pending tasks using a 2-attempt retry schedule:
  //   retry_count == 0 → trigger after 5 min of inactivity
  //   retry_count == 1 → trigger 1 hour after the first retry
  //   retry_count >= 2 → stop
  // User reply resets retry_count to 0 (see gateway).
  const sessions = getActiveSessions();
  const sessionMap = new Map(sessions.map((s) => [s.session_id, s]));

  for (const task of getAllPendingTasks()) {
    const session = sessionMap.get(task.session_id);
    if (!session) continue;
    if (isLaneActive(task.session_id)) continue; // agent already running

    if (task.retry_count === 0) {
      if (now - session.updated_at < FIRST_RETRY_MS) continue;
    } else if (task.retry_count === 1) {
      if (task.last_retried_at === null || now - task.last_retried_at < SECOND_RETRY_MS) continue;
    } else {
      continue; // max retries reached
    }

    incrementTaskRetry(task.id);
    void enqueue(task.session_id, () =>
      runTurn(task.session_id, `[System: continue unfinished task: ${task.description}]`),
    ).catch((err) => console.error('[heartbeat] task continuation error:', err));
  }
}

async function cronTick(): Promise<void> {
  for (const job of getDueCronJobs()) {
    void enqueue(job.session_id, () => runTurn(job.session_id, `[Cron: ${job.description}]`))
      .then(() => {
        const next = job.recurrent ? nextRunAfter(job.schedule, Date.now()) : null;
        updateCronJobAfterRun(job.id, next);
      })
      .catch((err) => {
        console.error(`[cron] job ${job.id} failed:`, err);
        const next = job.recurrent ? nextRunAfter(job.schedule, Date.now()) : null;
        updateCronJobAfterRun(job.id, next);
      });
  }
}

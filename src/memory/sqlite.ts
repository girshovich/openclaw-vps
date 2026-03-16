import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { MessageRole, SessionStatus, ChannelType } from '../types.js';

export interface DbMessage {
  id: number;
  session_id: string;
  message_id: string;
  role: MessageRole;
  content: string;
  tool_call_id: string | null;
  model_used: string | null;
  token_count: number;
  metadata: string;
  created_at: number;
}

export interface DbSession {
  session_id: string;
  parent_session_id: string | null;
  depth: number;
  status: SessionStatus;
  channel: string | null;
  channel_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface DbTask {
  id: string;
  session_id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  retry_count: number;
  last_retried_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface DbCronJob {
  id: string;
  session_id: string;
  description: string;
  schedule: string;
  recurrent: number;
  next_run_at: number;
  last_run_at: number | null;
  status: 'active' | 'paused' | 'completed';
  created_at: number;
}

export interface DbPendingEmbedding {
  id: string;
  session_id: string;
  text: string;
  metadata: string;
  created_at: number;
}

let db: Database.Database;

export function initDb(): void {
  const dbPath = process.env['DB_PATH'] ?? ':memory:';
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id        TEXT    PRIMARY KEY NOT NULL,
      parent_session_id TEXT,
      depth             INTEGER NOT NULL DEFAULT 0,
      status            TEXT    NOT NULL DEFAULT 'active',
      channel           TEXT,
      channel_id        TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT    NOT NULL REFERENCES sessions(session_id),
      message_id   TEXT    NOT NULL UNIQUE,
      role         TEXT    NOT NULL,
      content      TEXT    NOT NULL,
      tool_call_id TEXT,
      model_used   TEXT,
      token_count  INTEGER NOT NULL DEFAULT 0,
      metadata     TEXT    NOT NULL DEFAULT '{}',
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id               TEXT    PRIMARY KEY NOT NULL,
      session_id       TEXT    NOT NULL REFERENCES sessions(session_id),
      description      TEXT    NOT NULL,
      status           TEXT    NOT NULL DEFAULT 'pending',
      retry_count      INTEGER NOT NULL DEFAULT 0,
      last_retried_at  INTEGER,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cron_jobs (
      id          TEXT    PRIMARY KEY NOT NULL,
      session_id  TEXT    NOT NULL REFERENCES sessions(session_id),
      description TEXT    NOT NULL,
      schedule    TEXT    NOT NULL,
      recurrent   INTEGER NOT NULL DEFAULT 0,
      next_run_at INTEGER NOT NULL,
      last_run_at INTEGER,
      status      TEXT    NOT NULL DEFAULT 'active',
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_embeddings (
      id         TEXT    PRIMARY KEY NOT NULL,
      session_id TEXT    NOT NULL,
      text       TEXT    NOT NULL,
      metadata   TEXT    NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session  ON messages (session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_channel  ON sessions (channel, channel_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_session     ON tasks (session_id, status);
    CREATE INDEX IF NOT EXISTS idx_cron_next         ON cron_jobs (next_run_at, status);
  `);

  // Migrations for existing databases
  try { db.exec(`ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE tasks ADD COLUMN last_retried_at INTEGER`); } catch { /* already exists */ }
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export function createSession(opts: {
  channel?: ChannelType;
  channelId?: string;
  parentSessionId?: string;
  depth?: number;
}): string {
  const sessionId = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO sessions
      (session_id, parent_session_id, depth, status, channel, channel_id, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(
    sessionId,
    opts.parentSessionId ?? null,
    opts.depth ?? 0,
    opts.channel ?? null,
    opts.channelId ?? null,
    now,
    now,
  );
  return sessionId;
}

export function findOrCreateSession(channel: ChannelType, channelId: string): string {
  const row = db.prepare(
    `SELECT session_id FROM sessions
     WHERE channel = ? AND channel_id = ? AND status != 'archived'
     ORDER BY updated_at DESC LIMIT 1`,
  ).get(channel, channelId) as { session_id: string } | undefined;
  return row?.session_id ?? createSession({ channel, channelId });
}

export function getSession(sessionId: string): DbSession | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId) as DbSession | undefined;
}

export function getActiveSessions(): DbSession[] {
  return db.prepare(
    `SELECT * FROM sessions WHERE status IN ('active', 'idle') AND depth = 0`,
  ).all() as DbSession[];
}

export function updateSessionStatus(sessionId: string, status: SessionStatus): void {
  db.prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?`)
    .run(status, Date.now(), sessionId);
}

// ── Messages ──────────────────────────────────────────────────────────────────

export function appendMessage(
  sessionId: string,
  msg: {
    role: MessageRole;
    content: string;
    toolCallId?: string;
    modelUsed?: string;
    tokenCount?: number;
    metadata?: Record<string, unknown>;
  },
): void {
  const now = Date.now();
  const tokenCount = msg.tokenCount ?? Math.ceil(msg.content.length / 4);
  db.prepare(`
    INSERT INTO messages
      (session_id, message_id, role, content, tool_call_id, model_used, token_count, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    randomUUID(),
    msg.role,
    msg.content,
    msg.toolCallId ?? null,
    msg.modelUsed ?? null,
    tokenCount,
    JSON.stringify(msg.metadata ?? {}),
    now,
  );
  db.prepare(`UPDATE sessions SET updated_at = ? WHERE session_id = ?`).run(now, sessionId);
}

export function getSessionHistory(sessionId: string): DbMessage[] {
  return db
    .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`)
    .all(sessionId) as DbMessage[];
}

export function replaceSessionHistory(
  sessionId: string,
  messages: Array<{
    role: MessageRole;
    content: string;
    toolCallId?: string;
    modelUsed?: string;
    tokenCount?: number;
    metadata?: Record<string, unknown>;
  }>,
): void {
  const now = Date.now();
  db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
  for (const msg of messages) {
    const tokenCount = msg.tokenCount ?? Math.ceil(msg.content.length / 4);
    db.prepare(`
      INSERT INTO messages
        (session_id, message_id, role, content, tool_call_id, model_used, token_count, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      randomUUID(),
      msg.role,
      msg.content,
      msg.toolCallId ?? null,
      msg.modelUsed ?? null,
      tokenCount,
      JSON.stringify(msg.metadata ?? {}),
      now,
    );
  }
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export function createTask(sessionId: string, description: string): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO tasks (id, session_id, description, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(id, sessionId, description, now, now);
  return id;
}

export function updateTaskStatus(id: string, status: DbTask['status']): void {
  db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, Date.now(), id);
}

export function getAllPendingTasks(): DbTask[] {
  return db.prepare(
    `SELECT * FROM tasks WHERE status IN ('pending', 'in_progress') ORDER BY created_at ASC`,
  ).all() as DbTask[];
}

export function listTasks(sessionId: string): DbTask[] {
  return db.prepare(
    `SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at DESC`,
  ).all(sessionId) as DbTask[];
}

export function incrementTaskRetry(taskId: string): void {
  db.prepare(
    `UPDATE tasks SET retry_count = retry_count + 1, last_retried_at = ?, updated_at = ? WHERE id = ?`,
  ).run(Date.now(), Date.now(), taskId);
}

export function resetTaskRetries(sessionId: string): void {
  db.prepare(
    `UPDATE tasks SET retry_count = 0, last_retried_at = NULL, updated_at = ? WHERE session_id = ? AND status IN ('pending', 'in_progress')`,
  ).run(Date.now(), sessionId);
}

// ── Cron jobs ─────────────────────────────────────────────────────────────────

export function createCronJob(opts: {
  sessionId: string;
  description: string;
  schedule: string;
  recurrent: boolean;
  nextRunAt: number;
}): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO cron_jobs (id, session_id, description, schedule, recurrent, next_run_at, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(id, opts.sessionId, opts.description, opts.schedule, opts.recurrent ? 1 : 0, opts.nextRunAt, Date.now());
  return id;
}

export function getDueCronJobs(): DbCronJob[] {
  return db.prepare(
    `SELECT * FROM cron_jobs WHERE status = 'active' AND next_run_at <= ?`,
  ).all(Date.now()) as DbCronJob[];
}

export function updateCronJobAfterRun(id: string, nextRunAt: number | null): void {
  if (nextRunAt !== null) {
    db.prepare(`UPDATE cron_jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?`)
      .run(Date.now(), nextRunAt, id);
  } else {
    db.prepare(`UPDATE cron_jobs SET last_run_at = ?, status = 'completed' WHERE id = ?`)
      .run(Date.now(), id);
  }
}

export function deleteCronJob(id: string): void {
  db.prepare(`UPDATE cron_jobs SET status = 'completed' WHERE id = ?`).run(id);
}

export function listCronJobs(sessionId: string): DbCronJob[] {
  return db.prepare(
    `SELECT * FROM cron_jobs WHERE session_id = ? AND status = 'active' ORDER BY next_run_at ASC`,
  ).all(sessionId) as DbCronJob[];
}

// ── Pending embeddings ────────────────────────────────────────────────────────

export function addPendingEmbedding(
  sessionId: string,
  text: string,
  metadata: Record<string, unknown> = {},
): void {
  db.prepare(`
    INSERT INTO pending_embeddings (id, session_id, text, metadata, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), sessionId, text, JSON.stringify(metadata), Date.now());
}

export function getPendingEmbeddings(): DbPendingEmbedding[] {
  return db.prepare(
    `SELECT * FROM pending_embeddings ORDER BY created_at ASC LIMIT 50`,
  ).all() as DbPendingEmbedding[];
}

export function deletePendingEmbedding(id: string): void {
  db.prepare(`DELETE FROM pending_embeddings WHERE id = ?`).run(id);
}

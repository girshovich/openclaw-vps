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

    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages (session_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_sessions_channel
      ON sessions (channel, channel_id, status);
  `);
}

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
    msg.tokenCount ?? 0,
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

export function updateSessionStatus(sessionId: string, status: SessionStatus): void {
  db.prepare(`UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?`)
    .run(status, Date.now(), sessionId);
}

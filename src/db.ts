import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentType, NormalizedMessage, Usage } from './model.js'

const DB_PATH = process.env.SPECTATOR_DB ?? join(homedir(), 'data', 'spectator', 'spectator.db')

mkdirSync(dirname(DB_PATH), { recursive: true })
export const db = new Database(DB_PATH)

db.pragma('journal_mode = WAL')
db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  path        TEXT PRIMARY KEY,
  agent       TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  offset      INTEGER NOT NULL DEFAULT 0,
  msg_count   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,   -- agent:sessionId
  agent         TEXT NOT NULL,
  project_path  TEXT,
  title         TEXT,
  model         TEXT,
  started_at    TEXT,
  ended_at      TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  seq         INTEGER NOT NULL,
  event_id    TEXT,
  role        TEXT NOT NULL,
  ts          TEXT,
  blocks_json TEXT NOT NULL,
  model       TEXT,
  usage_json  TEXT,
  UNIQUE(session_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
`)

const upsertSession = db.prepare(`
INSERT INTO sessions (id, agent, project_path, title, model, started_at, ended_at)
VALUES (@id, @agent, @project_path, @title, @model, @started_at, @ended_at)
ON CONFLICT(id) DO UPDATE SET
  project_path = COALESCE(excluded.project_path, sessions.project_path),
  title        = COALESCE(excluded.title, sessions.title),
  model        = COALESCE(excluded.model, sessions.model),
  started_at   = COALESCE(sessions.started_at, excluded.started_at),
  ended_at     = CASE WHEN excluded.ended_at > COALESCE(sessions.ended_at, '') THEN excluded.ended_at ELSE sessions.ended_at END
`)

const insertMessage = db.prepare(`
INSERT OR IGNORE INTO messages (session_id, seq, event_id, role, ts, blocks_json, model, usage_json)
VALUES (@session_id, @seq, @event_id, @role, @ts, @blocks_json, @model, @usage_json)
`)

const bumpSession = db.prepare(`
UPDATE sessions SET
  message_count = message_count + 1,
  ended_at      = CASE WHEN @ts > COALESCE(ended_at, '') THEN @ts ELSE ended_at END,
  input_tokens  = input_tokens + @input,
  output_tokens = output_tokens + @output
WHERE id = @id
`)

const setSessionUsage = db.prepare(`
UPDATE sessions SET input_tokens = @input, output_tokens = @output WHERE id = @id
`)

const getSource = db.prepare(`SELECT * FROM sources WHERE path = ?`)
const upsertSource = db.prepare(`
INSERT INTO sources (path, agent, session_id, offset, msg_count) VALUES (@path, @agent, @session_id, @offset, @msg_count)
ON CONFLICT(path) DO UPDATE SET offset = @offset, msg_count = @msg_count
`)

export interface SourceRow { path: string; agent: string; session_id: string; offset: number; msg_count: number }

export function readSource(path: string): SourceRow | undefined {
  return getSource.get(path) as SourceRow | undefined
}

export function saveSessionMeta(agent: AgentType, meta: { sessionId: string; projectPath?: string; startedAt?: string; title?: string; model?: string }, lastTs?: string) {
  upsertSession.run({
    id: `${agent}:${meta.sessionId}`,
    agent,
    project_path: meta.projectPath ?? null,
    title: meta.title ?? null,
    model: meta.model ?? null,
    started_at: meta.startedAt ?? null,
    ended_at: lastTs ?? null,
  })
  return `${agent}:${meta.sessionId}`
}

export function appendMessage(sessionPk: string, seq: number, msg: NormalizedMessage) {
  const info = insertMessage.run({
    session_id: sessionPk,
    seq,
    event_id: msg.eventId ?? null,
    role: msg.role,
    ts: msg.ts,
    blocks_json: JSON.stringify(msg.blocks),
    model: msg.model ?? null,
    usage_json: msg.usage ? JSON.stringify(msg.usage) : null,
  })
  if (info.changes > 0) {
    bumpSession.run({
      id: sessionPk,
      ts: msg.ts,
      input: msg.usage?.input ?? 0,
      output: msg.usage?.output ?? 0,
    })
  }
  return info.changes > 0
}

// codex 的 token_count 是累计值，直接覆盖而不是累加
export function setCumulativeUsage(sessionPk: string, usage: Usage) {
  setSessionUsage.run({ id: sessionPk, input: usage.input ?? 0, output: usage.output ?? 0 })
}

export function saveSource(row: SourceRow) {
  upsertSource.run(row)
}

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
  parent_id     TEXT,               -- 子 agent 会话 -> 父会话 id
  label         TEXT,               -- session_info 的会话名（pi-subagents worker 标记）
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
CREATE TABLE IF NOT EXISTS metrics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  ts          TEXT NOT NULL,
  cum_input   INTEGER NOT NULL,
  cum_output  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_session ON metrics(session_id, ts);
`)

// 轻量迁移：老库补 parent_id / label / avg_tps 列
try { db.exec(`ALTER TABLE sessions ADD COLUMN parent_id TEXT`) } catch { /* 已存在 */ }
try { db.exec(`ALTER TABLE sessions ADD COLUMN label TEXT`) } catch { /* 已存在 */ }
try { db.exec(`ALTER TABLE sessions ADD COLUMN avg_tps REAL`) } catch { /* 已存在 */ }

const upsertSession = db.prepare(`
INSERT INTO sessions (id, agent, parent_id, label, project_path, title, model, started_at, ended_at)
VALUES (@id, @agent, @parent_id, @label, @project_path, @title, @model, @started_at, @ended_at)
ON CONFLICT(id) DO UPDATE SET
  parent_id    = COALESCE(excluded.parent_id, sessions.parent_id),
  label        = COALESCE(excluded.label, sessions.label),
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
  output_tokens = output_tokens + @output,
  avg_tps       = NULL   -- 新消息使 TPS 过期，标记待重算
WHERE id = @id
`)

const setSessionUsage = db.prepare(`
UPDATE sessions SET input_tokens = @input, output_tokens = @output WHERE id = @id
`)

const getSource = db.prepare(`SELECT * FROM sources WHERE path = ?`)
const sessionPkByPath = db.prepare(`SELECT agent, session_id FROM sources WHERE path = ?`)
const sessionMsgCount = db.prepare(`SELECT COUNT(*) n FROM messages WHERE session_id = ?`)
const sessionHashes = db.prepare(`SELECT role, blocks_json FROM messages WHERE session_id = ?`)
const upsertSource = db.prepare(`
INSERT INTO sources (path, agent, session_id, offset, msg_count) VALUES (@path, @agent, @session_id, @offset, @msg_count)
ON CONFLICT(path) DO UPDATE SET offset = @offset, msg_count = @msg_count
`)

export interface SourceRow { path: string; agent: string; session_id: string; offset: number; msg_count: number }

export function readSource(path: string): SourceRow | undefined {
  return getSource.get(path) as SourceRow | undefined
}

export function getSessionPkByPath(path: string): string | null {
  const row = sessionPkByPath.get(path) as { agent: string; session_id: string } | undefined
  return row ? `${row.agent}:${row.session_id}` : null
}

const insertMetric = db.prepare(`INSERT INTO metrics (session_id, ts, cum_input, cum_output) VALUES (?, ?, ?, ?)`)
const metricsStmt = db.prepare(`SELECT ts, cum_input, cum_output FROM metrics WHERE session_id = ? ORDER BY ts`)

export function appendMetric(sessionPk: string, m: { ts: string; cumInput: number; cumOutput: number }) {
  insertMetric.run(sessionPk, m.ts, m.cumInput, m.cumOutput)
}

// codex TPS：相邻采样点差分，去掉超过 2 分钟的间隔（那是思考/等待，不是在生成）
// 分段 TPS 超过 400 的视为计数畸变（token_count 上报粒度问题），剔除
export function codexAvgTps(sessionPk: string): number | null {
  const rows = metricsStmt.all(sessionPk) as { ts: string; cum_output: number }[]
  let dOut = 0, dTime = 0
  for (let i = 1; i < rows.length; i++) {
    const dt = (new Date(rows[i].ts).getTime() - new Date(rows[i - 1].ts).getTime()) / 1000
    const do_ = rows[i].cum_output - rows[i - 1].cum_output
    if (dt > 0 && dt <= 120 && do_ > 0 && do_ / dt <= 400) { dOut += do_; dTime += dt }
  }
  return dTime > 0 ? Math.round((dOut / dTime) * 10) / 10 : null
}

export function countMessages(sessionPk: string): number {
  return (sessionMsgCount.get(sessionPk) as any).n
}

// 会话已有消息的内容哈希集合（role+blocks，不含 ts），用于 codex resume 前缀去重
export function getContentHashes(sessionPk: string): Set<string> {
  const set = new Set<string>()
  for (const r of sessionHashes.all(sessionPk) as { role: string; blocks_json: string }[]) {
    set.add(`${r.role}|${r.blocks_json}`)
  }
  return set
}

export function saveSessionMeta(agent: AgentType, meta: { sessionId: string; projectPath?: string; startedAt?: string; title?: string; model?: string; parentSessionId?: string; label?: string }, lastTs?: string) {
  upsertSession.run({
    id: `${agent}:${meta.sessionId}`,
    agent,
    parent_id: meta.parentSessionId ? `${agent}:${meta.parentSessionId}` : null,
    label: meta.label ?? null,
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

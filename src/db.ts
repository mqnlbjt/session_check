import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentType, Block, NormalizedMessage, Usage } from './model.js'
import { scanBlocks } from './rules.js'

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

// 轻量迁移：老库补 parent_id / label / avg_tps / 监控列
try { db.exec(`ALTER TABLE sessions ADD COLUMN parent_id TEXT`) } catch { /* 已存在 */ }
try { db.exec(`ALTER TABLE sessions ADD COLUMN label TEXT`) } catch { /* 已存在 */ }
try { db.exec(`ALTER TABLE sessions ADD COLUMN avg_tps REAL`) } catch { /* 已存在 */ }
try { db.exec(`ALTER TABLE sessions ADD COLUMN error_count INTEGER NOT NULL DEFAULT 0`) } catch { /* 已存在 */ }
try { db.exec(`ALTER TABLE sessions ADD COLUMN risk_count INTEGER NOT NULL DEFAULT 0`) } catch { /* 已存在 */ }
try { db.exec(`ALTER TABLE sessions ADD COLUMN cache_read INTEGER NOT NULL DEFAULT 0`) } catch { /* 已存在 */ }
try { db.exec(`ALTER TABLE sessions ADD COLUMN cache_creation INTEGER NOT NULL DEFAULT 0`) } catch { /* 已存在 */ }

db.exec(`
CREATE TABLE IF NOT EXISTS risks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  rule       TEXT NOT NULL,
  severity   TEXT NOT NULL,
  snippet    TEXT,
  ts         TEXT,
  UNIQUE(session_id, rule, snippet)
);
CREATE INDEX IF NOT EXISTS idx_risks_session ON risks(session_id);

CREATE TABLE IF NOT EXISTS reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  created_at    TEXT NOT NULL,
  source        TEXT NOT NULL,        -- spectator-engine | pi-plugin | claude-plugin | codex-plugin | manual
  model         TEXT,
  verdict       TEXT,                 -- good | mixed | problematic
  summary       TEXT,
  findings_json TEXT NOT NULL          -- [{type, detail, evidence?}]
);
CREATE INDEX IF NOT EXISTS idx_reviews_session ON reviews(session_id);
`)

// FTS5 全文搜索：只索引 text block + tool_call 入参（thinking / tool_result 不索引）
// trigram 分词：中文可子串匹配，代价是查询需 ≥3 字符（短查询走 LIKE 降级）
db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  session_id UNINDEXED,
  message_id UNINDEXED,
  tokenize='trigram'
)`)

// rowid 直接复用 messages.id：反连接查漏和 JOIN 都能走 rowid 索引，避免全表扫描
const insertFts = db.prepare(`INSERT INTO messages_fts (rowid, content, session_id, message_id) VALUES (?, ?, ?, ?)`)

// 从 blocks 提取可索引文本：人话 + 工具入参
export function searchableText(blocks: Block[]): string {
  const parts: string[] = []
  for (const b of blocks) {
    if (b.type === 'text' && b.text) parts.push(b.text)
    else if (b.type === 'tool_call') {
      const inp = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? '')
      parts.push(`${b.name ?? ''} ${inp}`)
    }
  }
  return parts.join('\n')
}

// 老数据回填 FTS；空文本消息插占位行（tombstone）保证幂等，返回本次实际索引条数
export function backfillFts(): number {
  const pending = db.prepare(`
    SELECT m.id, m.session_id, m.blocks_json AS bj FROM messages m
    LEFT JOIN messages_fts f ON f.rowid = m.id
    WHERE f.rowid IS NULL LIMIT 1000
  `)
  let indexed = 0
  const tx = db.transaction((rows: { id: number; session_id: string; bj: string }[]) => {
    for (const r of rows) {
      const text = searchableText(JSON.parse(r.bj))
      insertFts.run(r.id, text, r.session_id, r.id)
      if (text.trim()) indexed++
    }
  })
  while (true) {
    const rows = pending.all() as { id: number; session_id: string; bj: string }[]
    if (!rows.length) break
    tx(rows)
  }
  return indexed
}

export interface SearchOpts { agent?: string; project?: string; limit?: number; offset?: number }

// 全文搜索：≥3 字符走 FTS（整串作短语子串匹配），短查询降级 LIKE blocks_json
export function searchMessages(q: string, opts: SearchOpts = {}) {
  const { agent, project, limit = 30, offset = 0 } = opts
  const filters: string[] = []
  const params: Record<string, unknown> = { limit, offset }
  if (agent) { filters.push('s.agent = @agent'); params.agent = agent }
  if (project) { filters.push('s.project_path LIKE @project'); params.project = `%${project}%` }
  const extra = filters.length ? ' AND ' + filters.join(' AND ') : ''

  const isFtsAble = [...q.replace(/\s+/g, '')].length >= 3
  if (isFtsAble) {
    params.match = `"${q.replace(/"/g, '')}"`
    const where = `messages_fts MATCH @match${extra}`
    const total = (db.prepare(
      `SELECT COUNT(*) n FROM messages_fts f JOIN sessions s ON s.id = f.session_id WHERE ${where}`
    ).get(params) as any).n
    const rows = db.prepare(`
      SELECT m.id AS message_id, m.session_id, m.seq, m.role, m.ts,
             snippet(messages_fts, 0, '<mark>', '</mark>', '…', 24) AS snippet,
             s.title AS session_title, s.project_path, s.agent
      FROM messages_fts f
      JOIN messages m ON m.id = f.rowid
      JOIN sessions s ON s.id = f.session_id
      WHERE ${where}
      ORDER BY m.ts DESC LIMIT @limit OFFSET @offset
    `).all(params)
    return { total, rows }
  }
  // LIKE 降级：直接扫 blocks_json（短查询不频繁，可接受）
  params.like = `%${q}%`
  const where = `m.blocks_json LIKE @like${extra}`
  const total = (db.prepare(
    `SELECT COUNT(*) n FROM messages m JOIN sessions s ON s.id = m.session_id WHERE ${where}`
  ).get(params) as any).n
  const rows = db.prepare(`
    SELECT m.id AS message_id, m.session_id, m.seq, m.role, m.ts,
           substr(m.blocks_json, 1, 200) AS snippet,
           s.title AS session_title, s.project_path, s.agent
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE ${where}
    ORDER BY m.ts DESC LIMIT @limit OFFSET @offset
  `).all(params)
  return { total, rows }
}

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
  message_count   = message_count + 1,
  ended_at        = CASE WHEN @ts > COALESCE(ended_at, '') THEN @ts ELSE ended_at END,
  input_tokens    = input_tokens + @input,
  output_tokens   = output_tokens + @output,
  cache_read      = cache_read + @cache_read,
  cache_creation  = cache_creation + @cache_creation,
  error_count     = error_count + @errors,
  risk_count      = risk_count + @risks,
  avg_tps         = NULL   -- 新消息使 TPS 过期，标记待重算
WHERE id = @id
`)

const setSessionUsage = db.prepare(`
UPDATE sessions SET input_tokens = @input, output_tokens = @output, cache_read = @cache_read WHERE id = @id
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
const insertRisk = db.prepare(`INSERT OR IGNORE INTO risks (session_id, rule, severity, snippet, ts) VALUES (?, ?, ?, ?, ?)`)

export const insertReview = db.prepare(`
  INSERT INTO reviews (session_id, created_at, source, model, verdict, summary, findings_json)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)

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
  // 入库前实时过监控规则：工具错误计数 + 危险操作/密钥扫描
  const errors = msg.blocks.filter((b) => b.type === 'tool_result' && b.isError).length
  const riskHits = scanBlocks(msg.blocks)

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
    const text = searchableText(msg.blocks)
    if (text.trim()) {
      const mid = Number(info.lastInsertRowid)
      insertFts.run(mid, text, sessionPk, mid)
    }
    bumpSession.run({
      id: sessionPk,
      ts: msg.ts,
      input: msg.usage?.input ?? 0,
      output: msg.usage?.output ?? 0,
      cache_read: msg.usage?.cacheRead ?? 0,
      cache_creation: msg.usage?.cacheCreation ?? 0,
      errors,
      risks: riskHits.length,
    })
    for (const h of riskHits) {
      insertRisk.run(sessionPk, h.rule, h.severity, h.snippet, msg.ts)
    }
  }
  return info.changes > 0
}

// codex 的 token_count 是累计值，直接覆盖而不是累加
export function setCumulativeUsage(sessionPk: string, usage: Usage) {
  setSessionUsage.run({ id: sessionPk, input: usage.input ?? 0, output: usage.output ?? 0, cache_read: usage.cacheRead ?? 0 })
}

export function saveSource(row: SourceRow) {
  upsertSource.run(row)
}

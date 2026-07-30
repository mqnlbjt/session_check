import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { db, getSessionPkByPath, insertReview } from './db.js'
import { costOf } from './pricing.js'
import { scanAll, backfillAllTitles } from './ingest.js'
import { startWatch } from './watch.js'

const app = new Hono()
app.use('/api/*', cors())

// ---- sessions 列表：默认只列主会话；?parent=<id> 看某会话的 subagent；?all=1 全部 ----
app.get('/api/sessions', (c) => {
  const agent = c.req.query('agent')
  const q = c.req.query('q')
  const parent = c.req.query('parent')
  const all = c.req.query('all')
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
  const offset = Number(c.req.query('offset') ?? 0)

  const where: string[] = []
  const params: Record<string, unknown> = { limit, offset }
  if (agent) { where.push('agent = @agent'); params.agent = agent }
  if (q) { where.push('(title LIKE @q OR project_path LIKE @q)'); params.q = `%${q}%` }
  if (parent) { where.push('parent_id = @parent'); params.parent = parent }
  else if (!all) { where.push(`parent_id IS NULL AND (label IS NULL OR label NOT LIKE 'subagent%')`) }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total = (db.prepare(`SELECT COUNT(*) n FROM sessions ${whereSql}`).get(params) as any).n
  const rows = db.prepare(`
    SELECT id, agent, parent_id, label, project_path, title, model, started_at, ended_at,
           message_count, input_tokens, output_tokens, error_count, risk_count,
           (SELECT COUNT(*) FROM sessions s2 WHERE s2.parent_id = sessions.id) subagent_count
    FROM sessions ${whereSql}
    ORDER BY started_at DESC LIMIT @limit OFFSET @offset
  `).all(params) as any[]

  // 会话心电条：本页会话的消息时间分布，切成 32 个时间桶
  if (rows.length) {
    const ids = rows.map((r) => r.id)
    const tsRows = db.prepare(
      `SELECT session_id, ts FROM messages WHERE session_id IN (${ids.map(() => '?').join(',')})`
    ).all(...ids) as { session_id: string; ts: string }[]
    const byId = new Map<string, string[]>()
    for (const r of tsRows) {
      const arr = byId.get(r.session_id) ?? []
      arr.push(r.ts)
      byId.set(r.session_id, arr)
    }
    for (const row of rows) {
      const tss = byId.get(row.id)
      if (!tss?.length || !row.started_at) { row.spark = []; continue }
      const t0 = new Date(row.started_at).getTime()
      const t1 = Math.max(new Date(row.ended_at ?? row.started_at).getTime(), t0 + 1)
      const spark = new Array(32).fill(0)
      for (const ts of tss) {
        const bin = Math.min(31, Math.floor(((new Date(ts).getTime() - t0) / (t1 - t0)) * 32))
        if (bin >= 0) spark[bin]++
      }
      row.spark = spark
    }
  }
  return c.json({ total, rows })
})

// ---- 单个 session 的消息流 ----
app.get('/api/sessions/:id/messages', (c) => {
  const id = c.req.param('id')
  const limit = Math.min(Number(c.req.query('limit') ?? 500), 2000)
  const offset = Number(c.req.query('offset') ?? 0)

  const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id)
  if (!session) return c.json({ error: 'not found' }, 404)

  const rows = db.prepare(`
    SELECT seq, event_id, role, ts, blocks_json, model, usage_json
    FROM messages WHERE session_id = ?
    ORDER BY seq LIMIT ? OFFSET ?
  `).all(id, limit, offset) as any[]

  const messages = rows.map((r) => ({
    ...r,
    blocks: JSON.parse(r.blocks_json),
    usage: r.usage_json ? JSON.parse(r.usage_json) : null,
    blocks_json: undefined,
    usage_json: undefined,
  }))

  // TPS 估算：连续的 assistant 消息是同一次 API 响应的分块（thinking/text/tool_use 拆行），
  // 按组计算：组总 output ÷ (组末时间 - 组前事件时间)，tps 标在组末消息上。
  // 间隔含工具执行时间，是下界估值；钳制在 [0.5s, 10min] 防离谱值
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    let j = i, out = 0
    while (j < messages.length && messages[j].role === 'assistant') {
      out += messages[j].usage?.output ?? 0
      j++
    }
    if (out > 0) {
      const t0 = i > 0 ? new Date(messages[i - 1].ts).getTime() : new Date(m.ts).getTime() - 1000
      const t1 = new Date(messages[j - 1].ts).getTime()
      const dt = Math.min(600, Math.max(0.5, (t1 - t0) / 1000))
      messages[j - 1].tps = Math.round((out / dt) * 10) / 10
    }
    i = j - 1
  }

  // 会话级平均 TPS：读预计算值（-1 = 无数据）
  const stored = (session as any).avg_tps as number | null
  const avgTps = stored && stored > 0 ? stored : null

  const risks = db.prepare(`
    SELECT rule, severity, snippet, ts FROM risks WHERE session_id = ? ORDER BY ts LIMIT 50
  `).all(id)

  return c.json({ session: { ...(session as any), avg_tps: avgTps }, messages, risks })
})

// ---- 概览统计 ----
app.get('/api/stats', (c) => {
  const byAgent = db.prepare(`
    SELECT agent, COUNT(*) sessions, SUM(message_count) messages,
           SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens
    FROM sessions GROUP BY agent
  `).all()
  return c.json({ byAgent })
})

// ---- 复盘结果：agent 插件/外部引擎上传 ----
const VALID_VERDICTS = new Set(['good', 'mixed', 'problematic'])

app.post('/api/reviews', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }

  const { session_id, source, model, verdict, summary, findings } = body ?? {}
  if (!session_id || typeof session_id !== 'string') return c.json({ error: 'session_id required' }, 400)
  if (!Array.isArray(findings)) return c.json({ error: 'findings must be an array' }, 400)

  const exists = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(session_id)
  if (!exists) return c.json({ error: `unknown session: ${session_id}` }, 404)

  const info = insertReview.run(
    session_id,
    new Date().toISOString(),
    String(source ?? 'manual'),
    model ? String(model) : null,
    VALID_VERDICTS.has(verdict) ? verdict : 'mixed',
    summary ? String(summary) : null,
    JSON.stringify(findings),
  )
  return c.json({ id: info.lastInsertRowid })
})

app.get('/api/sessions/:id/reviews', (c) => {
  const id = c.req.param('id')
  const rows = db.prepare(`
    SELECT id, created_at, source, model, verdict, summary, findings_json
    FROM reviews WHERE session_id = ? ORDER BY created_at DESC LIMIT 20
  `).all(id) as any[]
  return c.json(rows.map((r) => ({ ...r, findings: JSON.parse(r.findings_json), findings_json: undefined })))
})

// ---- 监控大盘聚合 ----
app.get('/api/overview', (c) => {
  const mainOnly = `parent_id IS NULL AND (label IS NULL OR label NOT LIKE 'subagent%')`

  const today = db.prepare(`
    SELECT COUNT(*) sessions, COALESCE(SUM(message_count),0) messages,
           COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens
    FROM sessions
    WHERE ${mainOnly} AND date(started_at, 'localtime') = date('now', 'localtime')
  `).get()

  const daily = db.prepare(`
    SELECT date(started_at, 'localtime') d, COUNT(*) sessions,
           SUM(message_count) messages, SUM(output_tokens) output_tokens, SUM(input_tokens) input_tokens
    FROM sessions
    WHERE ${mainOnly} AND started_at >= datetime('now', '-30 days')
    GROUP BY d ORDER BY d
  `).all()

  const models = (db.prepare(`
    SELECT model, COUNT(*) sessions, SUM(output_tokens) output_tokens,
           SUM(input_tokens) input_tokens, SUM(cache_read) cache_read, SUM(cache_creation) cache_creation,
           ROUND(AVG(CASE WHEN avg_tps > 0 THEN avg_tps END), 1) avg_tps
    FROM sessions
    WHERE model IS NOT NULL
    GROUP BY model ORDER BY output_tokens DESC LIMIT 12
  `).all() as any[]).map((m) => ({
    ...m,
    cost: costOf(m.model, m.input_tokens ?? 0, m.output_tokens ?? 0, m.cache_read ?? 0, m.cache_creation ?? 0),
  }))

  // 日成本：按天+模型聚合后在 JS 里套价格表
  const dailyByModel = db.prepare(`
    SELECT date(started_at, 'localtime') d, model,
           SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
           SUM(cache_read) cache_read, SUM(cache_creation) cache_creation
    FROM sessions
    WHERE ${mainOnly} AND started_at >= datetime('now', '-30 days') AND model IS NOT NULL
    GROUP BY d, model
  `).all() as any[]
  const costByDay = new Map<string, number>()
  for (const r of dailyByModel) {
    const c = costOf(r.model, r.input_tokens ?? 0, r.output_tokens ?? 0, r.cache_read ?? 0, r.cache_creation ?? 0)
    if (c != null) costByDay.set(r.d, (costByDay.get(r.d) ?? 0) + c)
  }

  // 进行中：5 分钟内有新消息的主会话
  const active = db.prepare(`
    SELECT id, agent, title, model, message_count, ended_at
    FROM sessions
    WHERE ${mainOnly} AND ended_at >= datetime('now', '-5 minutes')
    ORDER BY ended_at DESC LIMIT 10
  `).all()

  // 错误率：按 agent 汇总 + 错误最多的会话
  const agentErrors = db.prepare(`
    SELECT agent, SUM(error_count) errors, COUNT(*) sessions FROM sessions
    WHERE ${mainOnly} GROUP BY agent
  `).all()
  const topErrorSessions = db.prepare(`
    SELECT id, agent, title, error_count, message_count FROM sessions
    WHERE ${mainOnly} AND error_count > 0
    ORDER BY error_count DESC LIMIT 8
  `).all()

  // 风险命中：按会话聚合规则
  const riskSessions = db.prepare(`
    SELECT r.session_id id, s.agent, s.title, COUNT(*) n,
           GROUP_CONCAT(DISTINCT r.rule) rules, MAX(r.severity = 'high') has_high
    FROM risks r JOIN sessions s ON s.id = r.session_id
    GROUP BY r.session_id ORDER BY has_high DESC, n DESC LIMIT 8
  `).all()
  const riskTotals = db.prepare(`
    SELECT COUNT(*) total, SUM(severity = 'high') high FROM risks
  `).get()

  const projects = db.prepare(`
    SELECT project_path, COUNT(*) sessions, SUM(message_count) messages, SUM(output_tokens) output_tokens
    FROM sessions
    WHERE ${mainOnly} AND project_path IS NOT NULL
    GROUP BY project_path ORDER BY messages DESC LIMIT 10
  `).all()

  const agents = db.prepare(`
    SELECT agent, COUNT(*) sessions, SUM(message_count) messages,
           SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
           ROUND(AVG(CASE WHEN avg_tps > 0 THEN avg_tps END), 1) avg_tps
    FROM sessions WHERE ${mainOnly} GROUP BY agent
  `).all()

  return c.json({
    today: { ...(today as any), cost: costByDay.get(new Date().toISOString().slice(0, 10)) ?? 0 },
    daily: (daily as any[]).map((r) => ({ ...r, cost: costByDay.get(r.d) ?? 0 })),
    models, projects, agents,
    active, agentErrors, topErrorSessions, riskSessions, riskTotals,
  })
})

// ---- SSE 实时事件：入库即推送，前端自动刷新 ----
interface SseClient { write: (data: string) => void }
const sseClients = new Set<SseClient>()

// 同一会话的入库事件在 1s 窗口内合并广播，避免工具调用刷屏
const pendingBroadcast = new Map<string, NodeJS.Timeout>()
export function broadcastIngest(sessionPk: string | null, added: number) {
  if (!sessionPk || sseClients.size === 0) return
  const prev = pendingBroadcast.get(sessionPk)
  if (prev) clearTimeout(prev)
  pendingBroadcast.set(sessionPk, setTimeout(() => {
    pendingBroadcast.delete(sessionPk)
    const data = JSON.stringify({ type: 'ingest', session: sessionPk, ts: Date.now() })
    for (const client of sseClients) client.write(data)
  }, 1000))
}

app.get('/api/events', (c) =>
  streamSSE(c, async (stream) => {
    const client: SseClient = { write: (data) => { stream.writeSSE({ data }).catch(() => {}) } }
    sseClients.add(client)
    const ping = setInterval(() => { stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => {}) }, 25000)
    stream.onAbort(() => {
      clearInterval(ping)
      sseClients.delete(client)
    })
    await new Promise(() => {}) // 永不 resolve，保持连接
  })
)

// ---- 手动触发全量扫描 ----
app.post('/api/scan', (c) => {
  const stats = scanAll()
  return c.json(stats)
})

// ---- 前端静态资源（web/dist 构建产物），SPA fallback 到 index.html ----
const DIST = resolve(import.meta.dirname, '../web/dist')
if (existsSync(DIST)) {
  app.use('/*', serveStatic({ root: DIST }))
  app.get('*', async (c) => {
    const html = await readFile(join(DIST, 'index.html'), 'utf8')
    return c.html(html)
  })
}

export function startServer(port = 8321) {
  let titleTimer: NodeJS.Timeout | null = null
  startWatch((path, added) => {
    console.log(`[ingest] +${added} 条 <- ${path}`)
    broadcastIngest(getSessionPkByPath(path), added)
    // 节流补标题：新 session 的消息入库后才能生成标题
    if (!titleTimer) {
      titleTimer = setTimeout(() => { titleTimer = null; backfillAllTitles() }, 2000)
    }
  })
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[spectator] API 就绪: http://localhost:${info.port}`)
  })
}

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { db, getSessionPkByPath } from './db.js'
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
           message_count, input_tokens, output_tokens,
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

  return c.json({ session: { ...(session as any), avg_tps: avgTps }, messages })
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

  const models = db.prepare(`
    SELECT model, COUNT(*) sessions, SUM(output_tokens) output_tokens,
           ROUND(AVG(CASE WHEN avg_tps > 0 THEN avg_tps END), 1) avg_tps
    FROM sessions
    WHERE model IS NOT NULL
    GROUP BY model ORDER BY output_tokens DESC LIMIT 12
  `).all()

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

  return c.json({ today, daily, models, projects, agents })
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

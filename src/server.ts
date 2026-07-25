import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import { db } from './db.js'
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
  else if (!all) { where.push('parent_id IS NULL') }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const total = (db.prepare(`SELECT COUNT(*) n FROM sessions ${whereSql}`).get(params) as any).n
  const rows = db.prepare(`
    SELECT id, agent, parent_id, project_path, title, model, started_at, ended_at,
           message_count, input_tokens, output_tokens,
           (SELECT COUNT(*) FROM sessions s2 WHERE s2.parent_id = sessions.id) subagent_count
    FROM sessions ${whereSql}
    ORDER BY started_at DESC LIMIT @limit OFFSET @offset
  `).all(params)
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

  return c.json({
    session,
    messages: rows.map((r) => ({
      ...r,
      blocks: JSON.parse(r.blocks_json),
      usage: r.usage_json ? JSON.parse(r.usage_json) : null,
      blocks_json: undefined,
      usage_json: undefined,
    })),
  })
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

// ---- 手动触发全量扫描 ----
app.post('/api/scan', (c) => {
  const stats = scanAll()
  return c.json(stats)
})

export function startServer(port = 8321) {
  let titleTimer: NodeJS.Timeout | null = null
  startWatch((path, added) => {
    console.log(`[ingest] +${added} 条 <- ${path}`)
    // 节流补标题：新 session 的消息入库后才能生成标题
    if (!titleTimer) {
      titleTimer = setTimeout(() => { titleTimer = null; backfillAllTitles() }, 2000)
    }
  })
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[spectator] API 就绪: http://localhost:${info.port}`)
  })
}

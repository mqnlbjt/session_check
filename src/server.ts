import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { db, getSessionPkByPath, insertReview, searchMessages } from './db.js'
import { costOf } from './pricing.js'
import { startReview, reviewStatus, type EngineResult } from './review.js'
import { renderMarkdown } from './export.js'
import { heatmap, modelCompare, projectCosts, projectDetail, lessonsAggregate } from './analytics.js'
import { generateGuardRules, listSuggestions, adoptSuggestion, dismissSuggestion } from './harness.js'
import { extractLessons, persistToInstructions, persistToSkill, type PersistMode } from './persist.js'

// 复盘沉淀结果（sessionPk → 写入的文件路径），供 review-status 查询
export const lastPersist = new Map<string, string>()
import { scanAll, backfillAllTitles } from './ingest.js'
import { startWatch } from './watch.js'

export const app = new Hono()
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
           (SELECT COUNT(*) FROM sessions s2 WHERE s2.parent_id = sessions.id) subagent_count,
           (SELECT COUNT(*) FROM signals sig WHERE sig.session_id = sessions.id AND sig.kind = 'correction') correction_count
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

// ---- 全文搜索：?q= 必填，&agent= &project= 过滤 ----
// limit/offset 做下限和整数校验：-1 在 SQLite 里是「无限制」，NaN/小数会直接 500
function clampPage(raw: string | undefined, def: number, max: number): number {
  const n = Number(raw ?? def)
  if (!Number.isInteger(n) || n < 1) return def
  return Math.min(n, max)
}
app.get('/api/search', (c) => {
  const q = (c.req.query('q') ?? '').trim()
  if (!q) return c.json({ total: 0, rows: [] })
  const limit = clampPage(c.req.query('limit'), 30, 100)
  const offset = Math.max(0, Math.trunc(Number(c.req.query('offset') ?? 0)) || 0)
  return c.json(searchMessages(q, {
    agent: c.req.query('agent'),
    project: c.req.query('project'),
    limit, offset,
  }))
})

// ---- 分析聚合：热力图 / 模型对比 / 项目成本榜 / 项目下钻 ----
app.get('/api/analytics/heatmap', (c) => c.json(heatmap()))
app.get('/api/analytics/models', (c) => c.json(modelCompare()))
app.get('/api/analytics/projects', (c) => c.json(projectCosts()))
app.get('/api/lessons', (c) => c.json(lessonsAggregate()))

// ---- Harness 建议（期5）----
// 生成是异步的（LLM 调用 1-3 分钟）：POST 立即返回，前端轮询 GET 等新建议
const generating = new Set<string>()

app.get('/api/harness/suggestions', (c) => c.json(listSuggestions()))

app.post('/api/harness/generate', async (c) => {
  const { project_path } = await c.req.json().catch(() => ({ project_path: null }))
  if (!project_path) return c.json({ error: 'project_path 必填' }, 400)
  if (generating.has(project_path)) return c.json({ error: '该项目正在生成中' }, 409)
  generating.add(project_path)
  generateGuardRules(project_path)
    .catch((e) => console.error('[harness] 生成失败:', e))
    .finally(() => generating.delete(project_path))
  return c.json({ status: 'started', project_path })
})

app.post('/api/harness/suggestions/:id/adopt', (c) => {
  try {
    const r = adoptSuggestion(Number(c.req.param('id')))
    if (!r) return c.json({ error: '建议不存在或已处理' }, 404)
    return c.json(r)
  } catch (e: any) {
    return c.json({ error: `写入失败：${e?.message ?? '未知错误'}` }, 500)
  }
})

app.post('/api/harness/suggestions/:id/dismiss', (c) => {
  if (!dismissSuggestion(Number(c.req.param('id')))) return c.json({ error: '建议不存在或已处理' }, 404)
  return c.json({ ok: true })
})
app.get('/api/analytics/project', async (c) => {
  const path = c.req.query('path')
  if (!path) return c.json({ error: 'path 必填' }, 400)
  const detail = await projectDetail(path)
  if (!detail) return c.json({ error: '未知项目路径' }, 404)
  return c.json(detail)
})

// ---- 会话导出 Markdown ----
app.get('/api/sessions/:id/export.md', (c) => {
  const id = c.req.param('id')
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any
  if (!session) return c.json({ error: '会话不存在' }, 404)
  const messages = db.prepare('SELECT seq, role, ts, blocks_json FROM messages WHERE session_id = ? ORDER BY seq').all(id)
  const md = renderMarkdown(session, messages)
  const fname = encodeURIComponent(`${(session.title ?? id).replace(/[\n"/\\]/g, ' ').slice(0, 40)}.md`)
  return new Response(md, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${fname}`,
    },
  })
})

// ---- 会话的返工信号明细（前端定位用）----
app.get('/api/sessions/:id/signals', (c) => {
  const rows = db.prepare(`
    SELECT sig.rule, sig.kind, sig.snippet, sig.ts, m.seq
    FROM signals sig JOIN messages m ON m.id = sig.message_id
    WHERE sig.session_id = ? ORDER BY sig.ts, sig.id
  `).all(c.req.param('id'))
  return c.json(rows)
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

// ---- 触发复盘：用会话自己的 agent（headless CLI）评审 ----
app.post('/api/sessions/:id/review', async (c) => {
  const id = c.req.param('id')
  const session = db.prepare(`SELECT agent, project_path, title FROM sessions WHERE id = ?`).get(id) as { agent: string; project_path: string | null; title: string | null } | undefined
  if (!session) return c.json({ error: 'not found' }, 404)
  const agent = session.agent as 'pi' | 'claude' | 'codex'

  let persist: PersistMode = 'none'
  try {
    const body = await c.req.json().catch(() => ({}))
    if (['none', 'instructions', 'skill'].includes(body?.persist)) persist = body.persist
  } catch { /* 无 body 也行 */ }

  const started = startReview(id, agent, (r) => {
    insertReview.run(
      r.sessionPk,
      new Date().toISOString(),
      r.source,
      null,
      ['good', 'mixed', 'problematic'].includes(r.verdict) ? r.verdict : 'mixed',
      r.summary,
      JSON.stringify(r.findings),
    )
    console.log(`[review] ${id} 完成 (${r.source})`)

    // 沉淀：把教训写回 agent 的记忆文件
    if (persist !== 'none' && session.project_path) {
      const lessons = extractLessons(r.findings)
      if (lessons.length === 0) {
        lastPersist.set(id, '') // 空串 = 没有可沉淀的教训
      } else {
        try {
          const title = session.title ?? id
          const filePath = persist === 'skill'
            ? persistToSkill(agent, session.project_path, title, lessons)
            : persistToInstructions(session.project_path, agent, title, lessons)
          lastPersist.set(id, filePath)
          console.log(`[review] 已沉淀到 ${filePath}`)
        } catch (e) {
          console.error('[review] 沉淀失败:', e)
        }
      }
    }
  })
  if (!started) return c.json({ error: '该会话正在复盘中' }, 409)
  return c.json({ status: 'started', agent, persist })
})

app.get('/api/sessions/:id/review-status', (c) => {
  const id = c.req.param('id')
  return c.json({ ...reviewStatus(id), persisted: lastPersist.get(id) ?? null })
})

// ---- 监控大盘聚合 ----
app.get('/api/overview', (c) => {
  const mainOnly = `parent_id IS NULL AND (label IS NULL OR label NOT LIKE 'subagent%')`

  // 活动口径：按消息时间统计，长跑会话跨天也可见
  const activityToday = db.prepare(`
    SELECT COUNT(DISTINCT m.session_id) sessions, COUNT(*) messages
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE s.${mainOnly} AND date(m.ts, 'localtime') = date('now', 'localtime')
  `).get() as any

  // 每日/今日 token 与成本：按消息 usage 逐条算（模型取消息级，缺失回落会话级）
  const usageRows = db.prepare(`
    SELECT date(m.ts, 'localtime') d, COALESCE(m.model, s.model) model, m.usage_json
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE m.usage_json IS NOT NULL AND m.ts >= datetime('now', '-30 days')
  `).all() as { d: string; model: string | null; usage_json: string }[]

  const todayStr = new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD 本地
  let todayIn = 0, todayOut = 0, todayCost = 0
  const usageByDay = new Map<string, { input: number; output: number; cost: number }>()
  for (const r of usageRows) {
    const u = JSON.parse(r.usage_json)
    const input = u.input ?? 0, output = u.output ?? 0
    const cost = costOf(r.model, input, output, u.cacheRead ?? 0, u.cacheCreation ?? 0) ?? 0
    const agg = usageByDay.get(r.d) ?? { input: 0, output: 0, cost: 0 }
    agg.input += input; agg.output += output; agg.cost += cost
    usageByDay.set(r.d, agg)
    if (r.d === todayStr) { todayIn += input; todayOut += output; todayCost += cost }
  }

  // codex 的 token 不在消息上，全在 metrics 累计采样里：按会话差分，归属后一个采样点那天
  // 多取 10 天保证窗口边界处有前一个采样点
  const metricRows = db.prepare(`
    SELECT m.session_id, date(m.ts, 'localtime') d, m.ts, m.cum_input, m.cum_output,
           s.model, s.input_tokens s_in, s.cache_read s_cache
    FROM metrics m JOIN sessions s ON s.id = m.session_id
    WHERE m.ts >= datetime('now', '-40 days')
    ORDER BY m.session_id, m.ts
  `).all() as { session_id: string; d: string; ts: string; cum_input: number; cum_output: number; model: string | null; s_in: number; s_cache: number }[]
  let prevMetric: (typeof metricRows)[number] | null = null
  for (const r of metricRows) {
    if (prevMetric && prevMetric.session_id === r.session_id) {
      const dIn = r.cum_input - prevMetric.cum_input
      const dOut = r.cum_output - prevMetric.cum_output
      if (dIn >= 0 && dOut >= 0 && (dIn + dOut) > 0) {
        // 按会话级 cache 比例估算这段增量的 cached 部分，参与折价
        const ratio = r.s_in > 0 ? Math.min(1, r.s_cache / r.s_in) : 0
        const cost = costOf(r.model, dIn, dOut, Math.round(dIn * ratio)) ?? 0
        const agg = usageByDay.get(r.d) ?? { input: 0, output: 0, cost: 0 }
        agg.input += dIn; agg.output += dOut; agg.cost += cost
        usageByDay.set(r.d, agg)
        if (r.d === todayStr) { todayIn += dIn; todayOut += dOut; todayCost += cost }
      }
    }
    prevMetric = r
  }

  const today = {
    sessions: activityToday.sessions,
    messages: activityToday.messages,
    input_tokens: todayIn,
    output_tokens: todayOut,
    cost: todayCost,
  }

  // 每日活动：活跃会话数 + 消息数，token/成本由 usageByDay 补
  const daily = (db.prepare(`
    SELECT date(m.ts, 'localtime') d, COUNT(DISTINCT m.session_id) sessions, COUNT(*) messages
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE s.${mainOnly} AND m.ts >= datetime('now', '-30 days')
    GROUP BY d ORDER BY d
  `).all() as { d: string; sessions: number; messages: number }[]).map((r) => ({
    ...r,
    output_tokens: usageByDay.get(r.d)?.output ?? 0,
    input_tokens: usageByDay.get(r.d)?.input ?? 0,
    cost: usageByDay.get(r.d)?.cost ?? 0,
  }))

  // 模型排行：近 30 天活动口径（全量排行里老模型霸榜，新模型永远上不了榜）
  const models = (db.prepare(`
    SELECT model, COUNT(*) sessions, SUM(output_tokens) output_tokens,
           SUM(input_tokens) input_tokens, SUM(cache_read) cache_read, SUM(cache_creation) cache_creation,
           ROUND(AVG(CASE WHEN avg_tps > 0 THEN avg_tps END), 1) avg_tps
    FROM sessions
    WHERE model IS NOT NULL AND started_at >= datetime('now', '-30 days')
    GROUP BY model ORDER BY output_tokens DESC LIMIT 12
  `).all() as any[]).map((m) => ({
    ...m,
    cost: costOf(m.model, m.input_tokens ?? 0, m.output_tokens ?? 0, m.cache_read ?? 0, m.cache_creation ?? 0),
  }))

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

  // 返工率周趋势：每周活跃主会话中，有 ≥1 次纠正信号的会话占比（近 12 周）
  // 分子分母同口径：都限主会话 + 同一时间窗（评审 Critical 修复）
  const weeklyActive = db.prepare(`
    SELECT strftime('%Y-W%W', m.ts, 'localtime') w, COUNT(DISTINCT m.session_id) n
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE s.${mainOnly} AND m.ts >= datetime('now', '-84 days') GROUP BY w ORDER BY w
  `).all() as { w: string; n: number }[]
  const weeklyCorrected = new Map(
    (db.prepare(`
      SELECT strftime('%Y-W%W', sig.ts, 'localtime') w, COUNT(DISTINCT sig.session_id) n
      FROM signals sig JOIN sessions s ON s.id = sig.session_id
      WHERE sig.kind = 'correction' AND s.${mainOnly} AND sig.ts >= datetime('now', '-84 days')
      GROUP BY w
    `).all() as { w: string; n: number }[]).map((r) => [r.w, r.n])
  )
  const reworkWeekly = weeklyActive.map((r) => ({
    w: r.w,
    sessions: r.n,
    corrected: weeklyCorrected.get(r.w) ?? 0,
    rate: r.n > 0 ? Math.round(((weeklyCorrected.get(r.w) ?? 0) / r.n) * 1000) / 10 : 0,
  }))

  return c.json({
    today,
    daily,
    models, projects, agents,
    active, agentErrors, topErrorSessions, riskSessions, riskTotals,
    reworkWeekly,
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

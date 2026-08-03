// 分析聚合：热力图 / 模型对比 / 项目成本榜 / 项目下钻（成本 vs commit）
// 全部主会话口径（subagent 不进统计），近 90 天
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { db } from './db.js'
import { costOf } from './pricing.js'

const execFileAsync = promisify(execFile)

const MAIN_ONLY = `parent_id IS NULL AND (label IS NULL OR label NOT LIKE 'subagent%')`
const WINDOW = `datetime('now', '-90 days')`

// ---- 热力图：7（星期）×24（小时）消息数 + output token ----
export function heatmap() {
  const rows = db.prepare(`
    SELECT CAST(strftime('%w', m.ts, 'localtime') AS INTEGER) dow,
           CAST(strftime('%H', m.ts, 'localtime') AS INTEGER) hour,
           m.usage_json
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE s.${MAIN_ONLY} AND m.ts >= ${WINDOW}
  `).all() as { dow: number; hour: number; usage_json: string | null }[]

  const grid = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ messages: 0, output_tokens: 0 })))
  for (const r of rows) {
    const cell = grid[r.dow][r.hour]
    cell.messages++
    if (r.usage_json) {
      try { cell.output_tokens += JSON.parse(r.usage_json).output ?? 0 } catch { /* 坏行跳过 */ }
    }
  }
  return { grid }
}

// ---- 模型对比：会话数/成本/TPS/平均每会话纠正数 ----
// 按裸模型名归并：pi 报 "deepseek/deepseek-v4-pro"、claude/codex 报 "deepseek-v4-pro"，是同一模型
// （用户决策：local/ 前缀也并入官方模型，接受本地代理价格可能虚高）
const bareModel = (m: string) => (m.includes('/') ? m.split('/').pop()! : m)

export function modelCompare() {
  const rows = db.prepare(`
    SELECT model, COUNT(*) sessions,
           SUM(input_tokens) input, SUM(output_tokens) output,
           SUM(cache_read) cr, SUM(cache_creation) cc,
           AVG(CASE WHEN avg_tps > 0 THEN avg_tps END) tps  -- -1 是无数据哨兵，不参与平均（对齐大盘口径）
    FROM sessions
    WHERE ${MAIN_ONLY} AND model IS NOT NULL AND started_at >= ${WINDOW}
    GROUP BY model
  `).all() as { model: string; sessions: number; input: number; output: number; cr: number; cc: number; tps: number | null }[]

  const corrByModel = new Map(
    (db.prepare(`
      SELECT s.model, COUNT(*) n FROM signals sig
      JOIN sessions s ON s.id = sig.session_id
      WHERE sig.kind = 'correction' AND s.${MAIN_ONLY} AND sig.ts >= ${WINDOW}
      GROUP BY s.model
    `).all() as { model: string; n: number }[]).map((r) => [r.model, r.n])
  )

  // 按裸名归并：token/成本/纠正直接加，TPS 按会话数加权
  const merged = new Map<string, {
    model: string; sessions: number; input: number; output: number
    cost: number; tpsSum: number; tpsN: number; corrections: number
  }>()
  for (const r of rows) {
    const key = bareModel(r.model)
    const m = merged.get(key) ?? { model: key, sessions: 0, input: 0, output: 0, cost: 0, tpsSum: 0, tpsN: 0, corrections: 0 }
    m.sessions += r.sessions
    m.input += r.input
    m.output += r.output
    m.cost += costOf(r.model, r.input, r.output, r.cr, r.cc) ?? 0 // costOf 内部也去前缀，价格一致
    if (r.tps) { m.tpsSum += r.tps * r.sessions; m.tpsN += r.sessions }
    m.corrections += corrByModel.get(r.model) ?? 0
    merged.set(key, m)
  }

  return [...merged.values()].map((m) => ({
    model: m.model,
    sessions: m.sessions,
    input_tokens: m.input,
    output_tokens: m.output,
    cost: m.cost,
    avg_tps: m.tpsN > 0 ? Math.round((m.tpsSum / m.tpsN) * 10) / 10 : null,
    avg_corrections: Math.round((m.corrections / m.sessions) * 10) / 10,
  })).sort((a, b) => b.cost - a.cost)
}

// ---- 项目成本榜：同项目可能用多模型，按 (项目,模型) 分桶算成本再汇总 ----
export function projectCosts(limit = 20) {
  const rows = db.prepare(`
    SELECT project_path, model, COUNT(*) sessions, SUM(message_count) messages,
           SUM(input_tokens) input, SUM(output_tokens) output,
           SUM(cache_read) cr, SUM(cache_creation) cc
    FROM sessions
    WHERE ${MAIN_ONLY} AND project_path IS NOT NULL AND started_at >= ${WINDOW}
    GROUP BY project_path, model
  `).all() as { project_path: string; model: string | null; sessions: number; messages: number; input: number; output: number; cr: number; cc: number }[]

  const byProject = new Map<string, { project_path: string; sessions: number; messages: number; input_tokens: number; output_tokens: number; cost: number }>()
  for (const r of rows) {
    const p = byProject.get(r.project_path) ?? { project_path: r.project_path, sessions: 0, messages: 0, input_tokens: 0, output_tokens: 0, cost: 0 }
    p.sessions += r.sessions
    p.messages += r.messages
    p.input_tokens += r.input
    p.output_tokens += r.output
    p.cost += costOf(r.model, r.input, r.output, r.cr, r.cc) ?? 0
    byProject.set(r.project_path, p)
  }
  return [...byProject.values()].sort((a, b) => b.cost - a.cost).slice(0, limit)
}

// ---- 教训聚合：信号规则频次 + 按项目分布 + 复盘 findings ----
export function lessonsAggregate() {
  const signalRules = db.prepare(`
    SELECT rule, kind, COUNT(*) n FROM signals GROUP BY rule, kind ORDER BY n DESC
  `).all()

  const byProject = db.prepare(`
    SELECT s.project_path,
           SUM(CASE WHEN sig.kind = 'correction' THEN 1 ELSE 0 END) corrections,
           SUM(CASE WHEN sig.kind = 'frustration' THEN 1 ELSE 0 END) frustrations
    FROM signals sig JOIN sessions s ON s.id = sig.session_id
    GROUP BY s.project_path ORDER BY corrections DESC
  `).all()

  // findings 在 reviews.findings_json 里（JSON 数组），JS 侧聚合
  const reviews = db.prepare(`
    SELECT r.session_id, r.findings_json, r.created_at, s.project_path, s.title
    FROM reviews r LEFT JOIN sessions s ON s.id = r.session_id
  `).all() as { session_id: string; findings_json: string; created_at: string; project_path: string | null; title: string | null }[]

  const typeCount = new Map<string, number>()
  const lessons: { type: string; detail: string; evidence?: string; session_id: string; project_path: string | null; session_title: string | null; created_at: string }[] = []
  for (const r of reviews) {
    let findings: { type: string; detail: string; evidence?: string }[]
    try { findings = JSON.parse(r.findings_json) } catch { continue }
    for (const f of findings) {
      typeCount.set(f.type, (typeCount.get(f.type) ?? 0) + 1)
      if (f.type === 'lesson' || f.type === 'good_practice') {
        lessons.push({ type: f.type, detail: f.detail, evidence: f.evidence, session_id: r.session_id, project_path: r.project_path, session_title: r.title, created_at: r.created_at })
      }
    }
  }
  lessons.sort((a, b) => b.created_at.localeCompare(a.created_at))

  return {
    signalRules,
    byProject,
    findingTypes: [...typeCount.entries()].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n),
    lessons: lessons.slice(0, 50),
  }
}

// ---- 项目下钻：成本曲线 + git commit 曲线（并排展示，不做归属）----
export async function projectDetail(path: string) {
  // 白名单：必须是观测过的项目路径
  const known = db.prepare(`SELECT 1 FROM sessions WHERE project_path = ? LIMIT 1`).get(path)
  if (!known) return null

  // 成本曲线：消息级 usage 按天聚合（codex 的 metrics 差分口径在大盘已有，这里从简）
  const usageRows = db.prepare(`
    SELECT date(m.ts, 'localtime') d, COALESCE(m.model, s.model) model, m.usage_json
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE s.project_path = ? AND s.${MAIN_ONLY} AND m.usage_json IS NOT NULL AND m.ts >= ${WINDOW}
  `).all(path) as { d: string; model: string | null; usage_json: string }[]
  const byDay = new Map<string, { cost: number; output_tokens: number }>()
  for (const r of usageRows) {
    try {
      const u = JSON.parse(r.usage_json)
      const agg = byDay.get(r.d) ?? { cost: 0, output_tokens: 0 }
      agg.cost += costOf(r.model, u.input ?? 0, u.output ?? 0, u.cacheRead ?? 0, u.cacheCreation ?? 0) ?? 0
      agg.output_tokens += u.output ?? 0
      byDay.set(r.d, agg)
    } catch { /* 坏行跳过 */ }
  }

  // codex 的 token 在 metrics 累计采样：按会话差分归属到后一个采样点那天（与大盘同口径）
  const metricRows = db.prepare(`
    SELECT m.session_id, date(m.ts, 'localtime') d, m.ts, m.cum_input, m.cum_output,
           s.model, s.input_tokens s_in, s.cache_read s_cache
    FROM metrics m JOIN sessions s ON s.id = m.session_id
    WHERE s.project_path = ? AND s.${MAIN_ONLY} AND m.ts >= datetime('now', '-100 days')
    ORDER BY m.session_id, m.ts
  `).all(path) as { session_id: string; d: string; ts: string; cum_input: number; cum_output: number; model: string | null; s_in: number; s_cache: number }[]
  let prevMetric: (typeof metricRows)[number] | null = null
  for (const r of metricRows) {
    if (prevMetric && prevMetric.session_id === r.session_id) {
      const dIn = r.cum_input - prevMetric.cum_input
      const dOut = r.cum_output - prevMetric.cum_output
      // 只统计 90 天窗口内的增量（多取 10 天是为拿到窗口前的基准采样点）
      if (dIn >= 0 && dOut >= 0 && (dIn + dOut) > 0 && r.ts >= new Date(Date.now() - 90 * 86400000).toISOString()) {
        const ratio = r.s_in > 0 ? Math.min(1, r.s_cache / r.s_in) : 0
        const agg = byDay.get(r.d) ?? { cost: 0, output_tokens: 0 }
        agg.cost += costOf(r.model, dIn, dOut, Math.round(dIn * ratio)) ?? 0
        agg.output_tokens += dOut
        byDay.set(r.d, agg)
      }
    }
    prevMetric = r
  }
  const daily = [...byDay.entries()].map(([d, v]) => ({ d, cost: Math.round(v.cost * 100) / 100, output_tokens: v.output_tokens })).sort((a, b) => a.d.localeCompare(b.d))

  // commit 曲线：失败/非 git 仓库降级为空（前端只显示成本）；异步不阻塞事件循环
  let commits: { d: string; n: number }[] = []
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', path, 'log', '--since=90 days ago', '--date=format:%Y-%m-%d', '--format=%ad',
    ], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
    const byDayCommits = new Map<string, number>()
    for (const line of stdout.split('\n')) {
      const d = line.trim()
      if (d) byDayCommits.set(d, (byDayCommits.get(d) ?? 0) + 1)
    }
    commits = [...byDayCommits.entries()].map(([d, n]) => ({ d, n })).sort((a, b) => a.d.localeCompare(b.d))
  } catch { /* 非 git 目录 / 超时 / git 不存在：降级 */ }

  return { daily, commits }
}

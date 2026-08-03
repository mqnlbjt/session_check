// 分析聚合：热力图 / 模型对比 / 项目成本榜 / 项目下钻（成本 vs commit）
// 全部主会话口径（subagent 不进统计），近 90 天
import { execFileSync } from 'node:child_process'
import { db } from './db.js'
import { costOf } from './pricing.js'

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
export function modelCompare() {
  const rows = db.prepare(`
    SELECT model, COUNT(*) sessions,
           SUM(input_tokens) input, SUM(output_tokens) output,
           SUM(cache_read) cr, SUM(cache_creation) cc,
           AVG(avg_tps) tps
    FROM sessions
    WHERE ${MAIN_ONLY} AND model IS NOT NULL
    GROUP BY model
  `).all() as { model: string; sessions: number; input: number; output: number; cr: number; cc: number; tps: number | null }[]

  const corrByModel = new Map(
    (db.prepare(`
      SELECT s.model, COUNT(*) n FROM signals sig
      JOIN sessions s ON s.id = sig.session_id
      WHERE sig.kind = 'correction' AND s.${MAIN_ONLY}
      GROUP BY s.model
    `).all() as { model: string; n: number }[]).map((r) => [r.model, r.n])
  )

  return rows.map((r) => ({
    model: r.model,
    sessions: r.sessions,
    input_tokens: r.input,
    output_tokens: r.output,
    cost: costOf(r.model, r.input, r.output, r.cr, r.cc),
    avg_tps: r.tps ? Math.round(r.tps * 10) / 10 : null,
    avg_corrections: Math.round(((corrByModel.get(r.model) ?? 0) / r.sessions) * 10) / 10,
  })).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
}

// ---- 项目成本榜：同项目可能用多模型，按 (项目,模型) 分桶算成本再汇总 ----
export function projectCosts(limit = 20) {
  const rows = db.prepare(`
    SELECT project_path, model, COUNT(*) sessions, SUM(message_count) messages,
           SUM(input_tokens) input, SUM(output_tokens) output,
           SUM(cache_read) cr, SUM(cache_creation) cc
    FROM sessions
    WHERE ${MAIN_ONLY} AND project_path IS NOT NULL
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

// ---- 项目下钻：成本曲线 + git commit 曲线（并排展示，不做归属）----
export function projectDetail(path: string) {
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
    const u = JSON.parse(r.usage_json)
    const agg = byDay.get(r.d) ?? { cost: 0, output_tokens: 0 }
    agg.cost += costOf(r.model, u.input ?? 0, u.output ?? 0, u.cacheRead ?? 0, u.cacheCreation ?? 0) ?? 0
    agg.output_tokens += u.output ?? 0
    byDay.set(r.d, agg)
  }
  const daily = [...byDay.entries()].map(([d, v]) => ({ d, cost: Math.round(v.cost * 100) / 100, output_tokens: v.output_tokens })).sort((a, b) => a.d.localeCompare(b.d))

  // commit 曲线：失败/非 git 仓库降级为空（前端只显示成本）
  let commits: { d: string; n: number }[] = []
  try {
    const out = execFileSync('git', [
      '-C', path, 'log', '--since=90 days ago', '--date=format:%Y-%m-%d', '--format=%ad',
    ], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })
    const byDayCommits = new Map<string, number>()
    for (const line of out.split('\n')) {
      const d = line.trim()
      if (d) byDayCommits.set(d, (byDayCommits.get(d) ?? 0) + 1)
    }
    commits = [...byDayCommits.entries()].map(([d, n]) => ({ d, n })).sort((a, b) => a.d.localeCompare(b.d))
  } catch { /* 非 git 目录 / 超时 / git 不存在：降级 */ }

  return { daily, commits }
}

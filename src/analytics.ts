// 分析聚合：热力图 / 模型对比 / 项目成本榜 / 项目下钻（成本 vs commit）
// 全部主会话口径（subagent 不进统计），近 90 天
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { db } from './db.js'
import { costOf, findPrice } from './pricing.js'

const execFileAsync = promisify(execFile)

const MAIN_ONLY = `parent_id IS NULL AND (label IS NULL OR label NOT LIKE 'subagent%')`
// ISO cutoff（内联带引号）：库里 ts 是 ISO 格式，datetime('now') 是空格格式，直接比较会让截止日当天全部通过（审计 P0-1）
const WINDOW = `'${new Date(Date.now() - 90 * 86400e3).toISOString()}'`
// windowDays 动态窗：同样生成 ISO 字面量（JS 生成的固定格式，无注入面）
const isoWindow = (days: number) => `'${new Date(Date.now() - Math.trunc(days) * 86400e3).toISOString()}'`

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

// windowDays：模型更新快，建议类场景用 30 天；大盘分析默认 90 天
export async function modelCompare(windowDays = 90) {
  const window = isoWindow(windowDays)
  const rows = db.prepare(`
    SELECT model, COUNT(*) sessions,
           SUM(input_tokens) input, SUM(output_tokens) output,
           SUM(cache_read) cr, SUM(cache_creation) cc,
           AVG(CASE WHEN avg_tps > 0 THEN avg_tps END) tps  -- -1 是无数据哨兵，不参与平均（对齐大盘口径）
    FROM sessions
    WHERE ${MAIN_ONLY} AND model IS NOT NULL AND started_at >= ${window}
    GROUP BY model
  `).all() as { model: string; sessions: number; input: number; output: number; cr: number; cc: number; tps: number | null }[]

  const corrByModel = new Map(
    (db.prepare(`
      SELECT s.model, COUNT(*) n FROM signals sig
      JOIN sessions s ON s.id = sig.session_id
      WHERE sig.kind = 'correction' AND s.${MAIN_ONLY} AND sig.ts >= ${window}
      GROUP BY s.model
    `).all() as { model: string; n: number }[]).map((r) => [r.model, r.n])
  )

  // 按裸名归并：token/成本/纠正/缓存直接加，TPS 按会话数加权
  const merged = new Map<string, {
    model: string; sessions: number; input: number; output: number
    cost: number; tpsSum: number; tpsN: number; corrections: number
    cr: number; cc: number; saved: number
  }>()
  for (const r of rows) {
    const key = bareModel(r.model)
    const m = merged.get(key) ?? { model: key, sessions: 0, input: 0, output: 0, cost: 0, tpsSum: 0, tpsN: 0, corrections: 0, cr: 0, cc: 0, saved: 0 }
    m.sessions += r.sessions
    m.input += r.input
    m.output += r.output
    m.cost += costOf(r.model, r.input, r.output, r.cr, r.cc) ?? 0 // costOf 内部也去前缀，价格一致
    if (r.tps) { m.tpsSum += r.tps * r.sessions; m.tpsN += r.sessions }
    m.corrections += corrByModel.get(r.model) ?? 0
    m.cr += r.cr
    m.cc += r.cc
    // 缓存节省：cache_read 按 0.1x 计费，相对全价省了 0.9x
    m.saved += (findPrice(r.model)?.in ?? 0) * r.cr * 0.9 / 1e6
    merged.set(key, m)
  }

  // ---- 请求级维度（消息口径：每条 assistant 消息 ≈ 一次 API 调用）----
  // 失败率：api_error 标记（pi stopReason=error / claude isApiErrorMessage）
  const failRows = db.prepare(`
    SELECT COALESCE(m.model, s.model) model, COUNT(*) total, SUM(m.api_error) fails
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE m.role = 'assistant' AND s.${MAIN_ONLY} AND m.ts >= ${window}
      AND COALESCE(m.model, s.model) IS NOT NULL
    GROUP BY 1
  `).all() as { model: string; total: number; fails: number }[]
  const failByModel = new Map(failRows.map((r) => [bareModel(r.model), r]))

  // reasoning tokens：pi usage 里单独上报
  const reasonRows = db.prepare(`
    SELECT COALESCE(m.model, s.model) model, SUM(json_extract(m.usage_json, '$.reasoning')) reasoning
    FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE m.role = 'assistant' AND s.${MAIN_ONLY} AND m.ts >= ${window} AND m.usage_json IS NOT NULL
    GROUP BY 1
  `).all() as { model: string; reasoning: number | null }[]
  const reasonByModel = new Map(reasonRows.map((r) => [bareModel(r.model), r.reasoning ?? 0]))

  // 响应延迟估算：assistant 消息与前一条消息的时间差（只算紧跟 user/tool 的，排除用户思考间隔；
  // 0.5s<gap<300s 过滤异常值），带 usage 的消息才是真实 API 调用
  // 响应延迟估算：LAG 必须先在全量消息上算，再过滤 assistant 行
  // （WHERE 先于窗口函数执行，先过滤会让 LAG 只看见 assistant，prev_role 永远拿不到 user/tool）
  const latencyRows = db.prepare(`
    WITH all_msgs AS (
      SELECT m.role, COALESCE(m.model, s.model) model, m.usage_json, m.ts,
             LAG(m.ts) OVER w prev_ts,
             LAG(m.role) OVER w prev_role
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE s.${MAIN_ONLY} AND m.ts >= ${window}
      WINDOW w AS (PARTITION BY m.session_id ORDER BY m.seq)
    )
    SELECT model, AVG((julianday(ts) - julianday(prev_ts)) * 86400) avg_s
    FROM all_msgs
    WHERE role = 'assistant' AND usage_json IS NOT NULL
      AND prev_role IN ('user', 'tool')
      AND (julianday(ts) - julianday(prev_ts)) * 86400 BETWEEN 0.5 AND 300
      AND model IS NOT NULL
    GROUP BY model
  `).all() as { model: string; avg_s: number }[]
  const latencyByModel = new Map(latencyRows.map((r) => [bareModel(r.model), r.avg_s]))

  // ---- 产出维度 ----
  // 活跃时长：消息间隔 cap 5 分钟累加（用户走开/挂壁不计）
  const activeRows = db.prepare(`
    WITH all_msgs AS (
      SELECT COALESCE(m.model, s.model) model, m.ts,
             LAG(m.ts) OVER w prev_ts
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE s.${MAIN_ONLY} AND m.ts >= ${window}
      WINDOW w AS (PARTITION BY m.session_id ORDER BY m.seq)
    )
    SELECT model, SUM(MIN((julianday(ts) - julianday(prev_ts)) * 86400, 300)) active_s
    FROM all_msgs
    WHERE prev_ts IS NOT NULL AND (julianday(ts) - julianday(prev_ts)) * 86400 > 0
      AND model IS NOT NULL
    GROUP BY model
  `).all() as { model: string; active_s: number | null }[]
  const activeByModel = new Map(activeRows.map((r) => [bareModel(r.model), (r.active_s ?? 0) / 3600]))

  // 代码产出：commit 时间落在哪个模型的会话窗口内就归给谁。
  // 注意不按 session.project_path 匹配仓库：agent 会话的 cwd ≠ 实际工作的仓库
  // （如在 personal 起 pi 但改的是 spectator），所以扫 ~/data 下所有 git 仓库 + 全局时间窗归属
  const sessionWindows = db.prepare(`
    SELECT model, started_at, COALESCE(ended_at, started_at) ended_at
    FROM sessions
    WHERE ${MAIN_ONLY} AND model IS NOT NULL AND started_at >= ${window}
  `).all() as { model: string; started_at: string; ended_at: string }[]
  const prodByModel = new Map<string, { commits: number; lines: number }>()
  for (const repo of discoverRepos()) {
    const commits = await gitActivity(repo, windowDays)
    for (const c of commits) {
      for (const w of sessionWindows) {
        const t0 = new Date(w.started_at).getTime()
        const t1 = new Date(w.ended_at).getTime() + 30 * 60_000
        if (c.ts >= t0 && c.ts <= t1) {
          const key = bareModel(w.model)
          const agg = prodByModel.get(key) ?? { commits: 0, lines: 0 }
          agg.commits++
          agg.lines += c.lines
          prodByModel.set(key, agg)
          break // 一个 commit 只归一个模型（取首个匹配窗口）
        }
      }
    }
  }

  return [...merged.values()].map((m) => {
    // 单会话工作负载（复杂度代理）：本模型处理的总 token 量 / 会话数
    // 含 cache_read/cache_creation——缓存读也是真实上下文，只有 0.1x 计价不意味着它没被处理
    const total_tokens = m.input + m.output + m.cr + m.cc
    return {
    model: m.model,
    sessions: m.sessions,
    input_tokens: m.input,
    output_tokens: m.output,
    cost: m.cost,
    avg_workload: m.sessions > 0 ? Math.round(total_tokens / m.sessions) : 0,
    avg_tps: m.tpsN > 0 ? Math.round((m.tpsSum / m.tpsN) * 10) / 10 : null,
    avg_corrections: Math.round((m.corrections / m.sessions) * 10) / 10,
    cache_read: m.cr,
    cache_creation: m.cc,
    cache_hit_pct: m.input + m.cr > 0 ? Math.round((m.cr / (m.input + m.cr)) * 1000) / 10 : 0,
    cache_saved: Math.round(m.saved * 10000) / 10000,
    fail_rate: (() => { const f = failByModel.get(m.model); return f && f.total > 0 ? Math.round((f.fails / f.total) * 1000) / 10 : 0 })(),
    reasoning_tokens: reasonByModel.get(m.model) ?? 0,
    avg_latency_s: latencyByModel.has(m.model) ? Math.round(latencyByModel.get(m.model)! * 10) / 10 : null,
    active_hours: Math.round((activeByModel.get(m.model) ?? 0) * 10) / 10,
    commits: prodByModel.get(m.model)?.commits ?? 0,
    code_lines: prodByModel.get(m.model)?.lines ?? 0,
  }}).sort((a, b) => b.cost - a.cost)
}

// ---- git 仓库发现：会话项目路径 ∪ ~/data 下两层内的仓库 ----
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function discoverRepos(): string[] {
  const repos = new Set<string>()
  for (const r of db.prepare(`SELECT DISTINCT project_path FROM sessions WHERE project_path IS NOT NULL`).all() as { project_path: string }[]) {
    repos.add(r.project_path)
  }
  const dataDir = join(homedir(), 'data')
  const isRepo = (p: string) => { try { return existsSync(join(p, '.git')) } catch { return false } }
  const subdirs = (p: string) => { try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] } }
  for (const d1 of subdirs(dataDir)) {
    const p1 = join(dataDir, d1)
    if (isRepo(p1)) repos.add(p1)
    for (const d2 of subdirs(p1)) {
      const p2 = join(p1, d2)
      if (isRepo(p2)) repos.add(p2)
    }
  }
  return [...repos]
}

// ---- 项目 git 活动（10 分钟内存缓存）----
const gitCache = new Map<string, { at: number; commits: { ts: number; lines: number }[] }>()

async function gitActivity(projectPath: string, sinceDays: number): Promise<{ ts: number; lines: number }[]> {
  const hit = gitCache.get(projectPath)
  if (hit && Date.now() - hit.at < 600_000) return hit.commits
  const commits: { ts: number; lines: number }[] = []
  try {
    // 只算本机 git 身份的提交：团队仓库里同事的提交不归为「我的代码产出」
    let authorArgs: string[] = []
    try {
      const { stdout: email } = await execFileAsync('git', ['-C', projectPath, 'config', 'user.email'], { timeout: 3000 })
      if (email.trim()) authorArgs = [`--author=${email.trim()}`]
    } catch { /* 未配置则不过滤 */ }
    const { stdout } = await execFileAsync('git', [
      '-C', projectPath, 'log', `--since=${Math.trunc(sinceDays)} days ago`, ...authorArgs,
      '--pretty=format:COMMIT %aI', '--shortstat',
    ], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
    let cur: { ts: number; lines: number } | null = null
    for (const line of stdout.split('\n')) {
      if (line.startsWith('COMMIT ')) {
        cur = { ts: new Date(line.slice(7)).getTime(), lines: 0 }
        commits.push(cur)
      } else if (cur && line.includes('changed')) {
        const ins = line.match(/(\d+) insertion/)
        const del = line.match(/(\d+) deletion/)
        cur.lines = (ins ? Number(ins[1]) : 0) + (del ? Number(del[1]) : 0)
      }
    }
  } catch { /* 非 git 目录/超时：空 */ }
  gitCache.set(projectPath, { at: Date.now(), commits })
  return commits
}

// ---- 任务分类：按会话标题规则打标（顺序即优先级）----
const TASK_RULES: [RegExp, string][] = [
  [/周报|日报|总结|复盘|文档|报告|PPT|讲义|博客|文章|readme/i, '文档写作'],
  [/修复|fix|bug|报错|错误|挂了|不行|失败|异常|排查/i, '调试修复'],
  [/重构|refactor|优化|清理|瘦身/i, '重构优化'],
  [/数据|迁移|导入|清洗|sql|统计|报表/i, '数据处理'],
  [/学习|什么是|解释|原理|复习|面试|怎么看|区别/i, '学习探索'],
  [/实现|开发|功能|接口|新增|添加|支持|接入|搭建/i, '开发实现'],
]

export function classifyTask(title: string | null): string {
  if (!title) return '其他'
  for (const [re, task] of TASK_RULES) if (re.test(title)) return task
  return '其他'
}

// ---- 任务×模型统计：每个任务类型下各模型的成本/纠正/产出 ----
export function taskModelStats(windowDays = 30) {
  const window = isoWindow(windowDays)
  const corrBySession = new Map(
    (db.prepare(`SELECT session_id, COUNT(*) n FROM signals WHERE kind = 'correction' GROUP BY session_id`).all() as { session_id: string; n: number }[])
      .map((r) => [r.session_id, r.n])
  )
  const withId = db.prepare(`
    SELECT id, title, model, input_tokens, output_tokens, cache_read, cache_creation
    FROM sessions
    WHERE ${MAIN_ONLY} AND model IS NOT NULL AND title IS NOT NULL AND started_at >= ${window}
  `).all() as { id: string; title: string; model: string; input_tokens: number; output_tokens: number; cache_read: number; cache_creation: number }[]

  const agg = new Map<string, { task: string; model: string; sessions: number; cost: number; corrections: number; output_tokens: number; total_tokens: number }>()
  for (const r of withId) {
    const task = classifyTask(r.title)
    const model = bareModel(r.model)
    const key = `${task}|${model}`
    const a = agg.get(key) ?? { task, model, sessions: 0, cost: 0, corrections: 0, output_tokens: 0, total_tokens: 0 }
    a.sessions++
    a.cost += costOf(r.model, r.input_tokens, r.output_tokens, r.cache_read, r.cache_creation) ?? 0
    a.corrections += corrBySession.get(r.id) ?? 0
    a.output_tokens += r.output_tokens
    a.total_tokens += r.input_tokens + r.output_tokens + r.cache_read + r.cache_creation
    agg.set(key, a)
  }
  return [...agg.values()].map((a) => ({
    task: a.task,
    model: a.model,
    sessions: a.sessions,
    cost: Math.round(a.cost * 100) / 100,
    cost_per_session: Math.round((a.cost / a.sessions) * 100) / 100,
    avg_corrections: Math.round((a.corrections / a.sessions) * 10) / 10,
    output_tokens: a.output_tokens,
    avg_workload: a.sessions > 0 ? Math.round(a.total_tokens / a.sessions) : 0,
  })).sort((a, b) => a.task.localeCompare(b.task) || b.cost - a.cost)
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
    WHERE s.project_path = ? AND s.${MAIN_ONLY} AND m.ts >= ?
    ORDER BY m.session_id, m.ts
  `).all(path, new Date(Date.now() - 100 * 86400e3).toISOString()) as { session_id: string; d: string; ts: string; cum_input: number; cum_output: number; model: string | null; s_in: number; s_cache: number }[]
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

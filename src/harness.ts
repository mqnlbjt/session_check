// Harness 建议引擎：观测数据 → harness 改进建议（期5 MVP）
// ① 防呆规则：项目高频纠正信号 → LLM 生成规则文案（可注入，测试不真 spawn）
// ② 模型建议：纯数据对比，只展示不落库
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { db } from './db.js'
import { modelCompare, taskModelStats } from './analytics.js'
import { persistToInstructions } from './persist.js'
import type { AgentType } from './model.js'

export type LlmFn = (agent: AgentType, prompt: string) => Promise<string>

const CLI_ARGS: Record<AgentType, (prompt: string) => string[]> = {
  pi: (p) => ['--print', '--no-session', '--no-tools', p],
  claude: (p) => ['-p', p],
  codex: (p) => ['exec', p],
}

// 真实 LLM：headless 调 agent CLI（与 review.ts 同套路，拿到输出就杀进程防扩展挂住）
export const defaultLlm: LlmFn = (agent, prompt) =>
  new Promise((resolve, reject) => {
    const workdir = join(tmpdir(), 'spectator-harness')
    mkdirSync(workdir, { recursive: true })
    const child = spawn(agent === 'pi' ? 'pi' : agent, CLI_ARGS[agent](prompt), {
      cwd: workdir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = '', settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      fn()
    }
    const timer = setTimeout(() => done(() => reject(new Error(`${agent} 生成超时（3 分钟）`))), 180_000)
    child.stdout.on('data', (d) => {
      out += d
      // 流式验收：出现完整 JSON 数组就收工
      if (parseRulesJson(out).length) done(() => resolve(out))
    })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => done(() => reject(new Error(`无法启动 ${agent}: ${e.message}`))))
    child.on('close', (code) => {
      if (code !== 0) done(() => reject(new Error(`${agent} 退出码 ${code}: ${err.slice(-300)}`)))
      else done(() => resolve(out))
    })
  })

// 从输出里提取 JSON 字符串数组（容错：从第一个 [ 到最后一个 ]，容忍规则文案里的 ])
export function parseRulesJson(text: string): string[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(arr)) return []
    return arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 4).slice(0, 3)
  } catch { return [] }
}

const RULE_LABEL: Record<string, string> = {
  wrong: '不对/错了', redo: '重来/重新', 'not-what-i-said': '我不是说/你理解错',
  'stop-change': '别改/回退', 'why-did-you': '你为什么/谁让你',
}

// 取信号消息的前一条 assistant 摘要（截 200 字）——LLM 需要看到「agent 做了什么 → 用户纠正什么」（#12 P2）
const prevAssistantStmt = db.prepare(`
  SELECT blocks_json FROM messages
  WHERE session_id = ? AND role = 'assistant' AND seq < (SELECT seq FROM messages WHERE id = ?)
  ORDER BY seq DESC LIMIT 1
`)
function prevAssistantSummary(sessionId: string, messageId: number): string | null {
  const row = prevAssistantStmt.get(sessionId, messageId) as { blocks_json: string } | undefined
  if (!row) return null
  try {
    const blocks = JSON.parse(row.blocks_json) as { type: string; text?: string }[]
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(' ')
      .replace(/\s+/g, ' ').trim()
    return text ? text.slice(0, 200) : null
  } catch { return null }
}

// 项目的 top 纠正信号（规则 + 频次 + 样本），90 天滚动窗——旧模式不霸榜，采纳后自然消退（#12 P1）
const SIGNAL_WINDOW_DAYS = 90
// 90 天滚动窗起点——所有信号查询共用，保证窗口口径一致
function windowSince(): string {
  return new Date(Date.now() - SIGNAL_WINDOW_DAYS * 86400000).toISOString()
}
function topCorrectionSignals(projectPath: string, limit = 3) {
  const since = windowSince()
  const rules = db.prepare(`
    SELECT sig.rule, COUNT(*) n FROM signals sig
    JOIN sessions s ON s.id = sig.session_id
    WHERE s.project_path = ? AND sig.kind = 'correction' AND sig.ts >= ?
    GROUP BY sig.rule ORDER BY n DESC LIMIT ?
  `).all(projectPath, since, limit) as { rule: string; n: number }[]
  return rules.map((r) => ({
    ...r,
    samples: (db.prepare(`
      SELECT sig.snippet, sig.session_id, sig.message_id FROM signals sig JOIN sessions s ON s.id = sig.session_id
      WHERE s.project_path = ? AND sig.kind = 'correction' AND sig.rule = ? AND sig.snippet IS NOT NULL AND sig.ts >= ?
      ORDER BY sig.ts DESC LIMIT 3
    `).all(projectPath, r.rule, since) as { snippet: string; session_id: string; message_id: number }[])
      .map((x) => ({ snippet: x.snippet, prev: prevAssistantSummary(x.session_id, x.message_id) })),
  }))
}

export function dominantAgent(projectPath: string): AgentType {
  const row = db.prepare(
    `SELECT agent, COUNT(*) n FROM sessions WHERE project_path = ? GROUP BY agent ORDER BY n DESC LIMIT 1`
  ).get(projectPath) as { agent: AgentType } | undefined
  return row?.agent ?? 'pi'
}

// give-up 挫折样本作痛点佐证：不进频次排序，只附 1-2 条让 LLM 感受到真实痛点（#12 P4）
function giveUpSamples(projectPath: string, limit = 2): string[] {
  const since = windowSince()
  return (db.prepare(`
    SELECT sig.snippet FROM signals sig JOIN sessions s ON s.id = sig.session_id
    WHERE s.project_path = ? AND sig.kind = 'frustration' AND sig.rule = 'give-up'
      AND sig.snippet IS NOT NULL AND sig.ts >= ?
    ORDER BY sig.ts DESC LIMIT ?
  `).all(projectPath, since, limit) as { snippet: string }[]).map((x) => x.snippet)
}

// 项目已否决/已采纳的规则内容——进 prompt 作语义排除清单，挡住 LLM 换措辞重述同一主题（#12 P0）
function excludedRuleContents(projectPath: string): string[] {
  return (db.prepare(
    `SELECT content FROM suggestions WHERE project_path = ? AND kind = 'guard_rule' AND status IN ('adopted', 'dismissed')`
  ).all(projectPath) as { content: string }[]).map((x) => x.content)
}

function buildPrompt(projectPath: string, signals: ReturnType<typeof topCorrectionSignals>, giveUps: string[], excluded: string[]): string {
  const lines = signals.map((s) =>
    `- 「${RULE_LABEL[s.rule] ?? s.rule}」出现 ${s.n} 次，样本：${s.samples.map((x) =>
      x.prev ? `“${x.snippet}”（此前 agent：“${x.prev}”）` : `“${x.snippet}”`).join('；')}`
  ).join('\n')
  const giveUpSection = giveUps.length
    ? `\n\n痛点佐证（用户挫折表达，仅供感受严重程度，不要为其单独生成规则）：${giveUps.map((x) => `“${x}”`).join('；')}`
    : ''
  const excludeSection = excluded.length
    ? `\n\n以下规则已被用户否决或采纳，不要生成与它们语义重复的规则：${excluded.map((x) => `“${x}”`).join('；')}`
    : ''
  return `你在分析一个开发者与 coding agent 协作的历史信号。项目 ${projectPath} 中，用户纠正 agent 的高频模式如下：

${lines}${giveUpSection}${excludeSection}

请总结 1-3 条应该写进该项目 AGENTS.md 的防呆规则。要求：中文、每条一句话、具体可执行（针对上述真实纠正模式，不要泛泛的"认真一点"）。
只输出 JSON 字符串数组，不要任何其他内容：["规则1", "规则2"]`
}

// 生成防呆规则建议：信号聚合 → LLM → 落 suggestions（pending）
export async function generateGuardRules(projectPath: string, llm: LlmFn = defaultLlm): Promise<string[]> {
  const signals = topCorrectionSignals(projectPath)
  if (!signals.length) return []
  const out = await llm(dominantAgent(projectPath), buildPrompt(projectPath, signals, giveUpSamples(projectPath), excludedRuleContents(projectPath)))
  const rules = parseRulesJson(out)
  if (!rules.length) return []

  const evidence = JSON.stringify(signals.map((s) => ({ rule: s.rule, n: s.n })))
  const insert = db.prepare(
    `INSERT INTO suggestions (project_path, kind, content, evidence, status, created_at) VALUES (?, 'guard_rule', ?, ?, 'pending', ?)`
  )
  // 去重闭环：dismissed（用户否掉）和 adopted（已写进 AGENTS.md）都不再重复生成（#12 P0）
  const dup = db.prepare(`SELECT 1 FROM suggestions WHERE project_path = ? AND content = ? AND status IN ('pending', 'dismissed', 'adopted') LIMIT 1`)
  const now = new Date().toISOString()
  const added: string[] = []
  for (const rule of rules) {
    if (dup.get(projectPath, rule)) continue // 与已有记录（含 dismissed/adopted）去重
    insert.run(projectPath, rule, evidence, now)
    added.push(rule)
  }
  return added
}

// 模型建议：30 天窗口（模型更新快，90 天数据会误导）。
// 触发：成本 >$20 + 存在「质量相当但便宜得多」的替代（纠正率容差 +0.2，会话数 ≥5）
// 证据：两个模型的完整指标对比（成本/纠正/失败/延迟/TPS/缓存/产出），前端渲染对比表
interface ModelMetrics {
  model: string; sessions: number; cost: number; avg_corrections: number
  fail_rate: number; avg_latency_s: number | null; avg_tps: number | null
  cache_hit_pct: number; active_hours: number; commits: number; code_lines: number
}

export async function modelAdvice(): Promise<{ content: string; evidence: string }[]> {
  const models = (await modelCompare(30)) as ModelMetrics[]
  const advice: { content: string; evidence: string }[] = []
  for (const m of models) {
    if (m.cost < 20) continue
    const alt = models.find((x) =>
      x.model !== m.model && x.sessions >= 5 &&
      x.cost < m.cost * 0.5 &&
      x.avg_corrections <= m.avg_corrections + 0.2)
    if (!alt) continue
    const saving = Math.min(99, Math.round((1 - alt.cost / m.cost) * 100))
    const parts = [`成本低 ${saving}%`]
    if (alt.avg_latency_s && m.avg_latency_s && alt.avg_latency_s < m.avg_latency_s * 0.7) {
      parts.push(`响应快 ${(m.avg_latency_s / alt.avg_latency_s).toFixed(1)} 倍`)
    }
    advice.push({
      content: `${m.model} 近 30 天 $${m.cost.toFixed(1)}（${m.sessions} 会话），${alt.model} 质量相当（纠正率 ${alt.avg_corrections} vs ${m.avg_corrections}）但${parts.join('、')}——建议把部分任务切到 ${alt.model}`,
      evidence: JSON.stringify({
        window_days: 30,
        from: m,
        to: alt,
        saving_pct: saving,
      }),
    })
  }
  return advice
}

// 任务×模型推荐：同一任务类型下，纠正率相当（容差 +0.3）的最便宜模型
// 样本量门槛：每个模型在该任务下 ≥2 会话；当前用的比推荐的贵 1.5 倍以上才建议
export function taskAdvice(windowDays = 30): { task: string; content: string; evidence: string }[] {
  const stats = taskModelStats(windowDays)
  const byTask = new Map<string, typeof stats>()
  for (const s of stats) {
    if (s.sessions < 2) continue
    const arr = byTask.get(s.task) ?? []
    arr.push(s)
    byTask.set(s.task, arr)
  }
  const advice: { task: string; content: string; evidence: string }[] = []
  for (const [task, models] of byTask) {
    if (task === '其他' || models.length < 2) continue
    const minCorr = Math.min(...models.map((m) => m.avg_corrections))
    const eligible = models.filter((m) => m.avg_corrections <= minCorr + 0.3)
    const recommended = eligible.reduce((a, b) => (a.cost_per_session <= b.cost_per_session ? a : b))
    const current = models.reduce((a, b) => (a.cost > b.cost ? a : b)) // 花钱最多的当「现状」
    if (recommended.model === current.model) continue
    if (current.cost_per_session < recommended.cost_per_session * 1.5) continue
    if (current.cost < 2) continue // 绝对金额太小的建议是噪音（省 50% 但只值 $0.05）
    const saving = Math.min(99, Math.round((1 - recommended.cost_per_session / current.cost_per_session) * 100))
    advice.push({
      task,
      content: `「${task}」类任务：你在用 ${current.model}（$${current.cost_per_session}/会话、纠正率 ${current.avg_corrections}），` +
        `${recommended.model} 同任务纠正率 ${recommended.avg_corrections} 相当、$${recommended.cost_per_session}/会话——省 ${saving}%`,
      evidence: JSON.stringify({ task, recommended, current, saving_pct: saving, window_days: windowDays }),
    })
  }
  return advice.sort((a, b) => JSON.parse(b.evidence).saving_pct - JSON.parse(a.evidence).saving_pct)
}

export async function listSuggestions() {
  const suggestions = db.prepare(
    `SELECT * FROM suggestions ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'adopted' THEN 1 ELSE 2 END, created_at DESC`
  ).all()
  // 生成入口候选：有纠正信号的项目（前端「生成建议」按钮列表）
  const candidates = db.prepare(`
    SELECT s.project_path, COUNT(*) corrections FROM signals sig
    JOIN sessions s ON s.id = sig.session_id
    WHERE sig.kind = 'correction' AND s.project_path IS NOT NULL
    GROUP BY s.project_path ORDER BY corrections DESC LIMIT 10
  `).all()
  return { suggestions, modelAdvice: await modelAdvice(), taskAdvice: taskAdvice(), candidates }
}

export function adoptSuggestion(id: number): { adopted_to: string } | null {
  const row = db.prepare(`SELECT * FROM suggestions WHERE id = ?`).get(id) as any
  if (!row || row.status !== 'pending') return null
  const agent = dominantAgent(row.project_path)
  const filePath = persistToInstructions(row.project_path, agent, 'harness 建议', [
    { detail: row.content, evidence: row.evidence ?? undefined },
  ])
  db.prepare(`UPDATE suggestions SET status = 'adopted', adopted_to = ? WHERE id = ?`).run(filePath, id)
  return { adopted_to: filePath }
}

export function dismissSuggestion(id: number): boolean {
  return db.prepare(`UPDATE suggestions SET status = 'dismissed' WHERE id = ? AND status = 'pending'`).run(id).changes > 0
}

// Harness 建议引擎：观测数据 → harness 改进建议（期5 MVP）
// ① 防呆规则：项目高频纠正信号 → LLM 生成规则文案（可注入，测试不真 spawn）
// ② 模型建议：纯数据对比，只展示不落库
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { db } from './db.js'
import { modelCompare } from './analytics.js'
import { persistToInstructions } from './persist.js'
import type { AgentType } from './model.js'

export type LlmFn = (agent: AgentType, prompt: string) => Promise<string>

const CLI_ARGS: Record<AgentType, (prompt: string) => string[]> = {
  pi: (p) => ['--print', '--no-session', '--no-tools', p],
  claude: (p) => ['-p', p],
  codex: (p) => ['exec', p],
}

// 真实 LLM：headless 调 agent CLI（与 review.ts 同套路，拿到输出就杀进程防扩展挂住）
const defaultLlm: LlmFn = (agent, prompt) =>
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

// 从输出里提取 JSON 字符串数组（容错：只接受纯字符串数组）
export function parseRulesJson(text: string): string[] {
  const m = text.match(/\[[\s\S]*?\]/)
  if (!m) return []
  try {
    const arr = JSON.parse(m[0])
    if (!Array.isArray(arr)) return []
    return arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 4).slice(0, 5)
  } catch { return [] }
}

const RULE_LABEL: Record<string, string> = {
  wrong: '不对/错了', redo: '重来/重新', 'not-what-i-said': '我不是说/你理解错',
  'stop-change': '别改/回退', 'why-did-you': '你为什么/谁让你',
}

// 项目的 top 纠正信号（规则 + 频次 + 样本）
function topCorrectionSignals(projectPath: string, limit = 3) {
  const rules = db.prepare(`
    SELECT sig.rule, COUNT(*) n FROM signals sig
    JOIN sessions s ON s.id = sig.session_id
    WHERE s.project_path = ? AND sig.kind = 'correction'
    GROUP BY sig.rule ORDER BY n DESC LIMIT ?
  `).all(projectPath, limit) as { rule: string; n: number }[]
  return rules.map((r) => ({
    ...r,
    samples: (db.prepare(`
      SELECT sig.snippet FROM signals sig JOIN sessions s ON s.id = sig.session_id
      WHERE s.project_path = ? AND sig.kind = 'correction' AND sig.rule = ? AND sig.snippet IS NOT NULL
      ORDER BY sig.ts DESC LIMIT 3
    `).all(projectPath, r.rule) as { snippet: string }[]).map((x) => x.snippet),
  }))
}

function dominantAgent(projectPath: string): AgentType {
  const row = db.prepare(
    `SELECT agent, COUNT(*) n FROM sessions WHERE project_path = ? GROUP BY agent ORDER BY n DESC LIMIT 1`
  ).get(projectPath) as { agent: AgentType } | undefined
  return row?.agent ?? 'pi'
}

function buildPrompt(projectPath: string, signals: ReturnType<typeof topCorrectionSignals>): string {
  const lines = signals.map((s) =>
    `- 「${RULE_LABEL[s.rule] ?? s.rule}」出现 ${s.n} 次，样本：${s.samples.map((x) => `“${x}”`).join('；')}`
  ).join('\n')
  return `你在分析一个开发者与 coding agent 协作的历史信号。项目 ${projectPath} 中，用户纠正 agent 的高频模式如下：

${lines}

请总结 1-3 条应该写进该项目 AGENTS.md 的防呆规则。要求：中文、每条一句话、具体可执行（针对上述真实纠正模式，不要泛泛的"认真一点"）。
只输出 JSON 字符串数组，不要任何其他内容：["规则1", "规则2"]`
}

// 生成防呆规则建议：信号聚合 → LLM → 落 suggestions（pending）
export async function generateGuardRules(projectPath: string, llm: LlmFn = defaultLlm): Promise<string[]> {
  const signals = topCorrectionSignals(projectPath)
  if (!signals.length) return []
  const out = await llm(dominantAgent(projectPath), buildPrompt(projectPath, signals))
  const rules = parseRulesJson(out)
  if (!rules.length) return []

  const evidence = JSON.stringify(signals.map((s) => ({ rule: s.rule, n: s.n })))
  const insert = db.prepare(
    `INSERT INTO suggestions (project_path, kind, content, evidence, status, created_at) VALUES (?, 'guard_rule', ?, ?, 'pending', ?)`
  )
  const now = new Date().toISOString()
  for (const rule of rules) insert.run(projectPath, rule, evidence, now)
  return rules
}

// 模型建议：纯数据。成本高 + 存在「质量相当但便宜得多」的替代 → 建议
// 质量相当的定义：替代品平均纠正率不显著更高（+0.2 容差）
export function modelAdvice(): { content: string; evidence: string }[] {
  const models = modelCompare()
  const advice: { content: string; evidence: string }[] = []
  for (const m of models) {
    if ((m.cost ?? 0) < 20) continue
    const alt = models.find((x) =>
      x.model !== m.model && x.sessions >= 5 &&
      (x.cost ?? 0) < (m.cost ?? 0) * 0.5 &&
      x.avg_corrections <= m.avg_corrections + 0.2)
    if (!alt) continue
    const saving = Math.min(99, Math.round((1 - (alt.cost ?? 0) / (m.cost ?? 1)) * 100))
    const tpsPart = alt.avg_tps ? `、TPS ${alt.avg_tps}` : ''
    advice.push({
      content: `${m.model} 近 90 天 $${(m.cost ?? 0).toFixed(1)}（纠正率 ${m.avg_corrections}）；` +
        `${alt.model} 纠正率 ${alt.avg_corrections} 相当${tpsPart}、成本低 ${saving}%——建议把部分任务切到 ${alt.model}`,
      evidence: JSON.stringify({ from: m.model, to: alt.model, cost_from: m.cost, cost_to: alt.cost }),
    })
  }
  return advice
}

export function listSuggestions() {
  const suggestions = db.prepare(
    `SELECT * FROM suggestions ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'adopted' THEN 1 ELSE 2 END, created_at DESC`
  ).all()
  return { suggestions, modelAdvice: modelAdvice() }
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

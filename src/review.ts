import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { db } from './db.js'
import type { AgentType } from './model.js'

// 复盘调度：把压缩后的对话交给本地 agent CLI（headless）评审
// pi --print / claude -p / codex exec，纯 JSON 从 stdout 回收
// 用会话自己的 agent 复盘：pi 的会话 pi 评，claude 的会话 claude 评

const CHAR_BUDGET = 100_000
const REVIEW_TIMEOUT_MS = 5 * 60_000

const msgsStmt = db.prepare(`
  SELECT seq, role, ts, blocks_json, model FROM messages WHERE session_id = ? ORDER BY seq
`)

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

// 把消息流压成评审友好的文本：用户全留，assistant 截断，thinking 丢弃，工具只留摘要
function compress(sessionPk: string): { text: string; kept: number; total: number } {
  const rows = msgsStmt.all(sessionPk) as { seq: number; role: string; blocks_json: string }[]
  const lines: string[] = []

  for (const r of rows) {
    const blocks = JSON.parse(r.blocks_json) as any[]
    const parts: string[] = []
    for (const b of blocks) {
      if (b.type === 'text' && b.text) parts.push(trunc(b.text, r.role === 'user' ? 2000 : 800))
      else if (b.type === 'tool_call') {
        const input = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? '')
        parts.push(`[调用 ${b.name}] ${trunc(input, 200)}`)
      } else if (b.type === 'tool_result') {
        parts.push(`[${b.isError ? '工具结果(错误)' : '工具结果'}] ${trunc(b.output ?? '', 300)}`)
      }
    }
    if (!parts.length) continue
    const role = { user: '用户', assistant: 'AGENT', tool: 'TOOL', system: '系统' }[r.role] ?? r.role
    lines.push(`[#${r.seq} ${role}] ${parts.join('\n')}`)
  }

  const total = lines.length
  let chars = lines.reduce((a, l) => a + l.length, 0)
  if (chars <= CHAR_BUDGET) return { text: lines.join('\n\n'), kept: total, total }

  // 超预算：保留开头 15 条建立上下文 + 结尾尽量多，中间省略
  const head = lines.slice(0, 15)
  const tail: string[] = []
  let budget = CHAR_BUDGET - head.reduce((a, l) => a + l.length, 0) - 200
  for (let i = lines.length - 1; i >= 15 && budget > 0; i--) {
    tail.unshift(lines[i])
    budget -= lines[i].length
  }
  const omitted = lines.length - head.length - tail.length
  return {
    text: [...head, `\n[…中间省略 ${omitted} 条…]\n`, ...tail].join('\n\n'),
    kept: head.length + tail.length,
    total,
  }
}

const RUBRIC = `你是一名 coding agent 会话质量评审员。下面是一段 agent（编程助手）与用户的对话记录（已压缩，[#序号 角色] 开头）。

评审 agent 的表现，严格只输出 JSON（不要输出任何其他内容、不要用 markdown 代码块包裹）：
{"verdict":"good|mixed|problematic","summary":"一段话总结（100字内）","findings":[{"type":"rework|correction|misunderstanding|good_practice|lesson|risk","detail":"一句话说清","evidence":"#消息序号"}]}

评审维度：
- rework 返工：被推翻重来或重复劳动的地方及根因
- correction 用户纠正：用户打断/纠正了几次，各是因为什么
- misunderstanding 理解偏差：对需求理解哪里跑偏了
- good_practice 亮点（没有就不写）
- lesson 可复用经验：下次能用的教训
- risk 危险操作：误删/泄密/越权（没有就不写）

findings 3-8 条。只输出 JSON。

对话记录：
`

export interface EngineResult {
  verdict: string
  summary: string | null
  findings: { type: string; detail: string; evidence?: string }[]
}

const CLI_ARGS: Record<AgentType, (prompt: string) => string[]> = {
  // --no-session 不污染会话库；--no-tools 评审是纯文本任务不需要工具
  pi: (p) => ['--print', '--no-session', '--no-tools', p],
  claude: (p) => ['-p', p],
  codex: (p) => ['exec', p],
}

function runCli(agent: AgentType, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const workdir = join(tmpdir(), 'spectator-review')
    mkdirSync(workdir, { recursive: true })
    const child = spawn(agent === 'pi' ? 'pi' : agent, CLI_ARGS[agent](prompt), {
      cwd: workdir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = '', settled = false

    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL') // 扩展可能挂住事件循环（如 pi-intercom 的 WS），拿到结果就主动杀
      fn()
    }
    const timer = setTimeout(() => {
      done(() => reject(new Error(`${agent} 复盘超时（5 分钟）`)))
    }, REVIEW_TIMEOUT_MS)

    child.stdout.on('data', (d) => {
      out += d
      // 流式验收：stdout 出现可解析的完整评审 JSON 就收工，不等进程自然退出
      try {
        parseReviewJson(out)
        done(() => resolve(out))
      } catch { /* JSON 还没出全，继续等 */ }
    })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => done(() => reject(new Error(`无法启动 ${agent}: ${e.message}`))))
    child.on('close', (code) => {
      if (code !== 0) done(() => reject(new Error(`${agent} 退出码 ${code}: ${err.slice(-300)}`)))
      else done(() => resolve(out))
    })
  })
}

function parseReviewJson(content: string): EngineResult {
  const tryParse = (s: string) => {
    try {
      const obj = JSON.parse(s)
      if (obj && typeof obj === 'object' && Array.isArray(obj.findings)) return obj
    } catch { /* fallthrough */ }
    return null
  }
  let obj = tryParse(content.trim())
  if (!obj) {
    const m = content.match(/\{[\s\S]*\}/)
    if (m) obj = tryParse(m[0])
  }
  if (!obj) throw new Error('agent 输出无法解析为 JSON')
  return {
    verdict: ['good', 'mixed', 'problematic'].includes(obj.verdict) ? obj.verdict : 'mixed',
    summary: typeof obj.summary === 'string' ? obj.summary : null,
    findings: obj.findings
      .filter((f: any) => f && typeof f.detail === 'string')
      .slice(0, 10)
      .map((f: any) => ({ type: String(f.type ?? 'lesson'), detail: f.detail, evidence: f.evidence ? String(f.evidence) : undefined })),
  }
}

// 任务状态跟踪：前端轮询用
const running = new Map<string, { startedAt: number }>()
const lastError = new Map<string, string>()

export function reviewStatus(sessionPk: string) {
  return {
    running: running.has(sessionPk),
    error: lastError.get(sessionPk) ?? null,
  }
}

export function startReview(sessionPk: string, agent: AgentType, insertReview: (r: EngineResult & { sessionPk: string; source: string }) => void) {
  if (running.has(sessionPk)) return false
  running.set(sessionPk, { startedAt: Date.now() })
  lastError.delete(sessionPk)

  ;(async () => {
    const { text, kept, total } = compress(sessionPk)
    if (!text.trim()) throw new Error('会话没有可评审的内容')
    const prompt = `${RUBRIC}（共 ${kept}/${total} 条）\n\n${text}`
    const out = await runCli(agent, prompt)
    const result = parseReviewJson(out)
    insertReview({ ...result, sessionPk, source: `${agent}-agent` })
  })()
    .catch((e) => {
      console.error(`[review] ${sessionPk} 失败:`, e)
      lastError.set(sessionPk, e?.message ?? '复盘失败')
    })
    .finally(() => running.delete(sessionPk))

  return true
}

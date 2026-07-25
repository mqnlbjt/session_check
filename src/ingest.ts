import { openSync, readSync, fstatSync, closeSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import type { AgentType, ParseResult, ParserFactory } from './model.js'
import { createPiParser } from './parsers/pi.js'
import { createClaudeParser } from './parsers/claude.js'
import { createCodexParser } from './parsers/codex.js'
import { appendMessage, readSource, saveSessionMeta, saveSource, setCumulativeUsage, countMessages, getContentHashes, appendMetric, db } from './db.js'
import { backfillTps } from './tps.js'

const HOME = homedir()

// ---- 监控目录：默认 + 环境变量 + 配置文件（可多份，agent 可省略靠嗅探）----

export interface SourceRoot { path: string; agent?: AgentType }

function defaultRoots(): SourceRoot[] {
  const roots: SourceRoot[] = [
    { path: join(HOME, '.pi/agent/sessions'), agent: 'pi' },
    { path: join(HOME, '.claude/projects'), agent: 'claude' },
    { path: join(HOME, '.codex/sessions'), agent: 'codex' },
    { path: join(HOME, '.codex/archived_sessions'), agent: 'codex' },
  ]
  // agent 支持环境变量重定向数据目录，一并纳入
  if (process.env.CLAUDE_CONFIG_DIR) {
    roots.push({ path: join(process.env.CLAUDE_CONFIG_DIR, 'projects'), agent: 'claude' })
  }
  if (process.env.CODEX_HOME) {
    roots.push({ path: join(process.env.CODEX_HOME, 'sessions'), agent: 'codex' })
    roots.push({ path: join(process.env.CODEX_HOME, 'archived_sessions'), agent: 'codex' })
  }
  return roots
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(HOME, p.slice(2)) : p
}

export function loadRoots(): SourceRoot[] {
  const roots = defaultRoots()
  const cfgPaths = [
    process.env.SPECTATOR_CONFIG,
    join(HOME, '.config/spectator/config.json'),
    resolve('spectator.config.json'),
  ].filter(Boolean) as string[]
  for (const p of cfgPaths) {
    if (!existsSync(p)) continue
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf8'))
      for (const s of cfg.sources ?? []) {
        roots.push({ path: expandHome(s.path), agent: s.agent })
      }
    } catch (e) {
      console.error(`[config] 解析 ${p} 失败:`, e)
    }
  }
  // 去重 + 过滤不存在的目录
  const seen = new Set<string>()
  return roots.filter((r) => {
    if (seen.has(r.path) || !existsSync(r.path)) return false
    seen.add(r.path)
    return true
  })
}

// ---- agent 类型嗅探：不认路径认内容，任何目录扔进来都能识别 ----

export function sniffAgent(filePath: string): AgentType | null {
  let fd: number
  try { fd = openSync(filePath, 'r') } catch { return null }
  try {
    const buf = Buffer.alloc(8192)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const head = buf.toString('utf8', 0, n)
    for (const raw of head.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'session' && obj.id && obj.cwd) return 'pi'
        if (obj.type === 'session_meta') return 'codex'
        if (obj.sessionId && (obj.type === 'user' || obj.type === 'assistant'
          || obj.type === 'system' || obj.type === 'queue-operation' || obj.type === 'summary')) return 'claude'
      } catch { continue }
    }
    return null
  } finally {
    closeSync(fd)
  }
}

const parserFactories: Record<AgentType, ParserFactory> = {
  pi: createPiParser,
  claude: createClaudeParser,
  codex: createCodexParser,
}

// 没有 event_id 的消息（codex）用内容哈希兜底，
// 同一会话文件出现在多个目录也不会重复入库
function fallbackEventId(agent: AgentType, role: string, ts: string, blocksJson: string): string {
  const h = createHash('sha1').update(`${role}|${ts}|${blocksJson}`).digest('hex').slice(0, 16)
  return `${agent}:h:${h}`
}

function* walk(dir: string): Generator<string> {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'subagent-artifacts' || e.name === 'node_modules') continue
      yield* walk(p)
    } else if (e.name.endsWith('.jsonl')) {
      yield p
    }
  }
}

// 从 offset 增量读取一个 session 文件，解析入库，返回新增消息数
export function ingestFile(path: string, agentHint?: AgentType): number {
  const prev = readSource(path)
  const agent = prev?.agent as AgentType | undefined ?? agentHint ?? sniffAgent(path) ?? undefined
  if (!agent || !parserFactories[agent]) return 0

  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const offset = prev && prev.offset <= size ? prev.offset : 0
    if (offset === size) return 0

    const buf = Buffer.alloc(size - offset)
    readSync(fd, buf, 0, buf.length, offset)
    const chunk = buf.toString('utf8')
    const lastNl = chunk.lastIndexOf('\n')
    if (lastNl < 0) return 0 // 还没有完整行，下次再读

    const complete = chunk.slice(0, lastNl)
    const newOffset = offset + Buffer.byteLength(complete) + 1

    const parseLine = parserFactories[agent]({ filePath: path })
    let sessionPk: string | null = prev ? `${agent}:${prev.session_id}` : null
    let msgCount = prev?.msg_count ?? 0
    let added = 0
    // codex resume：新文件指向已有会话时，开头会逐字重放历史（仅 ts 不同）
    // 进入前缀跳过模式：连续命中已有内容哈希的消息跳过，遇到新消息即退出
    let prefixSkip: Set<string> | null = null

    for (const raw of complete.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      let obj: any
      try { obj = JSON.parse(line) } catch { continue }

      let result: ParseResult | null
      try { result = parseLine(obj) } catch { continue }
      if (!result) continue

      if (result.meta) {
        const isNewFile = !prev
        sessionPk = saveSessionMeta(agent, result.meta)
        if (isNewFile) {
          const existing = countMessages(sessionPk)
          if (existing > 0) {
            prefixSkip = getContentHashes(sessionPk)
            msgCount = existing // 多文件合并同一会话，seq 接续现有消息数
          }
        }
      }
      if (result.message) {
        if (!sessionPk) continue // 还没见到 session 元信息，跳过
        const blocksJson = JSON.stringify(result.message.blocks)
        if (prefixSkip) {
          if (prefixSkip.has(`${result.message.role}|${blocksJson}`)) continue
          prefixSkip = null // 重放结束，后面全是新内容
        }
        if (!result.message.eventId) {
          result.message.eventId = fallbackEventId(agent, result.message.role, result.message.ts, blocksJson)
        }
        if (appendMessage(sessionPk, msgCount, result.message)) {
          msgCount++
          added++
        }
      }
      if (result.sessionUsage && sessionPk) {
        setCumulativeUsage(sessionPk, result.sessionUsage)
      }
      if (result.metric && sessionPk) {
        appendMetric(sessionPk, result.metric)
      }
    }

    // 文件可能还没写出 session 行（极小概率），此时存不了 source 记录，直接等下轮
    if (sessionPk) {
      saveSource({ path, agent, session_id: sessionPk.slice(agent.length + 1), offset: newOffset, msg_count: msgCount })
    }
    return added
  } finally {
    closeSync(fd)
  }
}

// 用首条用户消息兜底生成标题（只补没有标题的 session）
// 必须在 ingest 之后跑：session 元信息行先于消息行出现，解析时消息还没入库
const untitledStmt = db.prepare(`SELECT id FROM sessions WHERE title IS NULL`)
const firstUserMsg = db.prepare(`
  SELECT blocks_json FROM messages
  WHERE session_id = ? AND role = 'user' ORDER BY ts LIMIT 1
`)
const setTitle = db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`)

export function backfillAllTitles(): number {
  let n = 0
  for (const { id } of untitledStmt.all() as { id: string }[]) {
    const row = firstUserMsg.get(id) as { blocks_json: string } | undefined
    if (!row) continue
    try {
      const blocks = JSON.parse(row.blocks_json) as { type: string; text?: string }[]
      const text = blocks.find((b) => b.type === 'text')?.text?.trim()
      if (text) { setTitle.run(text.slice(0, 80), id); n++ }
    } catch { /* 忽略坏数据 */ }
  }
  return n
}

export interface ScanStats { files: number; ingested: number; added: number }

export function scanAll(): ScanStats {
  let files = 0, ingested = 0, added = 0
  for (const { path: root, agent } of loadRoots()) {
    for (const path of walk(root)) {
      files++
      const n = ingestFile(path, agent)
      if (n > 0) { ingested++; added += n }
    }
  }
  backfillAllTitles()
  backfillTps()
  return { files, ingested, added }
}

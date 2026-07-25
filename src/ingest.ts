import { openSync, readSync, fstatSync, closeSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentType, ParseResult } from './model.js'
import { createPiParser } from './parsers/pi.js'
import { createClaudeParser } from './parsers/claude.js'
import { createCodexParser } from './parsers/codex.js'
import { appendMessage, readSource, saveSessionMeta, saveSource, setCumulativeUsage, db } from './db.js'

const HOME = homedir()

export const SOURCES: { agent: AgentType; roots: string[] }[] = [
  { agent: 'pi', roots: [join(HOME, '.pi/agent/sessions')] },
  { agent: 'claude', roots: [join(HOME, '.claude/projects')] },
  { agent: 'codex', roots: [join(HOME, '.codex/sessions'), join(HOME, '.codex/archived_sessions')] },
]

const parserFactories = {
  pi: createPiParser,
  claude: createClaudeParser,
  codex: createCodexParser,
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
export function ingestFile(path: string, agent: AgentType): number {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const prev = readSource(path)
    const offset = prev && prev.offset <= size ? prev.offset : 0
    if (offset === size) return 0

    const buf = Buffer.alloc(size - offset)
    readSync(fd, buf, 0, buf.length, offset)
    const chunk = buf.toString('utf8')
    const lastNl = chunk.lastIndexOf('\n')
    if (lastNl < 0) return 0 // 还没有完整行，下次再读

    const complete = chunk.slice(0, lastNl)
    const newOffset = offset + Buffer.byteLength(complete) + 1

    const parseLine = parserFactories[agent]()
    let sessionPk: string | null = prev ? `${agent}:${prev.session_id}` : null
    let msgCount = prev?.msg_count ?? 0
    let added = 0

    for (const raw of complete.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      let obj: any
      try { obj = JSON.parse(line) } catch { continue }

      let result: ParseResult | null
      try { result = parseLine(obj) } catch { continue }
      if (!result) continue

      if (result.meta) {
        sessionPk = saveSessionMeta(agent, result.meta)
      }
      if (result.message) {
        if (!sessionPk) continue // 还没见到 session 元信息，跳过
        if (appendMessage(sessionPk, msgCount, result.message)) {
          msgCount++
          added++
        }
      }
      if (result.sessionUsage && sessionPk) {
        setCumulativeUsage(sessionPk, result.sessionUsage)
      }
    }

    // 文件可能还没写出 session 行（极小概率），此时 session_id 用文件名兜底存不了，直接等下轮
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
  WHERE session_id = ? AND role = 'user' ORDER BY seq LIMIT 1
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
  for (const { agent, roots } of SOURCES) {
    for (const root of roots) {
      for (const path of walk(root)) {
        files++
        const n = ingestFile(path, agent)
        if (n > 0) { ingested++; added += n }
      }
    }
  }
  backfillAllTitles()
  return { files, ingested, added }
}

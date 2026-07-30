import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

// 复盘沉淀：把 findings 里的教训写回 agent 的"记忆"
// - instructions: 项目级 CLAUDE.md（claude）/ AGENTS.md（pi/codex），标记块幂等更新
// - skill: 按项目累积的 lessons skill（pi → ~/.pi/agent/skills/，claude → ~/.claude/skills/）

export type PersistMode = 'none' | 'instructions' | 'skill'

interface Lesson { detail: string; evidence?: string }

const START = '<!-- spectator:lessons:start -->'
const END = '<!-- spectator:lessons:end -->'
const MAX_ENTRIES = 20 // 标记块里最多保留的教训条数，防无限膨胀

// 从 findings 提取值得沉淀的教训（lesson + 从失败模式里学的）
export function extractLessons(findings: { type: string; detail: string; evidence?: string }[]): Lesson[] {
  return findings
    .filter((f) => ['lesson', 'rework', 'correction', 'misunderstanding'].includes(f.type))
    .map((f) => ({ detail: f.detail, evidence: f.evidence }))
}

function renderBlock(entries: string[]): string {
  return [
    START,
    '',
    '## 历史教训（spectator 复盘沉淀）',
    '',
    ...entries,
    '',
    END,
  ].join('\n')
}

function upsertBlock(filePath: string, newEntries: string[]): void {
  let entries: string[] = []
  let content = ''
  if (existsSync(filePath)) {
    content = readFileSync(filePath, 'utf8')
    const m = content.match(new RegExp(`${START}([\\s\\S]*?)${END}`))
    if (m) {
      entries = m[1].split('\n').filter((l) => l.startsWith('- ['))
      content = content.replace(new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`), '\n___SPECTATOR_BLOCK___\n')
    }
  }
  entries = [...newEntries, ...entries].slice(0, MAX_ENTRIES)
  const block = renderBlock(entries)
  content = content.includes('___SPECTATOR_BLOCK___')
    ? content.replace('___SPECTATOR_BLOCK___', block)
    : content.trimEnd() + '\n\n' + block + '\n'
  writeFileSync(filePath, content)
}

// 写入项目指令文件：claude → CLAUDE.md，pi/codex → AGENTS.md
export function persistToInstructions(projectPath: string, agent: string, sessionTitle: string, lessons: Lesson[]): string {
  const fileName = agent === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'
  const filePath = join(projectPath, fileName)
  const date = new Date().toISOString().slice(0, 10)
  const entries = lessons.map((l) => `- [${date} · ${sessionTitle.slice(0, 30)}] ${l.detail}`)
  upsertBlock(filePath, entries)
  return filePath
}

// 沉淀为按项目累积的 skill（codex 无 skill 机制，回落到指令文件）
export function persistToSkill(agent: string, projectPath: string, sessionTitle: string, lessons: Lesson[]): string {
  const HOME = homedir()
  const proj = basename(projectPath).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
  const skillName = `lessons-${proj}`

  const dir = agent === 'claude'
    ? join(HOME, '.claude/skills', skillName)
    : agent === 'pi'
      ? join(HOME, '.pi/agent/skills', skillName)
      : null

  if (!dir) {
    // codex 没有 skill 体系，写回 AGENTS.md
    return persistToInstructions(projectPath, agent, sessionTitle, lessons)
  }

  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'SKILL.md')
  const date = new Date().toISOString().slice(0, 10)
  const entries = lessons.map((l) => `- [${date} · ${sessionTitle.slice(0, 30)}] ${l.detail}`)

  if (!existsSync(filePath)) {
    writeFileSync(filePath, `---
name: ${skillName}
description: 项目 ${proj} 的历史教训（spectator 复盘自动沉淀）。在这个项目干活前先读。
---

# ${proj} 项目教训

${renderBlock(entries)}
`)
  } else {
    upsertBlock(filePath, entries)
  }
  return filePath
}

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
  writeFileSync(filePath, computeUpsertedContent(filePath, newEntries))
}

// 纯函数：计算 upsert 后的完整文件内容（plan 预览 / 确认写盘共用）
function computeUpsertedContent(filePath: string, newEntries: string[]): string {
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
  return content.includes('___SPECTATOR_BLOCK___')
    ? content.replace('___SPECTATOR_BLOCK___', block)
    : content.trimEnd() + '\n\n' + block + '\n'
}

// 指令文件路径推导（单一来源：写盘与备份共用）
export function instructionsFilePath(projectPath: string, agent: string): string {
  return join(projectPath, agent === 'claude' ? 'CLAUDE.md' : 'AGENTS.md')
}

// 写入项目指令文件：claude → CLAUDE.md，pi/codex → AGENTS.md
export function persistToInstructions(projectPath: string, agent: string, sessionTitle: string, lessons: Lesson[]): string {
  const filePath = instructionsFilePath(projectPath, agent)
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

// ---- 两阶段沉淀：plan 只生成预览不写盘，confirm 时才真正写入 ----

export interface PersistPlan {
  kind: 'instructions' | 'skill'
  filePath: string
  content: string   // 将新增的条目文本（新 skill 文件则为完整内容）
}

function renderEntries(sessionTitle: string, lessons: Lesson[]): string[] {
  const date = new Date().toISOString().slice(0, 10)
  return lessons.map((l) => `- [${date} · ${sessionTitle.slice(0, 30)}] ${l.detail}`)
}

function skillPathFor(agent: string, projectPath: string): { dir: string | null; skillName: string } {
  const proj = basename(projectPath).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
  const skillName = `lessons-${proj}`
  const HOME = homedir()
  const dir = agent === 'claude'
    ? join(HOME, '.claude/skills', skillName)
    : agent === 'pi'
      ? join(HOME, '.pi/agent/skills', skillName)
      : null
  return { dir, skillName }
}

// 生成沉淀计划（不写盘）：预览将写入的目标文件和内容
export function planPersist(mode: PersistMode, agent: string, projectPath: string, sessionTitle: string, lessons: Lesson[]): PersistPlan | null {
  if (mode === 'none' || lessons.length === 0) return null
  const entries = renderEntries(sessionTitle, lessons)

  if (mode === 'skill') {
    const { dir, skillName } = skillPathFor(agent, projectPath)
    if (dir) {
      const filePath = join(dir, 'SKILL.md')
      if (!existsSync(filePath)) {
        // 新 skill：预览完整文件
        return {
          kind: 'skill',
          filePath,
          content: `---
name: ${skillName}
description: 项目 ${basename(projectPath)} 的历史教训（spectator 复盘自动沉淀）。在这个项目干活前先读。
---

# ${basename(projectPath)} 项目教训

${renderBlock(entries)}
`,
        }
      }
      return { kind: 'skill', filePath, content: entries.join('\n') }
    }
    // codex 无 skill 体系，回落 instructions
  }

  const filePath = join(projectPath, agent === 'claude' ? 'CLAUDE.md' : 'AGENTS.md')
  return { kind: 'instructions', filePath, content: entries.join('\n') }
}

// 确认执行：把计划的内容真正写盘（content 里每行 "- [..." 是一条新教训；新 skill 是完整文件）
export function applyPersistPlan(plan: PersistPlan): void {
  if (plan.kind === 'skill' && plan.content.startsWith('---')) {
    mkdirSync(join(plan.filePath, '..'), { recursive: true })
    writeFileSync(plan.filePath, plan.content)
    return
  }
  const entries = plan.content.split('\n').filter((l) => l.startsWith('- ['))
  upsertBlock(plan.filePath, entries)
}

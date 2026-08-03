// 会话导出 Markdown：frontmatter 元数据 + 按时间流渲染消息
import type { Block } from './model.js'

const ROLE_LABEL: Record<string, string> = { user: '用户', assistant: '助手', tool: '工具', system: '系统' }
const MAX_OUTPUT = 2000

// title 清洗：去换行/回车，frontmatter 用 JSON.stringify（合法 YAML flow scalar）
function sanitizeTitle(t: string | null | undefined): string {
  return (t ?? '(空会话)').replace(/[\r\n]+/g, ' ').trim()
}

// 内容含 ``` 时围栏断裂：用比内容最长反引号串多一个的围栏
function fenceFor(content: string): string {
  const runs = content.match(/`+/g) ?? []
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 2)
  return '`'.repeat(longest + 1)
}

function renderBlock(b: Block): string {
  if (b.type === 'text') return b.text ?? ''
  if (b.type === 'thinking') {
    const lines = (b.text ?? '').slice(0, 500).split('\n')
    return lines.map((l) => `> 💭 ${l}`.trimEnd()).join('\n')
  }
  if (b.type === 'tool_call') {
    const inp = typeof b.input === 'string' ? b.input : JSON.stringify(b.input, null, 2)
    const f = fenceFor(inp)
    return `${f}tool:${b.name ?? 'unknown'}\n${inp}\n${f}`
  }
  if (b.type === 'tool_result') {
    const out = (b.output ?? '').slice(0, MAX_OUTPUT)
    const truncated = (b.output ?? '').length > MAX_OUTPUT ? '\n…（截断）' : ''
    const f = fenceFor(out)
    return `${f}output${b.isError ? ':error' : ''}\n${out}${truncated}\n${f}`
  }
  return ''
}

export function renderMarkdown(session: any, messages: any[]): string {
  const title = sanitizeTitle(session.title)
  const fm = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `agent: ${session.agent}`,
    `project: ${JSON.stringify(session.project_path ?? '')}`,
    `model: ${session.model ?? ''}`,
    `started_at: ${session.started_at ?? ''}`,
    `ended_at: ${session.ended_at ?? ''}`,
    `message_count: ${session.message_count}`,
    `input_tokens: ${session.input_tokens ?? 0}`,
    `output_tokens: ${session.output_tokens ?? 0}`,
    '---',
    '',
    `# ${title}`,
    '',
  ]
  const body: string[] = []
  for (const m of messages) {
    const blocks = JSON.parse(m.blocks_json) as Block[]
    const time = m.ts ? new Date(m.ts).toTimeString().slice(0, 8) : '--:--:--'
    body.push(`## [${time}] ${ROLE_LABEL[m.role] ?? m.role}`)
    body.push('')
    for (const b of blocks) {
      const rendered = renderBlock(b).trimEnd()
      if (rendered) { body.push(rendered); body.push('') }
    }
  }
  return fm.join('\n') + '\n' + body.join('\n')
}

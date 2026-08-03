// 会话导出 Markdown：frontmatter 元数据 + 按时间流渲染消息
import type { Block } from './model.js'

const ROLE_LABEL: Record<string, string> = { user: '用户', assistant: '助手', tool: '工具', system: '系统' }
const MAX_OUTPUT = 2000

function renderBlock(b: Block): string {
  if (b.type === 'text') return b.text ?? ''
  if (b.type === 'thinking') return `> 💭 ${(b.text ?? '').slice(0, 500)}`
  if (b.type === 'tool_call') {
    const inp = typeof b.input === 'string' ? b.input : JSON.stringify(b.input, null, 2)
    return `\`\`\`tool:${b.name ?? 'unknown'}\n${inp}\n\`\`\``
  }
  if (b.type === 'tool_result') {
    const out = (b.output ?? '').slice(0, MAX_OUTPUT)
    const truncated = (b.output ?? '').length > MAX_OUTPUT ? '\n…（截断）' : ''
    return `\`\`\`output${b.isError ? ':error' : ''}\n${out}${truncated}\n\`\`\``
  }
  return ''
}

export function renderMarkdown(session: any, messages: any[]): string {
  const fm = [
    '---',
    `title: ${(session.title ?? '(空会话)').replace(/\n/g, ' ')}`,
    `agent: ${session.agent}`,
    `project: ${session.project_path ?? ''}`,
    `model: ${session.model ?? ''}`,
    `started_at: ${session.started_at ?? ''}`,
    `ended_at: ${session.ended_at ?? ''}`,
    `message_count: ${session.message_count}`,
    `input_tokens: ${session.input_tokens ?? 0}`,
    `output_tokens: ${session.output_tokens ?? 0}`,
    '---',
    '',
    `# ${session.title ?? '(空会话)'}`,
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
  return fm.join('\n') + body.join('\n')
}

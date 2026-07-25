import type { Block, ParseResult } from '../model.js'

// Claude Code session 文件: ~/.claude/projects/<project>/<sessionId>.jsonl
// 每条事件都带 sessionId/cwd/uuid/parentUuid/timestamp
// message.content: string | [{type: text|thinking|tool_use|tool_result, ...}]

export function createClaudeParser() {
  let metaEmitted = false

  return function parseLine(line: any): ParseResult | null {
    if (line?.type === 'ai-title' && line.sessionId) {
      return { meta: { sessionId: line.sessionId, title: line.aiTitle } }
    }

    if (line?.type !== 'user' && line?.type !== 'assistant') return null
    const msg = line.message
    if (!msg) return null

    const meta = !metaEmitted && line.sessionId
      ? { sessionId: line.sessionId as string, projectPath: line.cwd as string | undefined, startedAt: line.timestamp as string | undefined }
      : undefined
    if (meta) metaEmitted = true

    const content = msg.content
    const blocks: Block[] = []

    if (typeof content === 'string') {
      if (content.trim()) blocks.push({ type: 'text', text: content })
    } else if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === 'text' && c.text) blocks.push({ type: 'text', text: c.text })
        else if (c.type === 'thinking' && c.thinking) blocks.push({ type: 'thinking', text: c.thinking })
        else if (c.type === 'tool_use') {
          blocks.push({ type: 'tool_call', name: c.name, input: c.input, toolCallId: c.id })
        } else if (c.type === 'tool_result') {
          const output = typeof c.content === 'string'
            ? c.content
            : Array.isArray(c.content)
              ? c.content.map((x: any) => x?.text ?? '').filter(Boolean).join('\n')
              : ''
          blocks.push({ type: 'tool_result', toolCallId: c.tool_use_id, output, isError: !!c.is_error })
        }
      }
    }
    if (blocks.length === 0) return meta ? { meta } : null

    // 整条都是 tool_result 的 user 事件，归入 tool 角色，方便按对话流展示
    const role = line.type === 'assistant'
      ? 'assistant'
      : blocks.every((b) => b.type === 'tool_result') ? 'tool' : 'user'

    const u = msg.usage
    return {
      meta,
      message: {
        eventId: line.uuid,
        parentId: line.parentUuid,
        role,
        ts: line.timestamp ?? new Date().toISOString(),
        blocks,
        model: msg.model,
        usage: u ? {
          input: u.input_tokens,
          output: u.output_tokens,
          cacheRead: u.cache_read_input_tokens,
          cacheCreation: u.cache_creation_input_tokens,
        } : undefined,
      },
    }
  }
}

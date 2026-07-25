import type { Block, ParseResult } from '../model.js'

// pi session 文件: ~/.pi/agent/sessions/<project>/<ts>_<uuid>.jsonl
// 首行 {"type":"session", id, cwd, timestamp}
// 消息行 {"type":"message", id, parentId, timestamp, message:{role, content[]}}

interface PiContent {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: unknown
}

export function createPiParser() {
  let sessionId: string | null = null

  return function parseLine(line: any): ParseResult | null {
    if (line?.type === 'session') {
      sessionId = line.id
      return {
        meta: {
          sessionId: line.id,
          projectPath: line.cwd,
          startedAt: line.timestamp,
        },
      }
    }

    if (line?.type === 'model_change' && sessionId) {
      return { meta: { sessionId, model: `${line.provider}/${line.modelId}` } }
    }

    if (line?.type !== 'message' || !line.message) return null

    const msg = line.message
    const ts = line.timestamp ?? msg.timestamp ?? new Date().toISOString()
    const content: PiContent[] = Array.isArray(msg.content) ? msg.content : []

    if (msg.role === 'toolResult') {
      const output = content.map((c) => c.text ?? '').filter(Boolean).join('\n')
      return {
        message: {
          eventId: line.id,
          parentId: line.parentId,
          role: 'tool',
          ts,
          blocks: [{
            type: 'tool_result',
            name: msg.toolName,
            toolCallId: msg.toolCallId,
            output,
            isError: !!msg.isError,
          }],
        },
      }
    }

    const blocks: Block[] = []
    for (const c of content) {
      if (c.type === 'text' && c.text) blocks.push({ type: 'text', text: c.text })
      else if (c.type === 'thinking' && c.thinking) blocks.push({ type: 'thinking', text: c.thinking })
      else if (c.type === 'toolCall') {
        blocks.push({ type: 'tool_call', name: c.name, input: c.arguments, toolCallId: c.id })
      }
    }
    if (blocks.length === 0) return null

    return {
      message: {
        eventId: line.id,
        parentId: line.parentId,
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        ts,
        blocks,
      },
    }
  }
}

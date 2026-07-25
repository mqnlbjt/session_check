import type { ParseResult, ParserContext } from '../model.js'

// Codex session 文件: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 及 archived_sessions/
// 行结构: {timestamp, type, payload}
//   session_meta: {id, cwd, timestamp}
//   response_item: message | function_call | function_call_output | reasoning
//   event_msg: token_count 等（user_message 与 response_item 重复，忽略）

export function createCodexParser(_ctx: ParserContext) {
  let sessionId: string | null = null

  return function parseLine(line: any): ParseResult | null {
    const ts = line?.timestamp ?? new Date().toISOString()

    if (line?.type === 'session_meta') {
      sessionId = line.payload?.id ?? null
      if (!sessionId) return null
      return {
        meta: {
          sessionId,
          projectPath: line.payload.cwd,
          startedAt: line.payload.timestamp ?? ts,
        },
      }
    }

    if (line?.type === 'event_msg' && line.payload?.type === 'token_count' && sessionId) {
      const u = line.payload.info?.total_token_usage
      if (!u) return null
      return {
        sessionUsage: {
          input: u.input_tokens,
          output: u.output_tokens,
          cacheRead: u.cached_input_tokens,
        },
      }
    }

    if (line?.type !== 'response_item') return null
    const p = line.payload
    if (!p) return null

    if (p.type === 'message') {
      const texts = (Array.isArray(p.content) ? p.content : [])
        .filter((c: any) => typeof c?.text === 'string')
        .map((c: any) => c.text as string)
      if (texts.length === 0) return null
      const role = p.role === 'assistant' ? 'assistant' : p.role === 'user' ? 'user' : 'system'
      // codex 的 environment_context 是注入的系统信息，降格为 system
      const isEnvCtx = role === 'user' && texts[0]?.startsWith('<environment_context>')
      return {
        message: {
          role: isEnvCtx ? 'system' : role,
          ts,
          blocks: [{ type: 'text', text: texts.join('\n') }],
        },
      }
    }

    if (p.type === 'function_call') {
      return {
        message: {
          role: 'assistant',
          ts,
          blocks: [{ type: 'tool_call', name: p.name, input: safeJson(p.arguments), toolCallId: p.call_id }],
        },
      }
    }

    if (p.type === 'function_call_output') {
      const output = typeof p.output === 'string' ? p.output : JSON.stringify(p.output)
      return {
        message: {
          role: 'tool',
          ts,
          blocks: [{ type: 'tool_result', toolCallId: p.call_id, output }],
        },
      }
    }

    if (p.type === 'reasoning') {
      const text = (Array.isArray(p.summary) ? p.summary : [])
        .map((s: any) => s?.text ?? '')
        .filter(Boolean)
        .join('\n')
      if (!text) return null
      return {
        message: { role: 'assistant', ts, blocks: [{ type: 'thinking', text }] },
      }
    }

    return null
  }
}

function safeJson(s: unknown): unknown {
  if (typeof s !== 'string') return s
  try { return JSON.parse(s) } catch { return s }
}

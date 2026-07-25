import type { Block, ParseResult, ParserContext } from '../model.js'

// Claude Code session 文件: ~/.claude/projects/<project>/<sessionId>.jsonl
// 子 agent 转写: ~/.claude/projects/<project>/<sessionId>/subagents/agent-<fid>.jsonl
//   子 agent 文件与父会话共享 sessionId，必须拆成独立会话并通过 parentSessionId 关联
// 每条事件都带 sessionId/cwd/uuid/parentUuid/timestamp
// message.content: string | [{type: text|thinking|tool_use|tool_result, ...}]

export function createClaudeParser(ctx: ParserContext) {
  let metaEmitted = false
  let lastModel: string | null = null

  // 从路径识别 subagent 文件，提取文件级 id 拼进会话 key
  const subMatch = ctx.filePath.match(/\/subagents\/agent-([a-z0-9]+)\.jsonl$/)
  const subFileId = subMatch?.[1] ?? null

  const remap = (sessionId: string) => subFileId ? `${sessionId}:sub:${subFileId}` : sessionId

  return function parseLine(line: any): ParseResult | null {
    if (line?.type === 'ai-title' && line.sessionId) {
      // 标题只归到主会话
      if (subFileId) return null
      return { meta: { sessionId: line.sessionId, title: line.aiTitle } }
    }

    if (line?.type !== 'user' && line?.type !== 'assistant') return null
    const msg = line.message
    if (!msg) return null

    // 模型变化时上报（'<synthetic>' 是 Claude Code 合成的假消息，不算）
    let modelMeta: ParseResult['meta']
    if (line.type === 'assistant' && line.sessionId
      && msg.model && msg.model !== '<synthetic>' && msg.model !== lastModel) {
      lastModel = msg.model
      modelMeta = { sessionId: remap(line.sessionId), model: msg.model }
    }

    const meta = !metaEmitted && line.sessionId
      ? {
          sessionId: remap(line.sessionId as string),
          parentSessionId: subFileId ? (line.sessionId as string) : undefined,
          projectPath: line.cwd as string | undefined,
          startedAt: line.timestamp as string | undefined,
          model: modelMeta?.model,
        }
      : modelMeta
    if (meta && !metaEmitted) metaEmitted = true

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

// 统一数据模型：三家 agent 的 session 文件都归一化成这套结构

export type AgentType = 'pi' | 'claude' | 'codex'

export type Role = 'user' | 'assistant' | 'tool' | 'system'

export interface Block {
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result'
  text?: string
  // tool_call
  name?: string
  input?: unknown
  toolCallId?: string
  // tool_result
  output?: string
  isError?: boolean
}

export interface Usage {
  input?: number
  output?: number
  cacheRead?: number
  cacheCreation?: number
}

export interface NormalizedMessage {
  eventId?: string
  parentId?: string
  role: Role
  ts: string
  blocks: Block[]
  model?: string
  usage?: Usage
}

// parser 处理单行后的产出
export interface ParseResult {
  meta?: {
    sessionId: string
    projectPath?: string
    startedAt?: string
    title?: string
    model?: string
  }
  message?: NormalizedMessage
  // codex 的 token_count 这类只更新 session 级统计
  sessionUsage?: Usage
}

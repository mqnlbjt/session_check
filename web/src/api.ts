export interface SessionRow {
  id: string
  agent: 'pi' | 'claude' | 'codex'
  parent_id: string | null
  project_path: string | null
  title: string | null
  model: string | null
  started_at: string | null
  ended_at: string | null
  message_count: number
  input_tokens: number
  output_tokens: number
  subagent_count: number
  error_count?: number
  risk_count?: number
  spark?: number[]
  avg_tps?: number | null
}

export interface Risk {
  rule: string
  severity: 'high' | 'medium'
  snippet: string | null
  ts: string
}

export interface Block {
  type: 'text' | 'thinking' | 'tool_call' | 'tool_result'
  text?: string
  name?: string
  input?: unknown
  output?: string
  toolCallId?: string
  isError?: boolean
}

export interface Message {
  seq: number
  event_id: string | null
  role: 'user' | 'assistant' | 'tool' | 'system'
  ts: string
  blocks: Block[]
  model: string | null
  usage: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number } | null
  tps?: number
}

export interface Stats {
  byAgent: { agent: string; sessions: number; messages: number; input_tokens: number; output_tokens: number }[]
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

export const api = {
  sessions: (params: { agent?: string; q?: string; parent?: string; limit?: number; offset?: number }) => {
    const sp = new URLSearchParams()
    if (params.agent) sp.set('agent', params.agent)
    if (params.q) sp.set('q', params.q)
    if (params.parent) sp.set('parent', params.parent)
    sp.set('limit', String(params.limit ?? 50))
    sp.set('offset', String(params.offset ?? 0))
    return get<{ total: number; rows: SessionRow[] }>(`/api/sessions?${sp}`)
  },
  messages: (id: string, limit = 2000) =>
    get<{ session: SessionRow; messages: Message[] }>(`/api/sessions/${encodeURIComponent(id)}/messages?limit=${limit}`),
  stats: () => get<Stats>('/api/stats'),
}

export function fmtTokens(n: number): string {
  if (!n) return '0'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

export function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toTimeString().slice(0, 8)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toTimeString().slice(0, 5)}`
}

export function fmtClock(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 8)
}

// FTS 搜索测试：fixture 消息 → /api/search 断言
import { beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'

process.env.SPECTATOR_DB = ':memory:'

let app: Hono
let dbmod: typeof import('../src/db.js')

beforeAll(async () => {
  dbmod = await import('../src/db.js')
  app = (await import('../src/server.js')).app

  // fixture：一个会话，四种 block 类型各来一条
  const pk = dbmod.saveSessionMeta('pi', {
    sessionId: 'test-s1',
    projectPath: '/data/demo-project',
    startedAt: '2026-07-30T10:00:00Z',
    title: 'lease 机制讨论',
  })
  dbmod.appendMessage(pk, 1, {
    role: 'user', ts: '2026-07-30T10:00:01Z',
    blocks: [{ type: 'text', text: '我们来讨论 lease 机制的设计，先看全貌' }],
  })
  dbmod.appendMessage(pk, 2, {
    role: 'assistant', ts: '2026-07-30T10:00:05Z',
    blocks: [
      { type: 'thinking', text: 'thinking 内容不应被索引 thinkingonly' },
      { type: 'text', text: '好的，lease 是分布式租约，heartbeat 保活' },
    ],
  })
  dbmod.appendMessage(pk, 3, {
    role: 'assistant', ts: '2026-07-30T10:00:09Z',
    blocks: [{ type: 'tool_call', name: 'bash', input: { command: 'git commit -m fixlease' } }],
  })
  dbmod.appendMessage(pk, 4, {
    role: 'tool', ts: '2026-07-30T10:00:10Z',
    blocks: [{ type: 'tool_result', output: 'secret-output-xyznotindexed', toolCallId: '1' }],
  })
})

async function search(q: string, extra = '') {
  const res = await app.request(`/api/search?q=${encodeURIComponent(q)}${extra}`)
  expect(res.status).toBe(200)
  return res.json() as Promise<{ total: number; rows: any[] }>
}

describe('FTS 全文搜索', () => {
  it('英文关键词命中 user/assistant 文本', async () => {
    const r = await search('lease')
    expect(r.total).toBe(3) // user 文本 + assistant 文本 + tool_call input
  })

  it('中文关键词（≥3 字）命中', async () => {
    const r = await search('分布式租')
    expect(r.total).toBe(1)
    expect(r.rows[0].role).toBe('assistant')
  })

  it('tool_call 入参可搜（命令）', async () => {
    const r = await search('fixlease')
    expect(r.total).toBe(1)
    expect(r.rows[0].seq).toBe(3)
  })

  it('tool_result 输出不索引', async () => {
    const r = await search('xyznotindexed')
    expect(r.total).toBe(0)
  })

  it('thinking 不索引', async () => {
    const r = await search('thinkingonly')
    expect(r.total).toBe(0)
  })

  it('短查询（2 字中文）走降级也能搜到', async () => {
    const r = await search('讨论')
    expect(r.total).toBeGreaterThanOrEqual(1)
  })

  it('结果带高亮片段和会话信息', async () => {
    const r = await search('lease')
    const row = r.rows[0]
    expect(row.snippet).toContain('<mark>')
    expect(row.session_title).toContain('lease')
    expect(row.agent).toBe('pi')
    expect(row.project_path).toBe('/data/demo-project')
  })

  it('agent 过滤生效', async () => {
    const r = await search('lease', '&agent=claude')
    expect(r.total).toBe(0)
  })

  it('project 过滤生效', async () => {
    const r = await search('lease', '&project=nosuchproject')
    expect(r.total).toBe(0)
  })
})

describe('FTS 回填', () => {
  it('回填幂等：跑两次行数不变', async () => {
    const n1 = dbmod.backfillFts()
    const n2 = dbmod.backfillFts()
    expect(n1).toBe(0) // 第一次 ingest 已同步写入，无待回填
    expect(n2).toBe(0)
    const c = dbmod.db.prepare('SELECT COUNT(*) n FROM messages_fts').get() as any
    expect(c.n).toBe(4) // 3 条有文本 + 1 条 tool_result 占位行（tombstone 保证幂等）
  })
})

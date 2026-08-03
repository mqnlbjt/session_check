// 返工信号检测测试：user 纠正/挫折语句 → signals 落库 → API 聚合
import { beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'

process.env.SPECTATOR_DB = ':memory:'

let app: Hono
let dbmod: typeof import('../src/db.js')

beforeAll(async () => {
  dbmod = await import('../src/db.js')
  app = (await import('../src/server.js')).app

  const pk = dbmod.saveSessionMeta('pi', {
    sessionId: 'sig-s1', projectPath: '/data/proj', startedAt: '2026-07-30T10:00:00Z', title: '信号测试会话',
  })
  // 纠正类：不对、重来
  dbmod.appendMessage(pk, 1, { role: 'user', ts: '2026-07-30T10:00:01Z', blocks: [{ type: 'text', text: '不对，我要的是另一个方案' }] })
  // assistant 说"不对"不触发
  dbmod.appendMessage(pk, 2, { role: 'assistant', ts: '2026-07-30T10:00:02Z', blocks: [{ type: 'text', text: '你说得对，那样不对，我重来' }] })
  // 纠正类：重来（user）
  dbmod.appendMessage(pk, 3, { role: 'user', ts: '2026-07-30T10:00:03Z', blocks: [{ type: 'text', text: '重来，从第一步开始' }] })
  // 挫折类：怎么又（不计入 correction_count）
  dbmod.appendMessage(pk, 4, { role: 'user', ts: '2026-07-30T10:00:04Z', blocks: [{ type: 'text', text: '怎么又挂了' }] })
  // 正常消息
  dbmod.appendMessage(pk, 5, { role: 'user', ts: '2026-07-30T10:00:05Z', blocks: [{ type: 'text', text: '好的继续' }] })
  // tool 消息含"不对"不触发
  dbmod.appendMessage(pk, 6, { role: 'tool', ts: '2026-07-30T10:00:06Z', blocks: [{ type: 'tool_result', output: 'error: 路径不对', toolCallId: '1' }] })
  // 机器生成的 user 消息（subagent 任务书）含纠正词不触发
  dbmod.appendMessage(pk, 7, { role: 'user', ts: '2026-07-30T10:00:07Z', blocks: [{ type: 'text', text: 'Task: You are a delegated subagent. 复核结论，不对的地方指出来，必要时回退' }] })
})

describe('返工信号检测', () => {
  it('user 纠正语句落 signals（correction）', () => {
    const rows = dbmod.db.prepare(`SELECT * FROM signals WHERE kind = 'correction'`).all() as any[]
    expect(rows.length).toBe(2) // seq 1 和 3
    expect(rows[0].rule).toBeTruthy()
    expect(rows[0].snippet.length).toBeGreaterThan(0)
  })

  it('挫折语句落 signals（frustration），不计入 correction', () => {
    const rows = dbmod.db.prepare(`SELECT * FROM signals WHERE kind = 'frustration'`).all() as any[]
    expect(rows.length).toBe(1) // seq 4
  })

  it('assistant/tool 消息不触发', () => {
    const n = dbmod.db.prepare(`SELECT COUNT(*) n FROM signals`).get() as any
    expect(n.n).toBe(3) // 总共只有 3 条
  })

  it('/api/sessions 带 correction_count', async () => {
    const res = await app.request('/api/sessions')
    const body = await res.json()
    expect(body.rows[0].correction_count).toBe(2)
  })

  it('/api/sessions/:id/signals 返回明细', async () => {
    const res = await app.request('/api/sessions/pi:sig-s1/signals')
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows.length).toBe(3)
    expect(rows[0]).toHaveProperty('seq')
    expect(rows[0]).toHaveProperty('kind')
    expect(rows[0]).toHaveProperty('rule')
    expect(rows[0]).toHaveProperty('snippet')
  })

  it('回填幂等', () => {
    const n1 = dbmod.backfillSignals()
    const n2 = dbmod.backfillSignals()
    expect(n1).toBe(3)
    expect(n2).toBe(3)
    const c = dbmod.db.prepare('SELECT COUNT(*) n FROM signals').get() as any
    expect(c.n).toBe(3)
  })
})

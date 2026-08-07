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

// ---- 期6 #12：误报治理 ----
describe('信号误报治理（#12 P3）', () => {
  it('第一人称纠错（我搞错/我的错）不算 correction', async () => {
    const { scanSignals } = await import('../src/signal-rules.js')
    expect(scanSignals('是我搞错了，你说得对')).toEqual([])
    expect(scanSignals('我的错，之前理解偏了')).toEqual([])
    expect(scanSignals('那个型号说错了 是另一款，我记错了')).toEqual([])
    // 纠正 agent 的仍然算
    expect(scanSignals('你搞错了，不是这个文件').some((h) => h.kind === 'correction')).toBe(true)
  })

  it('subagent 任务书模板（你是…专家）不触发', async () => {
    const { scanSignals } = await import('../src/signal-rules.js')
    const task = '你是资深后端服务专家，请审查以下代码，把不对的地方指出来并修复'
    expect(scanSignals(task)).toEqual([])
  })
})

describe('snippet 匹配点上下文（#12 P2）', () => {
  it('长消息的 snippet 截取匹配点前后各 40 字符，而非消息开头', async () => {
    const { scanSignals } = await import('../src/signal-rules.js')
    const head = '我们先讨论一下整体架构和模块划分的事情'.repeat(6) // 108 字铺垫
    const text = head + '这个地方不对，应该走另一条路' + '后续还有一些补充说明'.repeat(6)
    const hit = scanSignals(text).find((h) => h.rule === 'wrong')
    expect(hit).toBeTruthy()
    expect(hit!.snippet).toContain('不对')
    expect(hit!.snippet.startsWith('我们先讨论')).toBe(false) // 不是从开头截
    expect(hit!.snippet.length).toBeLessThanOrEqual(100)
  })

  it('短消息 snippet 保持完整', async () => {
    const { scanSignals } = await import('../src/signal-rules.js')
    const hit = scanSignals('不对，你改错文件了').find((h) => h.rule === 'wrong')
    expect(hit!.snippet).toBe('不对，你改错文件了')
  })
})

describe('第一人称排除扩展（#12 P3 review 补强）', () => {
  it('第一人称认错时所有 correction 规则都不记', async () => {
    const { scanSignals } = await import('../src/signal-rules.js')
    // 用户自己认错 + 要求重来：不是 agent 的锅，correction 全不记
    expect(scanSignals('我搞错了，重来一遍吧').filter((h) => h.kind === 'correction')).toEqual([])
  })
})

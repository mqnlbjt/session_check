// 根因分类体系测试（#14）：封闭枚举配置 + LLM 分类器（注入假实现）
import { beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'

process.env.SPECTATOR_DB = ':memory:'

let app: Hono
let dbmod: typeof import('../src/db.js')
let rc: typeof import('../src/root-causes.js')

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

beforeAll(async () => {
  dbmod = await import('../src/db.js')
  app = (await import('../src/server.js')).app
  rc = await import('../src/root-causes.js')

  const pk = dbmod.saveSessionMeta('pi', { sessionId: 'rc-1', projectPath: '/data/rc', startedAt: daysAgo(5), title: 'RC', model: 'gpt-5.5' })
  dbmod.appendMessage(pk, 1, { role: 'assistant', ts: daysAgo(5), blocks: [{ type: 'tool_call', name: 'edit', input: {} }] })
  dbmod.appendMessage(pk, 2, { role: 'user', ts: daysAgo(5), blocks: [{ type: 'text', text: '谁让你改 README 的，我没让你动' }] })
  dbmod.appendMessage(pk, 3, { role: 'assistant', ts: daysAgo(5), blocks: [{ type: 'tool_call', name: 'bash', input: {} }] })
  dbmod.appendMessage(pk, 4, { role: 'user', ts: daysAgo(5), blocks: [{ type: 'text', text: '不对，你没跑测试就说改完了' }] })
})

const sigIds = () => dbmod.db.prepare(
  `SELECT sig.id FROM signals sig JOIN sessions s ON s.id = sig.session_id WHERE s.project_path = '/data/rc' ORDER BY sig.id`
).all() as { id: number }[]

describe('根因类别配置（数据驱动）', () => {
  it('封闭枚举：6+1 类，每类绑定验证检查项/搜索词/推荐物路由', () => {
    expect(rc.ROOT_CAUSES.length).toBeGreaterThanOrEqual(7)
    expect(rc.ROOT_CAUSES.some((c) => c.id === 'other')).toBe(true)
    for (const c of rc.ROOT_CAUSES) {
      expect(c.label.length).toBeGreaterThan(0)
      expect(Array.isArray(c.checks)).toBe(true)
      expect(Array.isArray(c.searchTerms)).toBe(true)
      if (c.id !== 'other') expect(['hook', 'skill', 'mcp']).toContain(c.route)
    }
  })
})

describe('LLM 根因分类器', () => {
  it('假 LLM 返回分类 → 信号落 root_cause', async () => {
    const ids = sigIds()
    const fakeLlm = async () => JSON.stringify([
      { id: ids[0].id, category: 'overreach', confidence: 0.9 },
      { id: ids[1].id, category: 'missing-verification', confidence: 0.8 },
    ])
    const r = await rc.classifyRootCauses('/data/rc', fakeLlm)
    expect(r.classified).toBe(2)
    const rows = dbmod.db.prepare(`SELECT root_cause, cause_confidence FROM signals ORDER BY id`).all() as any[]
    expect(rows[0].root_cause).toBe('overreach')
    expect(rows[1].root_cause).toBe('missing-verification')
  })

  it('LLM 返回非法类别 → 归入 other', async () => {
    dbmod.db.prepare(`UPDATE signals SET root_cause = NULL`).run()
    const ids = sigIds()
    const fakeLlm = async () => JSON.stringify([
      { id: ids[0].id, category: 'hallucinated-category', confidence: 0.5 },
      { id: ids[1].id, category: 'missing-verification', confidence: 0.8 },
    ])
    await rc.classifyRootCauses('/data/rc', fakeLlm)
    const row = dbmod.db.prepare(`SELECT root_cause FROM signals WHERE id = ?`).get(ids[0].id) as any
    expect(row.root_cause).toBe('other')
  })

  it('LLM 返回非 JSON → 不落库不炸', async () => {
    dbmod.db.prepare(`UPDATE signals SET root_cause = NULL`).run()
    const r = await rc.classifyRootCauses('/data/rc', async () => '我分类不出来')
    expect(r.classified).toBe(0)
    const n = dbmod.db.prepare(`SELECT COUNT(*) n FROM signals WHERE root_cause IS NOT NULL`).get() as any
    expect(n.n).toBe(0)
  })

  it('幂等：已分类的信号不重复送 LLM', async () => {
    dbmod.db.prepare(`UPDATE signals SET root_cause = 'overreach'`).run()
    let called = false
    await rc.classifyRootCauses('/data/rc', async () => { called = true; return '[]' })
    expect(called).toBe(false)
  })

  it('likely-noise 信号不参与分类', async () => {
    dbmod.db.prepare(`UPDATE signals SET root_cause = NULL, confirmation = 'likely-noise'`).run()
    let called = false
    await rc.classifyRootCauses('/data/rc', async () => { called = true; return '[]' })
    expect(called).toBe(false)
    dbmod.db.prepare(`UPDATE signals SET confirmation = 'confirmed'`).run()
  })
})

describe('分类 API', () => {
  it('POST /api/harness/classify 触发分类', async () => {
    dbmod.db.prepare(`UPDATE signals SET root_cause = NULL`).run()
    const res = await app.request('/api/harness/classify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_path: '/data/rc' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('started')
  })
})

describe('分类输入口径（#14 review 钉住）', () => {
  it('unconfirmed 与 NULL（未回填）信号也参与分类，仅 likely-noise 被排除', async () => {
    dbmod.db.prepare(`UPDATE signals SET root_cause = NULL, confirmation = 'unconfirmed'`).run()
    const r1 = await rc.classifyRootCauses('/data/rc', async () => '[]')
    // llm 被调用了（有信号送入），只是返回空数组
    dbmod.db.prepare(`UPDATE signals SET confirmation = NULL`).run()
    let called = false
    await rc.classifyRootCauses('/data/rc', async () => { called = true; return '[]' })
    expect(called).toBe(true)
    dbmod.db.prepare(`UPDATE signals SET confirmation = 'confirmed'`).run()
  })
})

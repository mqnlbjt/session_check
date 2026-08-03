// 教训聚合测试：信号规则频次 + 复盘 findings 聚合
import { beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'

process.env.SPECTATOR_DB = ':memory:'

let app: Hono
let dbmod: typeof import('../src/db.js')

beforeAll(async () => {
  dbmod = await import('../src/db.js')
  app = (await import('../src/server.js')).app

  // 项目 A：2 次纠正（wrong）+ 1 次挫折
  const pkA = dbmod.saveSessionMeta('pi', { sessionId: 'les-a', projectPath: '/data/projA', startedAt: '2026-07-01T10:00:00Z', title: 'A' })
  dbmod.appendMessage(pkA, 1, { role: 'user', ts: '2026-07-01T10:00:01Z', blocks: [{ type: 'text', text: '不对，重来' }] })
  dbmod.appendMessage(pkA, 2, { role: 'user', ts: '2026-07-01T10:01:00Z', blocks: [{ type: 'text', text: '怎么又挂了' }] })

  // 项目 B：1 次纠正（not-what-i-said）
  const pkB = dbmod.saveSessionMeta('claude', { sessionId: 'les-b', projectPath: '/data/projB', startedAt: '2026-07-02T10:00:00Z', title: 'B' })
  dbmod.appendMessage(pkB, 1, { role: 'user', ts: '2026-07-02T10:00:01Z', blocks: [{ type: 'text', text: '我的意思是另一种做法' }] })

  // 复盘 findings：A 项目一条 lesson + 一条 rework
  dbmod.insertReview.run('pi:les-a', '2026-07-01T12:00:00Z', 'spectator-engine', 'k3', 'mixed', '有返工',
    JSON.stringify([
      { type: 'lesson', detail: '先确认需求再动手', evidence: '用户说不对' },
      { type: 'rework', detail: '方案理解偏差导致重写' },
    ]))
  dbmod.insertReview.run('claude:les-b', '2026-07-02T12:00:00Z', 'manual', null, 'good', '顺利',
    JSON.stringify([{ type: 'good_practice', detail: '分步验证很稳' }]))
})

describe('教训聚合 /api/lessons', () => {
  it('信号规则频次（含 kind）', async () => {
    const res = await app.request('/api/lessons')
    const body = await res.json()
    const wrong = body.signalRules.find((r: any) => r.rule === 'wrong')
    expect(wrong.n).toBe(1)
    expect(wrong.kind).toBe('correction')
    const redo = body.signalRules.find((r: any) => r.rule === 'redo')
    expect(redo.n).toBe(1)
  })

  it('按项目聚合信号', async () => {
    const res = await app.request('/api/lessons')
    const body = await res.json()
    const pa = body.byProject.find((p: any) => p.project_path === '/data/projA')
    expect(pa.corrections).toBe(2) // "不对，重来" 双命中
    expect(pa.frustrations).toBe(1)
    const pb = body.byProject.find((p: any) => p.project_path === '/data/projB')
    expect(pb.corrections).toBe(1)
  })

  it('复盘 findings 按类型聚合 + lesson 明细', async () => {
    const res = await app.request('/api/lessons')
    const body = await res.json()
    const types = Object.fromEntries(body.findingTypes.map((t: any) => [t.type, t.n]))
    expect(types.lesson).toBe(1)
    expect(types.rework).toBe(1)
    expect(types.good_practice).toBe(1)
    // lesson 明细带出来源会话
    const lesson = body.lessons.find((l: any) => l.detail === '先确认需求再动手')
    expect(lesson.session_id).toBe('pi:les-a')
    expect(lesson.project_path).toBe('/data/projA')
  })
})

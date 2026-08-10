// 时间窗比较回归（审计 P0-1）：ISO ts vs datetime('now') 字符串比较让截止日当天全部通过
import { beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'

process.env.SPECTATOR_DB = ':memory:'

let app: Hono
let dbmod: typeof import('../src/db.js')

beforeAll(async () => {
  dbmod = await import('../src/db.js')
  app = (await import('../src/server.js')).app
  // 3 小时前结束的会话（同一天）——不应出现在「进行中」
  const pkOld = dbmod.saveSessionMeta('pi', { sessionId: 'tw-old', projectPath: '/data/tw', startedAt: new Date(Date.now() - 5 * 3600e3).toISOString(), title: 'old' }, new Date(Date.now() - 3 * 3600e3).toISOString())
  dbmod.appendMessage(pkOld, 1, { role: 'user', ts: new Date(Date.now() - 3 * 3600e3).toISOString(), blocks: [{ type: 'text', text: 'hi' }] })
  // 2 分钟前刚有消息的会话——应该在「进行中」
  const pkNew = dbmod.saveSessionMeta('pi', { sessionId: 'tw-new', projectPath: '/data/tw', startedAt: new Date(Date.now() - 10 * 60e3).toISOString(), title: 'new' }, new Date(Date.now() - 2 * 60e3).toISOString())
  dbmod.appendMessage(pkNew, 1, { role: 'user', ts: new Date(Date.now() - 2 * 60e3).toISOString(), blocks: [{ type: 'text', text: 'hi' }] })
})

describe('进行中列表（5 分钟窗口）', () => {
  it('3 小时前结束的会话不算进行中，2 分钟前的算', async () => {
    const body = await (await app.request('/api/overview')).json()
    const ids = body.active.map((a: any) => a.id)
    expect(ids).toContain('pi:tw-new')
    expect(ids).not.toContain('pi:tw-old') // 修复前：ISO 'T' > ' ' 导致今天全部通过
  })
})

describe('analytics 窗口边界（同一 bug 的姊妹现场）', () => {
  it('30 天窗：30 天又 2 小时前的会话不进，29 天前的进', async () => {
    const { modelCompare } = await import('../src/analytics.js')
    dbmod.saveSessionMeta('pi', { sessionId: 'tw-edge-out', projectPath: '/data/tw', startedAt: new Date(Date.now() - (30 * 86400e3 + 2 * 3600e3)).toISOString(), title: 'edge-out', model: 'edge-model-out' })
    dbmod.saveSessionMeta('pi', { sessionId: 'tw-edge-in', projectPath: '/data/tw', startedAt: new Date(Date.now() - 29 * 86400e3).toISOString(), title: 'edge-in', model: 'edge-model-in' })
    const rows = (await modelCompare(30)) as any[]
    expect(rows.some((r) => r.model === 'edge-model-out')).toBe(false) // 修复前被错误包含
    expect(rows.some((r) => r.model === 'edge-model-in')).toBe(true)
  })
})

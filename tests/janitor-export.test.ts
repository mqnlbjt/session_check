// 期3 测试：janitor 清理 + 会话导出 Markdown
import { beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'

process.env.SPECTATOR_DB = ':memory:'

let app: Hono
let dbmod: typeof import('../src/db.js')
let janitor: typeof import('../src/janitor.js')

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

beforeAll(async () => {
  dbmod = await import('../src/db.js')
  app = (await import('../src/server.js')).app
  janitor = await import('../src/janitor.js')

  // 91 天前的老会话：应被清理
  const old91 = dbmod.saveSessionMeta('pi', { sessionId: 'old-91', projectPath: '/data/a', startedAt: daysAgo(91), title: '老会话' })
  dbmod.appendMessage(old91, 1, { role: 'user', ts: daysAgo(91), blocks: [{ type: 'text', text: '老会话的用户提问 oldquery' }] })
  dbmod.appendMessage(old91, 2, { role: 'tool', ts: daysAgo(91), blocks: [{ type: 'tool_result', output: 'X'.repeat(5000), toolCallId: '1' }] })
  // 手动把 ended_at 定到 91 天前（appendMessage 会 bump 成现在）
  dbmod.db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(daysAgo(91), old91)

  // 89 天前的会话：不动
  const mid89 = dbmod.saveSessionMeta('pi', { sessionId: 'mid-89', startedAt: daysAgo(89), title: '较新会话' })
  dbmod.appendMessage(mid89, 1, { role: 'tool', ts: daysAgo(89), blocks: [{ type: 'tool_result', output: 'Y'.repeat(1000), toolCallId: '1' }] })
  dbmod.db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(daysAgo(89), mid89)

  // 长跑会话：started 120 天前但 ended 5 天前：不动
  const longRun = dbmod.saveSessionMeta('pi', { sessionId: 'long-run', startedAt: daysAgo(120), title: '长跑会话' })
  dbmod.appendMessage(longRun, 1, { role: 'tool', ts: daysAgo(5), blocks: [{ type: 'tool_result', output: 'Z'.repeat(1000), toolCallId: '1' }] })
  dbmod.db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(daysAgo(5), longRun)
})

describe('janitor 清理', () => {
  it('91 天前会话的 tool_result output 清空，text 保留', () => {
    const r = janitor.runJanitor(90)
    expect(r.sessions).toBe(1)
    expect(r.bytesFreed).toBeGreaterThanOrEqual(5000)
    const msg = dbmod.db.prepare(`SELECT blocks_json FROM messages WHERE session_id = 'pi:old-91' ORDER BY seq`).all() as any[]
    const blocks1 = JSON.parse(msg[0].blocks_json)
    expect(blocks1[0].text).toContain('oldquery') // text 不动
    const blocks2 = JSON.parse(msg[1].blocks_json)
    expect(blocks2[0].type).toBe('tool_result') // block 结构保留
    expect(blocks2[0].output).toBeFalsy() // output 清空
  })

  it('89 天前和长跑会话不动', () => {
    const m89 = dbmod.db.prepare(`SELECT blocks_json FROM messages WHERE session_id = 'pi:mid-89'`).get() as any
    expect(JSON.parse(m89.blocks_json)[0].output.length).toBe(1000)
    const mlr = dbmod.db.prepare(`SELECT blocks_json FROM messages WHERE session_id = 'pi:long-run'`).get() as any
    expect(JSON.parse(mlr.blocks_json)[0].output.length).toBe(1000)
  })

  it('清理后 FTS 仍搜得到该会话的 text', async () => {
    const res = await app.request('/api/search?q=oldquery')
    const body = await res.json()
    expect(body.total).toBe(1)
  })

  it('janitor_log 记录 + 幂等', () => {
    const log = dbmod.db.prepare(`SELECT * FROM janitor_log ORDER BY id DESC LIMIT 1`).get() as any
    expect(log.sessions).toBe(1)
    expect(log.bytes_freed).toBeGreaterThanOrEqual(5000)
    const r2 = janitor.runJanitor(90)
    expect(r2.sessions).toBe(0)
    expect(r2.bytesFreed).toBe(0)
  })
})

describe('会话导出 Markdown', () => {
  it('frontmatter + 消息渲染', async () => {
    const res = await app.request('/api/sessions/pi:old-91/export.md')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/markdown')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    const md = await res.text()
    expect(md).toContain('title: "老会话"')
    expect(md).toContain('agent: pi')
    expect(md).toContain('oldquery')
  })

  it('不存在的会话 404', async () => {
    const res = await app.request('/api/sessions/pi:nosuch/export.md')
    expect(res.status).toBe(404)
  })
})

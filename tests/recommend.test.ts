// 推荐物组装测试（#16）：分类→静态确认→搜索推荐物→组装 pending 推荐落库
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'

process.env.SPECTATOR_DB = ':memory:'

let app: Hono
let dbmod: typeof import('../src/db.js')
let rec: typeof import('../src/recommend.js')

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
let projDir = ''

const fakeSearch = async (q: string) => ({ name: 'tdd-workflow', installs: 185000, url: 'https://skills.sh/x/tdd-workflow', description: `result for ${q}` })

beforeAll(async () => {
  dbmod = await import('../src/db.js')
  app = (await import('../src/server.js')).app
  rec = await import('../src/recommend.js')

  // 无防护项目 + 一条 missing-verification 根因的已确认信号
  projDir = mkdtempSync(join(tmpdir(), 'spect-rec-'))
  writeFileSync(join(projDir, 'package.json'), JSON.stringify({ name: 'rec', scripts: {} }))
  const pk = dbmod.saveSessionMeta('pi', { sessionId: 'rec-1', projectPath: projDir, startedAt: daysAgo(5), title: 'REC' })
  dbmod.appendMessage(pk, 1, { role: 'assistant', ts: daysAgo(5), blocks: [{ type: 'tool_call', name: 'edit', input: {} }] })
  dbmod.appendMessage(pk, 2, { role: 'user', ts: daysAgo(5), blocks: [{ type: 'text', text: '不对，你改完没跑测试' }] })
  dbmod.db.prepare(`UPDATE signals SET root_cause = 'missing-verification', confirmation = 'confirmed'`).run()
})

const recRows = () => dbmod.db.prepare(
  `SELECT * FROM suggestions WHERE project_path = ? AND kind = 'recommendation'`).all(projDir) as any[]

describe('推荐物组装', () => {
  it('可推荐根因 → 组装 pending 推荐（含完整证据链）', async () => {
    const r = await rec.assembleRecommendations(projDir, { searchSkills: fakeSearch })
    expect(r.created).toBe(1)
    const rows = recRows()
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('pending')
    expect(rows[0].content).toContain('测试验证缺失')
    expect(rows[0].content).toContain('tdd-workflow')
    const ev = JSON.parse(rows[0].evidence)
    expect(ev.category).toBe('missing-verification')
    expect(ev.category_label).toBe('测试验证缺失')
    expect(ev.signals.length).toBeGreaterThan(0)
    expect(ev.checks.length).toBeGreaterThanOrEqual(2)
    expect(ev.search_terms).toContain('tdd')
    expect(ev.candidate.name).toBe('tdd-workflow')
    expect(ev.candidate.installs).toBe(185000)
    expect(ev.route).toBe('skill')
  })

  it('幂等：同项目同类别已有 pending 推荐 → 不重复创建', async () => {
    const r = await rec.assembleRecommendations(projDir, { searchSkills: fakeSearch })
    expect(r.created).toBe(0)
    expect(recRows().length).toBe(1)
  })

  it('dismissed 的类别不再回来（去重闭环）', async () => {
    dbmod.db.prepare(`UPDATE suggestions SET status = 'dismissed' WHERE kind = 'recommendation'`).run()
    const r = await rec.assembleRecommendations(projDir, { searchSkills: fakeSearch })
    expect(r.created).toBe(0)
    expect(recRows().filter((x) => x.status === 'pending').length).toBe(0)
  })

  it('搜索失败降级为「仅根因诊断」卡片（candidate 为空但不炸）', async () => {
    dbmod.db.prepare(`DELETE FROM suggestions WHERE kind = 'recommendation'`).run()
    const badSearch = async () => { throw new Error('network down') }
    const r = await rec.assembleRecommendations(projDir, { searchSkills: badSearch })
    expect(r.created).toBe(1)
    const ev = JSON.parse(recRows()[0].evidence)
    expect(ev.candidate).toBeNull()
    expect(recRows()[0].content).toContain('测试验证缺失')
  })

  it('已有防护的根因不产生推荐', async () => {
    // guarded 项目：有测试框架 → overreach 之外缺 hook，但 missing-verification 会被防护
    const gDir = mkdtempSync(join(tmpdir(), 'spect-recg-'))
    writeFileSync(join(gDir, 'package.json'), JSON.stringify({ name: 'g', scripts: { test: 'vitest' } }))
    const pk = dbmod.saveSessionMeta('pi', { sessionId: 'rec-g', projectPath: gDir, startedAt: daysAgo(5), title: 'G' })
    dbmod.appendMessage(pk, 1, { role: 'assistant', ts: daysAgo(5), blocks: [{ type: 'tool_call', name: 'edit', input: {} }] })
    dbmod.appendMessage(pk, 2, { role: 'user', ts: daysAgo(5), blocks: [{ type: 'text', text: '不对，你又没验证' }] })
    dbmod.db.prepare(`UPDATE signals SET root_cause = 'missing-verification' WHERE session_id = 'pi:rec-g'`).run()
    const r = await rec.assembleRecommendations(gDir, { searchSkills: fakeSearch })
    expect(r.created).toBe(0)
  })
})

describe('组装 API + 弱提示数据', () => {
  it('POST /api/harness/assemble 触发（后台）', async () => {
    const res = await app.request('/api/harness/assemble', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_path: projDir }),
    })
    expect(res.status).toBe(200)
  })

  it('candidates 带已确认待诊断信号数（弱提示用）', async () => {
    const res = await app.request('/api/harness/suggestions')
    const body = await res.json()
    const cand = body.candidates.find((c: any) => c.project_path === projDir)
    expect(cand).toBeTruthy()
    expect(cand.confirmed_undiagnosed).toBeGreaterThanOrEqual(0)
  })
})

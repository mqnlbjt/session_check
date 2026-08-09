// 验证闭环测试（#18）：采纳前后信号频率按周归一化对比 + 三态标记
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'

process.env.SPECTATOR_DB = ':memory:'

let app: Hono
let dbmod: typeof import('../src/db.js')
let eff: typeof import('../src/effectiveness.js')

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
let projDir = ''
let effInstId = 0, ineffInstId = 0, obsInstId = 0

function mkInstallation(projectPath: string, category: string | null, installedAt: string, status = 'active', perWeek = 4): number {
  const baseline = JSON.stringify({ category, signals_90d: perWeek * 4, window_start: daysAgo(90), weeks: 4, per_week: perWeek })
  const info = dbmod.db.prepare(`
    INSERT INTO installations (suggestion_id, project_path, category, route, artifact, target_path, baseline_json, status, installed_at)
    VALUES (NULL, ?, ?, 'skill', '测试skill', '/fake/dir', ?, ?, ?)
  `).run(projectPath, category, baseline, status, installedAt)
  return Number(info.lastInsertRowid)
}

beforeAll(async () => {
  dbmod = await import('../src/db.js')
  app = (await import('../src/server.js')).app
  eff = await import('../src/effectiveness.js')
  projDir = mkdtempSync(join(tmpdir(), 'spect-eff-'))

  const pk = dbmod.saveSessionMeta('pi', { sessionId: 'eff-1', projectPath: projDir, startedAt: daysAgo(80), title: 'E' })
  // 采纳前：missing-verification 高频（20 条，70-40 天前）
  for (let i = 0; i < 20; i++) {
    dbmod.appendMessage(pk, i + 1, { role: 'user', ts: daysAgo(70 - i), blocks: [{ type: 'text', text: '不对，你又没跑测试' }] })
  }
  // 采纳后：只剩 1 条（5 天前）
  dbmod.appendMessage(pk, 21, { role: 'user', ts: daysAgo(5), blocks: [{ type: 'text', text: '不对，又没验证' }] })
  dbmod.db.prepare(`UPDATE signals SET root_cause = 'missing-verification', confirmation = 'confirmed'`).run()

  effInstId = mkInstallation(projDir, 'missing-verification', daysAgo(35))     // 35 天前装，信号骤降 → 生效中
  ineffInstId = mkInstallation(projDir, 'overreach', daysAgo(40), 'active', 1)  // 基线 1/周，之后 8 条/5.7 周 ≈ 1.4/周 → 未生效
  obsInstId = mkInstallation(projDir, 'env-context', daysAgo(10))              // 10 天前装 → 观察中
  // overreach 采纳后也有信号（40 天前装的，之后继续犯）
  const pk2 = dbmod.saveSessionMeta('pi', { sessionId: 'eff-2', projectPath: projDir, startedAt: daysAgo(30), title: 'E2' })
  for (let i = 0; i < 8; i++) {
    dbmod.appendMessage(pk2, i + 1, { role: 'user', ts: daysAgo(30 - i * 3), blocks: [{ type: 'text', text: '谁让你改配置的' }] })
  }
  dbmod.db.prepare(`UPDATE signals SET root_cause = 'overreach' WHERE session_id = 'pi:eff-2'`).run()
})

describe('效果评估（按周归一化）', () => {
  it('采纳后信号骤降 + 超过 30 天 → 生效中', () => {
    const r = eff.evaluate(effInstId)
    expect(r.status).toBe('effective')
    expect(r.baseline_per_week).toBeGreaterThan(0)
    expect(r.post_per_week).toBeLessThan(r.baseline_per_week * 0.5)
    expect(r.days).toBeGreaterThanOrEqual(34)
  })
  it('采纳后信号依旧 → 未生效', () => {
    const r = eff.evaluate(ineffInstId)
    expect(r.status).toBe('ineffective')
  })
  it('不足 30 天 → 观察中（不做判决）', () => {
    const r = eff.evaluate(obsInstId)
    expect(r.status).toBe('observing')
  })
  it('已撤销 → uninstalled', () => {
    const id = mkInstallation(projDir, 'style-mismatch', daysAgo(50), 'uninstalled')
    expect(eff.evaluate(id).status).toBe('uninstalled')
  })
})

describe('效果 API + 归因声明', () => {
  it('GET /api/harness/effectiveness 返回前后对比 + 固定归因声明', async () => {
    const rows = await (await app.request('/api/harness/effectiveness')).json()
    expect(rows.length).toBeGreaterThanOrEqual(3)
    const e = rows.find((x: any) => x.id === effInstId)
    expect(e.status).toBe('effective')
    expect(e).toHaveProperty('baseline_per_week')
    expect(e).toHaveProperty('post_per_week')
    expect(e.disclaimer).toContain('信号下降 ≠ 推荐生效')
  })
})

describe('未生效降权', () => {
  it('未生效类别不再生成同类推荐', async () => {
    const { assembleRecommendations } = await import('../src/recommend.js')
    // overreach 未生效 → 即使防护缺失也不再推荐
    const pk3 = dbmod.saveSessionMeta('pi', { sessionId: 'eff-3', projectPath: projDir, startedAt: daysAgo(2), title: 'E3' })
    dbmod.appendMessage(pk3, 1, { role: 'assistant', ts: daysAgo(2), blocks: [{ type: 'tool_call', name: 'edit', input: {} }] })
    dbmod.appendMessage(pk3, 2, { role: 'user', ts: daysAgo(2), blocks: [{ type: 'text', text: '谁让你又改配置了' }] })
    dbmod.db.prepare(`UPDATE signals SET root_cause = 'overreach' WHERE session_id = 'pi:eff-3'`).run()
    const r = await assembleRecommendations(projDir, { searchSkills: async () => ({ name: 'x', installs: 1, url: '', description: '' }) })
    const recs = dbmod.db.prepare(`SELECT evidence FROM suggestions WHERE project_path = ? AND kind = 'recommendation'`).all(projDir) as any[]
    expect(recs.every((x) => JSON.parse(x.evidence).category !== 'overreach')).toBe(true)
  })
})

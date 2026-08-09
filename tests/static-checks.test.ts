// 静态确认检查器测试（#15）：按根因类别跑确定性验证，判定「防护缺失」
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'

process.env.SPECTATOR_DB = ':memory:'

let app: Hono
let dbmod: typeof import('../src/db.js')
let checks: typeof import('../src/static-checks.js')

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

// 无防护项目：光秃秃的目录
let bareDir = ''
// 有防护项目：测试框架 + AGENTS.md 保护声明 + hook 配置
let guardedDir = ''

beforeAll(async () => {
  dbmod = await import('../src/db.js')
  app = (await import('../src/server.js')).app
  checks = await import('../src/static-checks.js')

  bareDir = mkdtempSync(join(tmpdir(), 'spect-bare-'))
  writeFileSync(join(bareDir, 'package.json'), JSON.stringify({ name: 'bare', scripts: { start: 'node x.js' } }))

  guardedDir = mkdtempSync(join(tmpdir(), 'spect-guarded-'))
  writeFileSync(join(guardedDir, 'package.json'), JSON.stringify({ name: 'g', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^4' } }))
  writeFileSync(join(guardedDir, 'AGENTS.md'), '# 项目约定\n## 风格约定：中文注释\n受保护路径：docs/ 不要改\n')
  mkdirSync(join(guardedDir, '.claude'))
  writeFileSync(join(guardedDir, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [] } }))
  writeFileSync(join(guardedDir, 'CONTEXT.md'), '# 环境：部署到测试服务器\n')

  // 分类信号：bareDir 项目有 missing-verification 和 overreach 根因
  const pk = dbmod.saveSessionMeta('pi', { sessionId: 'sc-1', projectPath: bareDir, startedAt: daysAgo(5), title: 'SC' })
  dbmod.appendMessage(pk, 1, { role: 'assistant', ts: daysAgo(5), blocks: [{ type: 'tool_call', name: 'edit', input: {} }] })
  dbmod.appendMessage(pk, 2, { role: 'user', ts: daysAgo(5), blocks: [{ type: 'text', text: '不对，你没跑测试' }] })
  dbmod.db.prepare(`UPDATE signals SET root_cause = 'missing-verification', confirmation = 'confirmed'`).run()
})

describe('单项检查器', () => {
  it('test-framework：package.json 有 test 脚本 → present，没有 → missing', () => {
    expect(checks.runCheck('test-framework', guardedDir).status).toBe('present')
    expect(checks.runCheck('test-framework', bareDir).status).toBe('missing')
  })
  it('hook-config：.claude/settings.json 有 PreToolUse → present', () => {
    expect(checks.runCheck('hook-config', guardedDir).status).toBe('present')
    expect(checks.runCheck('hook-config', bareDir).status).toBe('missing')
  })
  it('protected-paths：AGENTS.md 有保护声明 → present', () => {
    expect(checks.runCheck('protected-paths', guardedDir).status).toBe('present')
    expect(checks.runCheck('protected-paths', bareDir).status).toBe('missing')
  })
  it('env-docs：CONTEXT.md 有部署/环境内容 → present', () => {
    expect(checks.runCheck('env-docs', guardedDir).status).toBe('present')
    expect(checks.runCheck('env-docs', bareDir).status).toBe('missing')
  })
  it('项目目录不存在 → unknown 不炸', () => {
    expect(checks.runCheck('test-framework', '/nonexistent/path/xyz').status).toBe('unknown')
  })
})

describe('类别级验证判定', () => {
  it('全部检查 missing → confirmed-gap（可推荐）；有 present → already-protected（降权）', () => {
    const gap = checks.verifyCategory('missing-verification', bareDir)
    expect(gap.verdict).toBe('confirmed-gap')
    expect(gap.recommendable).toBe(true)
    const prot = checks.verifyCategory('overreach', guardedDir)
    expect(prot.verdict).toBe('already-protected')
    expect(prot.recommendable).toBe(false)
  })
})

describe('项目级验证 + 落库 + API', () => {
  it('POST /api/harness/verify 跑项目全部已分类根因的检查并落库', async () => {
    const res = await app.request('/api/harness/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_path: bareDir }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    const mv = body.results.find((r: any) => r.category === 'missing-verification')
    expect(mv.verdict).toBe('confirmed-gap')
    expect(mv.checks.length).toBeGreaterThanOrEqual(2) // 每类至少 2 个检查项
    const row = dbmod.db.prepare(`SELECT verdict, checks_json FROM verifications WHERE project_path = ? AND category = 'missing-verification'`).get(bareDir) as any
    expect(row.verdict).toBe('confirmed-gap')
    expect(JSON.parse(row.checks_json).length).toBeGreaterThanOrEqual(2)
  })

  it('重复验证幂等（同项目同类别的记录 upsert）', async () => {
    await app.request('/api/harness/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_path: bareDir }),
    })
    const n = dbmod.db.prepare(`SELECT COUNT(*) n FROM verifications WHERE project_path = ?`).get(bareDir) as any
    expect(n.n).toBe(1)
  })
})

describe('已落库检查结论读取（#15 review 补强）', () => {
  it('GET /api/harness/verifications 按项目返回检查明细（不重跑）', async () => {
    const res = await app.request(`/api/harness/verifications?project_path=${encodeURIComponent(bareDir)}`)
    expect(res.status).toBe(200)
    const rows = await res.json()
    expect(rows.length).toBe(1)
    expect(rows[0].category).toBe('missing-verification')
    expect(JSON.parse(rows[0].checks_json).every((c: any) => c.kind && c.status && c.detail)).toBe(true)
  })
})

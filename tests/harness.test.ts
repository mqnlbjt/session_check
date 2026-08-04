// Harness 建议引擎测试：LLM 生成（注入假实现）+ 采纳/忽略 + 模型建议
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'

process.env.SPECTATOR_DB = ':memory:'

let app: Hono
let dbmod: typeof import('../src/db.js')
let harness: typeof import('../src/harness.js')
let projDir = ''

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

beforeAll(async () => {
  dbmod = await import('../src/db.js')
  app = (await import('../src/server.js')).app
  harness = await import('../src/harness.js')

  projDir = mkdtempSync(join(tmpdir(), 'spect-harness-'))

  // 项目会话：高频纠正信号（5 天前，在 30 天建议窗口内）
  const pk = dbmod.saveSessionMeta('pi', { sessionId: 'h-1', projectPath: projDir, startedAt: daysAgo(5), title: 'H', model: 'gpt-5.5' })
  for (let i = 0; i < 3; i++) {
    dbmod.appendMessage(pk, i + 1, { role: 'user', ts: daysAgo(5), blocks: [{ type: 'text', text: '不对，你改错文件了' }] })
  }
  dbmod.appendMessage(pk, 10, { role: 'assistant', ts: daysAgo(5), blocks: [{ type: 'text', text: '好' }], usage: { input: 100, output: 50 } })
  // 让模型建议有数据：gpt-5.5 高成本 + 有纠正
  dbmod.db.prepare(`UPDATE sessions SET input_tokens = 10000000, output_tokens = 200000, avg_tps = 30 WHERE id = ?`).run(pk)
  // 便宜替代：deepseek 低纠正（5 个会话满足样本量阈值）
  for (let i = 0; i < 5; i++) {
    const pkAlt = dbmod.saveSessionMeta('pi', { sessionId: `h-alt-${i}`, projectPath: '/data/other', startedAt: daysAgo(3), title: `Alt${i}`, model: 'deepseek-v4-pro' })
    dbmod.appendMessage(pkAlt, 1, { role: 'assistant', ts: daysAgo(3), blocks: [{ type: 'text', text: '好' }], usage: { input: 100, output: 50 } })
    dbmod.db.prepare(`UPDATE sessions SET input_tokens = 1000000, output_tokens = 20000, avg_tps = 50 WHERE id = ?`).run(pkAlt)
  }
})

describe('防呆规则生成（LLM 注入）', () => {
  it('假 LLM 返回 JSON 数组 → 规则落 suggestions', async () => {
    const fakeLlm = async () => '分析完毕：["动手前先复述用户需求再改代码", "修改前确认目标文件路径"]'
    const rules = await harness.generateGuardRules(projDir, fakeLlm)
    expect(rules.length).toBe(2)
    const rows = dbmod.db.prepare(`SELECT * FROM suggestions WHERE project_path = ? AND kind = 'guard_rule'`).all(projDir) as any[]
    expect(rows.length).toBe(2)
    expect(rows[0].status).toBe('pending')
    expect(rows[0].evidence).toContain('wrong')
  })

  it('LLM 返回非 JSON → 不落库不炸', async () => {
    const badLlm = async () => '我觉得这个项目需要注意很多问题，但我说不清楚'
    const rules = await harness.generateGuardRules(projDir, badLlm)
    expect(rules).toEqual([])
    const n = dbmod.db.prepare(`SELECT COUNT(*) n FROM suggestions WHERE project_path = ?`).get(projDir) as any
    expect(n.n).toBe(2) // 还是之前的 2 条
  })
})

describe('任务×模型推荐', () => {
  it('任务分类规则', async () => {
    const { classifyTask } = await import('../src/analytics.js')
    expect(classifyTask('帮我总结一下这周的工作写个周报')).toBe('文档写作')
    expect(classifyTask('修复登录接口的 bug')).toBe('调试修复')
    expect(classifyTask('重构用户模块的分层架构')).toBe('重构优化')
    expect(classifyTask('实现一个全文搜索功能')).toBe('开发实现')
    expect(classifyTask('什么是分布式租约')).toBe('学习探索')
    expect(classifyTask('随便聊聊')).toBe('其他')
  })

  it('同任务下推荐质量相当的最便宜模型', async () => {
    // 文档写作任务：贵的 gpt-5.5（2 会话）+ 便宜的 deepseek（3 会话），纠正率相当
    for (let i = 0; i < 2; i++) {
      const pk = dbmod.saveSessionMeta('pi', { sessionId: `task-doc-exp-${i}`, projectPath: '/data/docs', startedAt: daysAgo(2), title: '写个项目周报总结', model: 'gpt-5.5' })
      dbmod.appendMessage(pk, 1, { role: 'assistant', ts: daysAgo(2), blocks: [{ type: 'text', text: '好' }], usage: { input: 100, output: 50 } })
      dbmod.db.prepare(`UPDATE sessions SET input_tokens = 5000000, output_tokens = 100000 WHERE id = ?`).run(pk)
    }
    for (let i = 0; i < 3; i++) {
      const pk = dbmod.saveSessionMeta('pi', { sessionId: `task-doc-cheap-${i}`, projectPath: '/data/docs', startedAt: daysAgo(2), title: '帮我写个复盘文档', model: 'deepseek-v4-pro' })
      dbmod.appendMessage(pk, 1, { role: 'assistant', ts: daysAgo(2), blocks: [{ type: 'text', text: '好' }], usage: { input: 100, output: 50 } })
      dbmod.db.prepare(`UPDATE sessions SET input_tokens = 100000, output_tokens = 20000 WHERE id = ?`).run(pk)
    }
    const res = await app.request('/api/analytics/task-models?window=30')
    expect(res.status).toBe(200)
    const rows = await res.json()
    const docRows = rows.filter((r: any) => r.task === '文档写作')
    expect(docRows.length).toBeGreaterThanOrEqual(2)
    const expensive = docRows.find((r: any) => r.model === 'gpt-5.5')
    const cheap = docRows.find((r: any) => r.model === 'deepseek-v4-pro')
    expect(expensive.cost_per_session).toBeGreaterThan(cheap.cost_per_session * 10)
  })

  it('taskAdvice 产出分任务建议', async () => {
    const res = await app.request('/api/harness/suggestions')
    const body = await res.json()
    const doc = body.taskAdvice.find((a: any) => a.task === '文档写作')
    expect(doc).toBeTruthy()
    expect(doc.content).toContain('deepseek-v4-pro')
    expect(doc.content).toContain('gpt-5.5')
    const ev = JSON.parse(doc.evidence)
    expect(ev.recommended.cost_per_session).toBeLessThan(ev.current.cost_per_session)
  })
})

describe('建议 API', () => {
  it('GET 返回 pending 优先 + 模型建议', async () => {
    const res = await app.request('/api/harness/suggestions')
    const body = await res.json()
    expect(body.suggestions.length).toBe(2)
    expect(body.suggestions[0].status).toBe('pending')
    // gpt-5.5 高成本高纠正 + deepseek 便宜低纠正 → 产生建议
    expect(body.modelAdvice.length).toBeGreaterThan(0)
    expect(body.modelAdvice[0].content).toContain('gpt-5.5')
  })

  it('模型建议带结构化证据：两个模型的完整指标对比（30 天窗口）', async () => {
    const res = await app.request('/api/harness/suggestions')
    const body = await res.json()
    const ev = JSON.parse(body.modelAdvice[0].evidence)
    expect(ev.window_days).toBe(30)
    expect(ev.from.model).toBe('gpt-5.5')
    expect(ev.from.cost).toBeGreaterThan(0)
    expect(ev.from.sessions).toBe(3) // h-1 + task-doc-exp×2
    expect(ev.to.model).toBe('deepseek-v4-pro')
    expect(ev.to.sessions).toBe(8) // h-alt×5 + task-doc-cheap×3
    expect(ev.saving_pct).toBeGreaterThan(50)
    // 对比维度齐全
    for (const side of [ev.from, ev.to]) {
      expect(side).toHaveProperty('avg_corrections')
      expect(side).toHaveProperty('fail_rate')
      expect(side).toHaveProperty('avg_tps')
    }
  })

  it('30 天前的会话不进模型建议', async () => {
    // 造一个 40 天前的高成本模型会话：不应触发建议
    const pk = dbmod.saveSessionMeta('pi', { sessionId: 'h-old', projectPath: '/data/old', startedAt: daysAgo(40), title: 'Old', model: 'gpt-5.4' })
    dbmod.appendMessage(pk, 1, { role: 'assistant', ts: daysAgo(40), blocks: [{ type: 'text', text: '好' }], usage: { input: 100, output: 50 } })
    dbmod.db.prepare(`UPDATE sessions SET input_tokens = 50000000, output_tokens = 1000000 WHERE id = ?`).run(pk)
    const res = await app.request('/api/harness/suggestions')
    const body = await res.json()
    expect(body.modelAdvice.every((a: any) => !a.content.includes('gpt-5.4'))).toBe(true)
  })

  it('adopt 写入 AGENTS.md 标记块', async () => {
    const row = dbmod.db.prepare(`SELECT id FROM suggestions LIMIT 1`).get() as any
    const res = await app.request(`/api/harness/suggestions/${row.id}/adopt`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.adopted_to).toContain('AGENTS.md')
    const content = readFileSync(join(projDir, 'AGENTS.md'), 'utf8')
    expect(content).toContain('动手前先复述用户需求再改代码')
    const after = dbmod.db.prepare(`SELECT status FROM suggestions WHERE id = ?`).get(row.id) as any
    expect(after.status).toBe('adopted')
  })

  it('dismiss 后不再出现在 pending', async () => {
    const row = dbmod.db.prepare(`SELECT id FROM suggestions WHERE status = 'pending' LIMIT 1`).get() as any
    await app.request(`/api/harness/suggestions/${row.id}/dismiss`, { method: 'POST' })
    const res = await app.request('/api/harness/suggestions')
    const body = await res.json()
    // dismissed 仍在列表（前端折叠展示），但状态已变
    const dismissed = body.suggestions.find((s: any) => s.id === row.id)
    expect(dismissed.status).toBe('dismissed')
    expect(body.suggestions.filter((s: any) => s.status === 'pending').every((s: any) => s.id !== row.id)).toBe(true)
  })
})

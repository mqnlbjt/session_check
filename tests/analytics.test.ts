// 期4 测试：分析聚合 API + 项目下钻（成本 vs commit）
import { beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'

process.env.SPECTATOR_DB = ':memory:'

let app: Hono
let dbmod: typeof import('../src/db.js')

// 本周三 14:00（本地）构造一个确定落在某格的时间
function at(dow: number, hour: number): string {
  const d = new Date()
  d.setDate(d.getDate() - ((d.getDay() - dow + 7) % 7))
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}

let gitRepo = ''

beforeAll(async () => {
  dbmod = await import('../src/db.js')
  app = (await import('../src/server.js')).app

  // git 项目：临时仓库造 2 个提交
  gitRepo = mkdtempSync(join(tmpdir(), 'spect-git-'))
  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileSync('git', ['-C', gitRepo, ...args], { env: { ...process.env, ...env } })
  git(['init', '-q'])
  git(['config', 'user.email', 't@t.c'])
  git(['config', 'user.name', 't'])
  git(['commit', '-q', '--allow-empty', '-m', 'c1'], { GIT_AUTHOR_DATE: at(1, 10), GIT_COMMITTER_DATE: at(1, 10) })
  git(['commit', '-q', '--allow-empty', '-m', 'c2'], { GIT_AUTHOR_DATE: at(1, 10), GIT_COMMITTER_DATE: at(1, 10) })
  // c3：带 3 行真实变更，时间落在 an-a 会话窗口内（周三 14:00 +5min）
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(gitRepo, 'src.ts'), 'line1\nline2\nline3\n')
  git(['add', '.'])
  const c3time = new Date(new Date(at(3, 14)).getTime() + 5 * 60000).toISOString()
  git(['commit', '-q', '-m', 'c3'], { GIT_AUTHOR_DATE: c3time, GIT_COMMITTER_DATE: c3time })

  // 模型 A 会话（git 项目，有纠正信号）
  const pkA = dbmod.saveSessionMeta('pi', { sessionId: 'an-a', projectPath: gitRepo, startedAt: at(3, 14), title: 'A', model: 'claude-sonnet-4' })
  const t0 = new Date(at(3, 14)).getTime()
  const ts = (plusSec: number) => new Date(t0 + plusSec * 1000).toISOString()
  dbmod.appendMessage(pkA, 1, { role: 'user', ts: ts(0), blocks: [{ type: 'text', text: '不对，重来' }] })
  // 10 秒后回复 → 延迟估算 10s；usage 带 reasoning
  dbmod.appendMessage(pkA, 2, { role: 'assistant', ts: ts(10), blocks: [{ type: 'text', text: '好的' }], usage: { input: 1000, output: 500, cacheRead: 4000, reasoning: 120 } })
  // API 失败消息（无 usage，不计延迟）
  dbmod.appendMessage(pkA, 3, { role: 'assistant', ts: ts(60), blocks: [{ type: 'text', text: '[API 错误] 500' }], apiError: true })

  // 模型 B 会话（无 git 的项目）
  const pkB = dbmod.saveSessionMeta('codex', { sessionId: 'an-b', projectPath: '/data/nogit', startedAt: at(5, 22), title: 'B', model: 'gpt-5' })
  dbmod.appendMessage(pkB, 1, { role: 'assistant', ts: at(5, 22), blocks: [{ type: 'text', text: '干活' }], usage: { input: 2000, output: 800 } })

  // codex 会话（git 项目）：token 在 metrics 采样表，消息无 usage_json
  const pkC = dbmod.saveSessionMeta('codex', { sessionId: 'an-c', projectPath: gitRepo, startedAt: at(3, 14), title: 'C', model: 'gpt-5' })
  dbmod.appendMetric(pkC, { ts: at(3, 13), cumInput: 1000, cumOutput: 500 })
  dbmod.appendMetric(pkC, { ts: at(3, 14), cumInput: 3000, cumOutput: 1500 })
  dbmod.setCumulativeUsage(pkC, { input: 3000, output: 1500, cacheRead: 0 })

  // subagent 会话：不应进分析
  const pkSub = dbmod.saveSessionMeta('pi', { sessionId: 'an-sub', projectPath: gitRepo, startedAt: at(3, 14), title: 'sub', parentSessionId: 'an-a' })
  dbmod.appendMessage(pkSub, 1, { role: 'assistant', ts: at(3, 14), blocks: [{ type: 'text', text: 'sub 消息' }], usage: { input: 99999, output: 99999 } })
})

describe('热力图', () => {
  it('7×24 网格且只算主会话', async () => {
    const res = await app.request('/api/analytics/heatmap')
    const body = await res.json()
    expect(body.grid.length).toBe(7)
    expect(body.grid[0].length).toBe(24)
    // 周三14点 = 3 条主会话消息（含 API 错误消息；subagent 的 1 条不进）
    expect(body.grid[3][14].messages).toBe(3)
    expect(body.grid[5][22].messages).toBe(1)
    const total = body.grid.flat().reduce((s: number, c: any) => s + c.messages, 0)
    expect(total).toBe(4)
  })
})

describe('模型对比', () => {
  it('按模型聚合成本/TPS/纠正数', async () => {
    const res = await app.request('/api/analytics/models')
    const rows = await res.json()
    const a = rows.find((r: any) => r.model === 'claude-sonnet-4')
    const b = rows.find((r: any) => r.model === 'gpt-5')
    expect(a.sessions).toBe(1)
    expect(a.output_tokens).toBe(500)
    expect(a.cost).toBeGreaterThan(0)
    expect(a.avg_corrections).toBe(2) // "不对，重来" 命中 wrong+redo 两条规则
    // 缓存统计：4000 cache_read / (1000 净输入 + 4000) = 80% 命中率，省 4000×3×0.9/1e6
    expect(a.cache_hit_pct).toBe(80)
    expect(a.cache_saved).toBeCloseTo(0.0108, 6)
    // 新维度：失败率 1/2（2 条 assistant 中 1 条 apiError）、reasoning tokens、延迟估算
    expect(a.fail_rate).toBe(50)
    expect(a.reasoning_tokens).toBe(120)
    expect(a.avg_latency_s).toBeCloseTo(10, 1)
    // 产出：c3（3 行变更）落在 an-a/an-c 窗口内，时间窗归属给其中一个模型
    expect(a.commits + b.commits).toBe(1)
    expect(a.code_lines + b.code_lines).toBe(3)
    expect(a.active_hours).toBe(0) // 60s 活跃 → 0.0h
    expect(b.sessions).toBe(2) // an-b + an-c（codex）
    expect(b.output_tokens).toBe(2300) // 800 + 1500
    expect(b.avg_corrections).toBe(0)
    // subagent 的 99999 token 不进任何模型统计
    expect(rows.every((r: any) => r.output_tokens < 99999)).toBe(true)
  })
})

describe('项目成本榜', () => {
  it('按项目聚合降序', async () => {
    const res = await app.request('/api/analytics/projects')
    const rows = await res.json()
    expect(rows.length).toBe(2)
    const git = rows.find((r: any) => r.project_path === gitRepo)
    expect(git.sessions).toBe(2) // an-a + an-c，subagent 不算
    expect(git.cost).toBeGreaterThan(0)
  })
})

describe('项目下钻（成本 vs commit）', () => {
  it('白名单项目返回成本曲线 + commit 计数', async () => {
    const res = await app.request(`/api/analytics/project?path=${encodeURIComponent(gitRepo)}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.daily.length).toBeGreaterThan(0)
    const totalCommits = body.commits.reduce((s: number, c: any) => s + c.n, 0)
    expect(totalCommits).toBe(3)
  })

  it('codex 项目的 metrics 差分也进成本曲线', async () => {
    const res = await app.request(`/api/analytics/project?path=${encodeURIComponent(gitRepo)}`)
    const body = await res.json()
    // 消息 usage（500 out）+ codex metrics 差分（1000 out）= 1500 output tokens
    const total = body.daily.reduce((s: number, d: any) => s + d.output_tokens, 0)
    expect(total).toBe(1500)
  })

  it('非 git 目录降级为空 commits', async () => {
    const res = await app.request(`/api/analytics/project?path=${encodeURIComponent('/data/nogit')}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.commits).toEqual([])
  })

  it('非白名单 path 404', async () => {
    const res = await app.request('/api/analytics/project?path=/etc')
    expect(res.status).toBe(404)
  })
})

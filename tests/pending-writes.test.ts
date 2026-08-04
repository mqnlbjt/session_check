// 待确认写入测试：沉淀两阶段（生成预览 → 确认才落盘）
import { beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'

process.env.SPECTATOR_DB = ':memory:'

let app: Hono
let dbmod: typeof import('../src/db.js')
let persist: typeof import('../src/persist.js')
let projDir = ''

const LESSONS = [
  { detail: '动手前先复述需求确认', evidence: '用户说不对' },
  { detail: '别主动改未点名的文件' },
]

beforeAll(async () => {
  dbmod = await import('../src/db.js')
  app = (await import('../src/server.js')).app
  persist = await import('../src/persist.js')
  projDir = mkdtempSync(join(tmpdir(), 'spect-pending-'))
  dbmod.saveSessionMeta('pi', { sessionId: 'pw-1', projectPath: projDir, startedAt: '2026-08-01T10:00:00Z', title: '沉淀测试' })
})

describe('plan 阶段：只生成不写盘', () => {
  it('planPersist 返回目标路径和预览内容，但不创建文件', () => {
    const plan = persist.planPersist('instructions', 'pi', projDir, '沉淀测试', LESSONS)
    expect(plan).toBeTruthy()
    expect(plan!.filePath).toBe(join(projDir, 'AGENTS.md'))
    expect(plan!.content).toContain('动手前先复述需求确认')
    expect(plan!.content).toContain('别主动改未点名的文件')
    expect(existsSync(plan!.filePath)).toBe(false) // 关键：不写盘
  })

  it('skill 模式预览完整 SKILL.md', () => {
    const plan = persist.planPersist('skill', 'pi', projDir, '沉淀测试', LESSONS)
    expect(plan!.kind).toBe('skill')
    expect(plan!.filePath).toContain('SKILL.md')
    expect(plan!.content).toContain('name: lessons-')
  })
})

describe('待确认写入 API', () => {
  it('创建 → 列表可见（pending）', async () => {
    const plan = persist.planPersist('instructions', 'pi', projDir, '沉淀测试', LESSONS)!
    const id = dbmod.createPendingWrite({ session_id: 'pi:pw-1', kind: plan.kind, target_path: plan.filePath, content: plan.content })
    expect(id).toBeGreaterThan(0)
    const res = await app.request('/api/pending-writes')
    const body = await res.json()
    const row = body.find((r: any) => r.id === id)
    expect(row.status).toBe('pending')
    expect(row.content).toContain('动手前先复述需求确认')
  })

  it('confirm 才真正写盘', async () => {
    const row = dbmod.db.prepare(`SELECT id, target_path FROM pending_writes WHERE status = 'pending' LIMIT 1`).get() as any
    expect(existsSync(row.target_path)).toBe(false)
    const res = await app.request(`/api/pending-writes/${row.id}/confirm`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(existsSync(row.target_path)).toBe(true)
    const content = readFileSync(row.target_path, 'utf8')
    expect(content).toContain('动手前先复述需求确认')
    const after = dbmod.db.prepare(`SELECT status FROM pending_writes WHERE id = ?`).get(row.id) as any
    expect(after.status).toBe('confirmed')
  })

  it('discard 后不再出现', async () => {
    const plan = persist.planPersist('instructions', 'pi', projDir, '沉淀测试2', LESSONS)!
    const id = dbmod.createPendingWrite({ session_id: 'pi:pw-1', kind: plan.kind, target_path: plan.filePath, content: plan.content })
    await app.request(`/api/pending-writes/${id}/discard`, { method: 'POST' })
    const res = await app.request('/api/pending-writes')
    const body = await res.json()
    expect(body.find((r: any) => r.id === id).status).toBe('discarded')
  })

  it('已处理的不能重复 confirm', async () => {
    const row = dbmod.db.prepare(`SELECT id FROM pending_writes WHERE status = 'confirmed' LIMIT 1`).get() as any
    const res = await app.request(`/api/pending-writes/${row.id}/confirm`, { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

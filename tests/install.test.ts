// 安装治理测试（#17）：两阶段落地 + installations 快照 + 一键撤销（可逆）
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'

process.env.SPECTATOR_DB = ':memory:'

let app: Hono
let dbmod: typeof import('../src/db.js')
let inst: typeof import('../src/install.js')

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
let skillProj = '', hookProj = '', skillSugId = 0, hookSugId = 0

function mkRecSug(projectPath: string, evidence: object): number {
  const info = dbmod.db.prepare(
    `INSERT INTO suggestions (project_path, kind, content, evidence, status, created_at) VALUES (?, 'recommendation', '推荐', ?, 'pending', ?)`
  ).run(projectPath, JSON.stringify(evidence), new Date().toISOString())
  return Number(info.lastInsertRowid)
}

beforeAll(async () => {
  dbmod = await import('../src/db.js')
  app = (await import('../src/server.js')).app
  inst = await import('../src/install.js')

  // skill 路由推荐
  skillProj = mkdtempSync(join(tmpdir(), 'spect-inst-s-'))
  skillSugId = mkRecSug(skillProj, {
    category: 'missing-verification', category_label: '测试验证缺失', route: 'skill',
    candidate: { name: 'tdd-workflow', installs: 185000, url: '', description: '' },
  })
  // hook 路由推荐（项目已有 settings.json 旧内容 → 要备份）
  hookProj = mkdtempSync(join(tmpdir(), 'spect-inst-h-'))
  writeFileSync(join(hookProj, '.claude.settings.placeholder'), '')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(hookProj, '.claude'))
  writeFileSync(join(hookProj, '.claude/settings.json'), JSON.stringify({ model: 'opus' }))
  hookSugId = mkRecSug(hookProj, {
    category: 'overreach', category_label: '越权改动', route: 'hook',
    hook_draft: '{"hooks":{"PreToolUse":[{"matcher":"Edit|Write","command":"guard"}]}}',
  })
})

describe('安装（两阶段之「确认后执行」）', () => {
  it('skill 路由：执行安装器，installations 落 active 行（含基线快照），建议转 adopted', async () => {
    const calls: string[] = []
    const fakeInstaller = async (name: string) => { calls.push(name); return { dir: `/fake/skills/${name}` } }
    const r = await inst.installSuggestion(skillSugId, { skillInstaller: fakeInstaller })
    expect(calls).toEqual(['tdd-workflow'])
    expect(r.status).toBe('active')
    expect(r.target_path).toBe('/fake/skills/tdd-workflow')
    const sug = dbmod.db.prepare(`SELECT status, adopted_to FROM suggestions WHERE id = ?`).get(skillSugId) as any
    expect(sug.status).toBe('adopted')
    const row = dbmod.db.prepare(`SELECT * FROM installations WHERE suggestion_id = ?`).get(skillSugId) as any
    expect(row.route).toBe('skill')
    expect(JSON.parse(row.baseline_json)).toHaveProperty('signals_90d')
    expect(JSON.parse(row.baseline_json)).toHaveProperty('per_week')
  })

  it('幂等：同一建议重复安装 → 仍只有一条 installations', async () => {
    const fakeInstaller = async (name: string) => ({ dir: `/fake/skills/${name}` })
    await inst.installSuggestion(skillSugId, { skillInstaller: fakeInstaller })
    const n = dbmod.db.prepare(`SELECT COUNT(*) n FROM installations WHERE suggestion_id = ?`).get(skillSugId) as any
    expect(n.n).toBe(1)
  })

  it('hook 路由：合并写入 settings.json，原内容备份进 installations', async () => {
    const r = await inst.installSuggestion(hookSugId, {})
    expect(r.status).toBe('active')
    const written = JSON.parse(readFileSync(join(hookProj, '.claude/settings.json'), 'utf8'))
    expect(written.model).toBe('opus') // 原配置保留
    expect(written.hooks.PreToolUse.length).toBe(1) // hook 合并进来
    const row = dbmod.db.prepare(`SELECT backup FROM installations WHERE suggestion_id = ?`).get(hookSugId) as any
    expect(JSON.parse(row.backup).model).toBe('opus') // 备份可还原
  })
})

describe('一键撤销（可逆）', () => {
  it('撤销 hook 安装：还原 settings.json 原内容，状态 uninstalled', async () => {
    const row = dbmod.db.prepare(`SELECT id FROM installations WHERE suggestion_id = ?`).get(hookSugId) as any
    const r = await inst.uninstall(row.id, {})
    expect(r.status).toBe('uninstalled')
    const restored = JSON.parse(readFileSync(join(hookProj, '.claude/settings.json'), 'utf8'))
    expect(restored.model).toBe('opus')
    expect(restored.hooks).toBeUndefined()
  })

  it('撤销 skill 安装：调移除器删目录', async () => {
    const removed: string[] = []
    const row = dbmod.db.prepare(`SELECT id FROM installations WHERE suggestion_id = ?`).get(skillSugId) as any
    await inst.uninstall(row.id, { skillRemover: async (dir: string) => { removed.push(dir) } })
    expect(removed).toEqual(['/fake/skills/tdd-workflow'])
    const after = dbmod.db.prepare(`SELECT status FROM installations WHERE id = ?`).get(row.id) as any
    expect(after.status).toBe('uninstalled')
  })

  it('撤销后推荐重新出现为 pending（与 dismissed 区分），且不重复创建', async () => {
    // 撤销时建议已回到 pending（重新出现在改进清单）
    const sug = dbmod.db.prepare(`SELECT status FROM suggestions WHERE id = ?`).get(skillSugId) as any
    expect(sug.status).toBe('pending')
    // 再跑组装不会重复创建（pending 去重），但也不会像 dismissed 那样永远消失
    const { assembleRecommendations } = await import('../src/recommend.js')
    const pk = dbmod.saveSessionMeta('pi', { sessionId: 'inst-s2', projectPath: skillProj, startedAt: daysAgo(3), title: 'S2' })
    dbmod.appendMessage(pk, 1, { role: 'assistant', ts: daysAgo(3), blocks: [{ type: 'tool_call', name: 'edit', input: {} }] })
    dbmod.appendMessage(pk, 2, { role: 'user', ts: daysAgo(3), blocks: [{ type: 'text', text: '不对，又没跑测试' }] })
    dbmod.db.prepare(`UPDATE signals SET root_cause = 'missing-verification' WHERE session_id = 'pi:inst-s2'`).run()
    const r = await assembleRecommendations(skillProj, { searchSkills: async () => ({ name: 'tdd-workflow', installs: 1, url: '', description: '' }) })
    expect(r.created).toBe(0) // 已有 pending，不重复
    const dismissed = dbmod.db.prepare(`SELECT COUNT(*) n FROM suggestions WHERE id = ? AND status = 'dismissed'`).get(skillSugId) as any
    expect(dismissed.n).toBe(0) // 撤销 ≠ 忽略
  })
})

describe('安装 API', () => {
  it('POST install + uninstall 全链路（注入假安装器，不真跑 npx）', async () => {
    const installed: string[] = []
    const removed: string[] = []
    inst.__setSkillHooksForTests(
      async (name: string) => { installed.push(name); return { dir: `/fake/skills/${name}` } },
      async (dir: string) => { removed.push(dir) },
    )
    const sugId = mkRecSug(skillProj, {
      category: 'env-context', category_label: '环境上下文缺失', route: 'skill',
      candidate: { name: 'env-helper', installs: 5, url: '', description: '' },
    })
    const res = await app.request(`/api/harness/suggestions/${sugId}/install`, { method: 'POST' })
    expect(res.status).toBe(200) // 成功路径（此前只断言 not-404，是真 npx 的薛定谔测试——flake 根源）
    expect(installed).toEqual(['env-helper'])
    const list = await (await app.request('/api/harness/installations')).json()
    const active = list.find((x: any) => x.suggestion_id === sugId && x.status === 'active')
    expect(active).toBeTruthy()
    const u = await app.request(`/api/harness/installations/${active.id}/uninstall`, { method: 'POST' })
    expect(u.status).toBe(200)
    expect(removed).toEqual(['/fake/skills/env-helper'])
    inst.__setSkillHooksForTests(null, null)
  })
})

describe('撤销后重装（review 修正回归）', () => {
  it('uninstalled 记录重装：执行安装器并转回 active（不返回旧行）', async () => {
    const sugId = mkRecSug(skillProj, {
      category: 'style-mismatch', category_label: '风格约定不符', route: 'skill',
      candidate: { name: 'style-guide', installs: 3, url: '', description: '' },
    })
    const calls: string[] = []
    const installer = async (name: string) => { calls.push(name); return { dir: `/fake/skills/${name}` } }
    await inst.installSuggestion(sugId, { skillInstaller: installer })
    const row1 = dbmod.db.prepare(`SELECT id FROM installations WHERE suggestion_id = ?`).get(sugId) as any
    await inst.uninstall(row1.id, { skillRemover: async () => {} })
    const r = await inst.installSuggestion(sugId, { skillInstaller: installer })
    expect(calls).toEqual(['style-guide', 'style-guide']) // 真重装了
    expect(r.status).toBe('active')
    expect(r.id).toBe(row1.id) // 复用同一行
    const n = dbmod.db.prepare(`SELECT COUNT(*) n FROM installations WHERE suggestion_id = ?`).get(sugId) as any
    expect(n.n).toBe(1)
  })
})

describe('name 校验（审计 M1/M2）', () => {
  it('flag 注入名（--call=...）被拒绝', async () => {
    const sugId = mkRecSug(skillProj, {
      category: 'tool-gap', category_label: '工具能力缺口', route: 'skill',
      candidate: { name: '--call=echo pwned', installs: 0, url: '', description: '' },
    })
    await expect(inst.installSuggestion(sugId, { skillInstaller: async (n) => ({ dir: `/fake/${n}` }) }))
      .rejects.toThrow(/非法 skill 名/)
  })
  it('路径穿越名（../../x）被拒绝', async () => {
    const sugId = mkRecSug(skillProj, {
      category: 'tool-gap', category_label: '工具能力缺口', route: 'skill',
      candidate: { name: '../../.config', installs: 0, url: '', description: '' },
    })
    await expect(inst.installSuggestion(sugId, { skillInstaller: async (n) => ({ dir: `/fake/${n}` }) }))
      .rejects.toThrow(/非法 skill 名/)
  })
})

describe('AGENTS.md 重新采纳（审计正确性 #2）', () => {
  it('撤销后重新 adopt：installation 行转回 active 且可再次撤销', async () => {
    const harness = await import('../src/harness.js')
    const dir = mkdtempSync(join(tmpdir(), 'spect-readopt-'))
    dbmod.saveSessionMeta('pi', { sessionId: 'ra-1', projectPath: dir, startedAt: daysAgo(1), title: 'RA' })
    const sugId = Number(dbmod.db.prepare(
      `INSERT INTO suggestions (project_path, kind, content, status, created_at) VALUES (?, 'guard_rule', '改前备份原文件', 'pending', ?)`
    ).run(dir, new Date().toISOString()).lastInsertRowid)
    harness.adoptSuggestion(sugId)
    let row = dbmod.db.prepare(`SELECT * FROM installations WHERE suggestion_id = ?`).get(sugId) as any
    expect(row.status).toBe('active')
    await inst.uninstall(row.id, {})
    // 撤销把建议退回 pending → 用户可以重新 adopt
    harness.adoptSuggestion(sugId)
    row = dbmod.db.prepare(`SELECT * FROM installations WHERE suggestion_id = ?`).get(sugId) as any
    expect(row.status).toBe('active') // 修复前：existing 早退，永远是 uninstalled
    expect(row.uninstalled_at).toBeNull()
    // 第二次采纳也能撤销
    const r2 = await inst.uninstall(row.id, {})
    expect(r2.status).toBe('uninstalled')
  })
})

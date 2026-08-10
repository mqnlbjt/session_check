// 安装治理（#17）：两阶段落地（确认才执行）+ installations 快照 + 一键撤销（可逆）
// 边界原则：所有写配置操作由 spectator 执行且可逆——撤销 = 还原备份 / 删除创建的目录
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { db } from './db.js'

export type SkillInstaller = (name: string) => Promise<{ dir: string }>
export type SkillRemover = (dir: string) => Promise<void>
export interface InstallDeps { skillInstaller?: SkillInstaller; skillRemover?: SkillRemover }

// 真实安装器：npx skills add（网络操作，只在用户确认后执行）
const defaultSkillInstaller: SkillInstaller = (name) =>
  new Promise((resolve, reject) => {
    const child = spawn('npx', ['-y', 'skills', 'add', name], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('skill 安装超时（120s）')) }, 120_000)
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`skills add 退出码 ${code}: ${err.slice(-200)}`))
      resolve({ dir: join(homedir(), '.pi/agent/skills', name) })
    })
  }).then((r) => {
    // 纵深防御：目录必须在 skills 根下（校验名之后依然再查一道）
    if (!r.dir.startsWith(join(homedir(), '.pi/agent/skills') + '/')) throw new Error(`路径越界：${r.dir}`)
    if (!existsSync(r.dir)) throw new Error(`安装完成但目录不存在：${r.dir}`)
    return r
  })

const defaultSkillRemover: SkillRemover = async (dir) => {
  rmSync(dir, { recursive: true, force: true })
}

// skill 名白名单（审计 M1/M2）：外部 CLI 输出不可信——防 npx flag 注入（--call=... 即 RCE）
// 与路径穿越（join 归一化 .. 后 rm -rf 会删任意目录）
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i
function assertSkillName(name: string): void {
  if (!SKILL_NAME.test(name)) throw new Error(`非法 skill 名：${name}`)
}

function readSafe(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

// 采纳前基线快照（#18 验证闭环的对比锚点）：该类别 90 天信号数 + 周均
export function snapshotBaseline(projectPath: string, category: string | null): string {
  const since = new Date(Date.now() - 90 * 86400000).toISOString()
  const row = db.prepare(`
    SELECT COUNT(*) n, MIN(sig.ts) first_ts FROM signals sig JOIN sessions s ON s.id = sig.session_id
    WHERE s.project_path = ? AND sig.ts >= ? AND sig.kind = 'correction'
      ${category ? 'AND sig.root_cause = ?' : ''}
  `).get(...(category ? [projectPath, since, category] : [projectPath, since])) as { n: number; first_ts: string | null }
  const spanDays = row.first_ts ? Math.max(1, (Date.now() - new Date(row.first_ts).getTime()) / 86400000) : 1
  const weeks = Math.min(90 / 7, Math.max(1 / 7, spanDays / 7))
  return JSON.stringify({
    category,
    signals_90d: row.n,
    window_start: since,
    weeks: Math.round(weeks * 10) / 10,
    per_week: Math.round((row.n / weeks) * 100) / 100,
  })
}

// hook 草案深合并进 settings.json（hooks.PreToolUse 数组追加去重）
function mergeHookDraft(originalRaw: string | null, draftRaw: string): string {
  const original = originalRaw ? JSON.parse(originalRaw) : {}
  const draft = JSON.parse(draftRaw)
  const merged = { ...original, ...draft }
  if (original.hooks || draft.hooks) {
    merged.hooks = { ...original.hooks, ...draft.hooks }
    for (const key of Object.keys(draft.hooks ?? {})) {
      if (Array.isArray(draft.hooks[key]) && Array.isArray(original.hooks?.[key])) {
        const seen = new Set(original.hooks[key].map((x: unknown) => JSON.stringify(x)))
        merged.hooks[key] = [...original.hooks[key], ...draft.hooks[key].filter((x: unknown) => !seen.has(JSON.stringify(x)))]
      }
    }
  }
  return JSON.stringify(merged, null, 2)
}

const insertInstallation = db.prepare(`
  INSERT INTO installations (suggestion_id, project_path, category, route, artifact, version, target_path, backup, baseline_json, status, installed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
`)

// 安装推荐物（两阶段之「确认后执行」；幂等：active 不重复装；uninstalled 走重装）
export async function installSuggestion(suggestionId: number, deps: InstallDeps = {}): Promise<any> {
  const sug = db.prepare(`SELECT * FROM suggestions WHERE id = ?`).get(suggestionId) as any
  if (!sug) throw new Error('建议不存在')
  const existing = db.prepare(`SELECT * FROM installations WHERE suggestion_id = ?`).get(suggestionId) as any
  if (existing?.status === 'active') return existing // 幂等
  const ev = JSON.parse(sug.evidence ?? '{}')
  const now = new Date().toISOString()
  let targetPath: string, backup: string | null, artifact: string

  if (ev.route === 'skill') {
    if (!ev.candidate?.name) throw new Error('无候选 skill，无法自动安装')
    assertSkillName(ev.candidate.name)
    const installer = deps.skillInstaller ?? defaultSkillInstaller
    const { dir } = await installer(ev.candidate.name)
    targetPath = dir
    backup = null // 目录是新建的，撤销 = 删除
    artifact = ev.candidate.name
  } else if (ev.route === 'hook') {
    if (!ev.hook_draft) throw new Error('无 hook 草案')
    targetPath = join(sug.project_path, '.claude/settings.json')
    backup = readSafe(targetPath)
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, mergeHookDraft(backup, ev.hook_draft))
    artifact = 'PreToolUse-hook'
  } else {
    throw new Error(`路由 ${ev.route} 暂不支持自动安装（MCP 请手动配置）`)
  }

  if (existing) {
    // 撤销后重装：复用行转 active，刷新快照（review 修正：之前直接返回旧行导致装不上）
    db.prepare(`UPDATE installations SET category = ?, route = ?, artifact = ?, version = ?, target_path = ?, backup = ?, baseline_json = ?, status = 'active', installed_at = ?, uninstalled_at = NULL WHERE id = ?`)
      .run(ev.category ?? null, ev.route, artifact, ev.candidate?.version ?? null, targetPath, backup, snapshotBaseline(sug.project_path, ev.category ?? null), now, existing.id)
    db.prepare(`UPDATE suggestions SET status = 'adopted', adopted_to = ? WHERE id = ?`).run(targetPath, suggestionId)
    return db.prepare(`SELECT * FROM installations WHERE id = ?`).get(existing.id) as any
  }

  const info = insertInstallation.run(
    suggestionId, sug.project_path, ev.category ?? null, ev.route, artifact,
    ev.candidate?.version ?? null, targetPath, backup, snapshotBaseline(sug.project_path, ev.category ?? null), now,
  )
  db.prepare(`UPDATE suggestions SET status = 'adopted', adopted_to = ? WHERE id = ?`).run(targetPath, suggestionId)
  return db.prepare(`SELECT * FROM installations WHERE id = ?`).get(Number(info.lastInsertRowid)) as any
}

// 一键撤销：skill 删目录 / hook 与 AGENTS.md 还原备份（原不存在则删除文件）
export async function uninstall(installationId: number, deps: InstallDeps = {}): Promise<any> {
  const row = db.prepare(`SELECT * FROM installations WHERE id = ?`).get(installationId) as any
  if (!row) throw new Error('安装记录不存在')
  if (row.status !== 'active') return row
  if (row.route === 'skill') {
    const remover = deps.skillRemover ?? defaultSkillRemover
    await remover(row.target_path)
  } else {
    // hook / agents-md：还原备份；备份为 null 说明文件是我们创建的，删掉
    if (row.backup === null) rmSync(row.target_path, { force: true })
    else writeFileSync(row.target_path, row.backup)
  }
  db.prepare(`UPDATE installations SET status = 'uninstalled', uninstalled_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), installationId)
  // 对应建议回到 pending，可重新出现在改进清单（撤销 ≠ 忽略）
  if (row.suggestion_id) {
    db.prepare(`UPDATE suggestions SET status = 'pending', adopted_to = NULL WHERE id = ?`).run(row.suggestion_id)
  }
  return db.prepare(`SELECT * FROM installations WHERE id = ?`).get(installationId) as any
}

// AGENTS.md 防呆规则采纳也走 installations（统一已采纳历史 + 可撤销）
// 由 harness.ts adoptSuggestion 在写盘前调用拿备份、写盘后调用落记录
export function backupBeforeWrite(filePath: string): string | null {
  return readSafe(filePath)
}

export function recordAgentsMdAdoption(suggestionId: number, projectPath: string, filePath: string, backup: string | null): void {
  const existing = db.prepare(`SELECT id, status FROM installations WHERE suggestion_id = ?`).get(suggestionId) as any
  if (existing) {
    if (existing.status === 'active') return // 幂等
    // 撤销后重新采纳：复用行转回 active，刷新备份/基线（审计正确性 #2：否则第二次写入无法撤销）
    db.prepare(`UPDATE installations SET target_path = ?, backup = ?, baseline_json = ?, status = 'active', installed_at = ?, uninstalled_at = NULL WHERE id = ?`)
      .run(filePath, backup, snapshotBaseline(projectPath, null), new Date().toISOString(), existing.id)
    return
  }
  insertInstallation.run(
    suggestionId, projectPath, null, 'agents-md', 'guard-rule',
    null, filePath, backup, snapshotBaseline(projectPath, null), new Date().toISOString(),
  )
}

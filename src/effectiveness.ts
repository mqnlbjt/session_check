// 验证闭环（#18）：采纳效果追踪——按根因类别对比采纳前后信号频率，按周归一化
// 原则：只展示不判决。信号下降 ≠ 推荐生效（可能是项目收尾）——效力当信号不当判决
import { db } from './db.js'

export const EFFECT_DISCLAIMER = '信号下降 ≠ 推荐生效（可能是项目收尾）——仅供参考，不做判决'

export type EffectStatus = 'effective' | 'ineffective' | 'observing' | 'uninstalled'

export interface EffectReport {
  id: number
  artifact: string
  category: string | null
  status: EffectStatus
  baseline_per_week: number
  post_per_week: number
  signals_after: number
  days: number
  disclaimer: string
}

const MIN_JUDGE_DAYS = 30 // 不足 30 天不判决（观察中）
const EFFECTIVE_THRESHOLD = 0.5 // 采纳后周均信号低于基线的 50% 才标「生效中」

export function evaluate(installationId: number): EffectReport {
  const row = db.prepare(`SELECT * FROM installations WHERE id = ?`).get(installationId) as any
  if (!row) throw new Error('安装记录不存在')
  const baseline = JSON.parse(row.baseline_json ?? '{}')
  const category = row.category ?? baseline.category ?? null
  const days = (Date.now() - new Date(row.installed_at).getTime()) / 86400000

  // 采纳后的同类信号（agents-md 采纳无类别 → 看全部 correction）
  const after = db.prepare(`
    SELECT COUNT(*) n FROM signals sig JOIN sessions s ON s.id = sig.session_id
    WHERE s.project_path = ? AND sig.ts > ? AND sig.kind = 'correction'
      ${category ? 'AND sig.root_cause = ?' : ''}
  `).get(...(category ? [row.project_path, row.installed_at, category] : [row.project_path, row.installed_at])) as { n: number }

  const weeks = Math.max(days / 7, 1 / 7)
  const postPerWeek = Math.round((after.n / weeks) * 100) / 100
  const baselinePerWeek = baseline.per_week ?? 0

  let status: EffectStatus
  if (row.status === 'uninstalled') status = 'uninstalled'
  else if (days < MIN_JUDGE_DAYS || baselinePerWeek === 0) status = 'observing'
  else status = postPerWeek < baselinePerWeek * EFFECTIVE_THRESHOLD ? 'effective' : 'ineffective'

  return {
    id: row.id, artifact: row.artifact, category, status,
    baseline_per_week: baselinePerWeek, post_per_week: postPerWeek,
    signals_after: after.n, days: Math.floor(days),
    disclaimer: EFFECT_DISCLAIMER,
  }
}

export function evaluateAll(): EffectReport[] {
  const rows = db.prepare(`SELECT id FROM installations ORDER BY installed_at DESC LIMIT 100`).all() as { id: number }[]
  return rows.map((r) => evaluate(r.id))
}

// 未生效类别集合（#16 组装时降权：不再推荐同类）
export function ineffectiveCategories(projectPath: string): Set<string> {
  const rows = db.prepare(
    `SELECT id FROM installations WHERE project_path = ? AND status = 'active' AND category IS NOT NULL`
  ).all(projectPath) as { id: number }[]
  const set = new Set<string>()
  for (const r of rows) {
    const e = evaluate(r.id)
    if (e.status === 'ineffective' && e.category) set.add(e.category)
  }
  return set
}

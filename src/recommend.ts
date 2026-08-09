// 推荐物组装（#16）：分类(#14) → 静态确认(#15) → 推荐物路由 → pending 推荐落库
// 推荐物三家：skill（skills.sh 搜索，网络仅在此手动链路）/ hook（按类别模板草案）/ MCP（缺口提示）
import { spawn } from 'node:child_process'
import { db } from './db.js'
import { ROOT_CAUSES } from './root-causes.js'
import { classifyRootCauses } from './root-causes.js'
import { verifyProject } from './static-checks.js'
import { defaultLlm, type LlmFn } from './harness.js'

export interface SkillCandidate { name: string; installs: number; url: string; description: string }
export type SearchSkillsFn = (query: string) => Promise<SkillCandidate>

// 真实搜索：npx skills find（网络操作，只在用户点「生成建议」的手动链路里跑）
const defaultSearchSkills: SearchSkillsFn = (query) =>
  new Promise((resolve, reject) => {
    const child = spawn('npx', ['-y', 'skills', 'find', query], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('skills 搜索超时（60s）')) }, 60_000)
    child.stdout.on('data', (d) => { out += d })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`skills find 退出码 ${code}`))
      // 粗解析：第一行当名称，全文截 300 字当描述；安装量从文本里捞数字
      const lines = out.trim().split('\n').filter(Boolean)
      const installs = Number(out.match(/([\d,]+)\s*(installs?|安装)/i)?.[1].replace(/,/g, '')) || 0
      resolve({ name: lines[0]?.slice(0, 80) || query, installs, url: '', description: out.slice(0, 300) })
    })
  })

// hook 类别模板草案（#17 两阶段预览时展示目标内容）
const HOOK_TEMPLATES: Record<string, string> = {
  overreach: `{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Edit|Write|MultiEdit",
      "command": "node -e \\"const p=process.argv[1];const protected=['docs/','README.md'];if(protected.some(x=>p.includes(x))){console.error('受保护路径，需用户确认');process.exit(2)}\\""
    }]
  }
}`,
}

export interface AssembleDeps { searchSkills?: SearchSkillsFn; llm?: LlmFn }

// 已存在（pending/dismissed）的推荐类别——去重闭环：dismissed 不回来
function existingCategories(projectPath: string): Set<string> {
  const rows = db.prepare(
    `SELECT evidence FROM suggestions WHERE project_path = ? AND kind = 'recommendation' AND status IN ('pending', 'dismissed')`
  ).all(projectPath) as { evidence: string }[]
  const set = new Set<string>()
  for (const r of rows) {
    try { set.add(JSON.parse(r.evidence).category) } catch { /* 跳过 */ }
  }
  return set
}

export async function assembleRecommendations(
  projectPath: string,
  deps: AssembleDeps = {},
): Promise<{ created: number; categories: string[] }> {
  const search = deps.searchSkills ?? defaultSearchSkills
  // ① 分类（幂等：已分类的不重跑）② 静态确认（upsert）
  await classifyRootCauses(projectPath, deps.llm ?? defaultLlm)
  const { results } = verifyProject(projectPath)

  const existing = existingCategories(projectPath)
  const insert = db.prepare(
    `INSERT INTO suggestions (project_path, kind, content, evidence, status, created_at) VALUES (?, 'recommendation', ?, ?, 'pending', ?)`
  )
  const now = new Date().toISOString()
  const created: string[] = []

  for (const v of results) {
    if (!v.recommendable || existing.has(v.category)) continue
    const cat = ROOT_CAUSES.find((c) => c.id === v.category)
    if (!cat) continue

    // 证据：该类别的信号样本
    const signals = db.prepare(`
      SELECT sig.rule, sig.snippet, sig.confirmation FROM signals sig
      JOIN sessions s ON s.id = sig.session_id
      WHERE s.project_path = ? AND sig.root_cause = ? AND sig.snippet IS NOT NULL
      ORDER BY sig.ts DESC LIMIT 3
    `).all(projectPath, v.category)

    // 推荐物路由
    let candidate: SkillCandidate | null = null
    let hook_draft: string | null = null
    let mcp_hint: string | null = null
    if (cat.route === 'skill') {
      try { candidate = await search(cat.searchTerms.join(' ')) } catch { candidate = null } // 搜索失败降级「仅根因诊断」
    } else if (cat.route === 'hook') {
      hook_draft = HOOK_TEMPLATES[v.category] ?? null
    } else {
      mcp_hint = `按缺口方向搜索并配置 MCP：${cat.searchTerms.join(' / ')}`
    }

    const recText = candidate
      ? `推荐安装 skill「${candidate.name}」${candidate.installs ? `（${(candidate.installs / 10000).toFixed(1)}万 安装）` : ''}`
      : hook_draft ? '推荐配置防护 hook（预览见证据链）'
      : mcp_hint ?? `建议按搜索词「${cat.searchTerms.join(' / ')}」自选推荐物安装`
    const content = `根因「${cat.label}」：纠正信号 + 静态确认防护缺失。${recText}`

    insert.run(projectPath, content, JSON.stringify({
      category: v.category,
      category_label: cat.label,
      route: cat.route,
      signals,
      checks: v.checks,
      search_terms: cat.searchTerms,
      candidate,
      hook_draft,
      mcp_hint,
    }), now)
    created.push(v.category)
  }
  return { created: created.length, categories: created }
}

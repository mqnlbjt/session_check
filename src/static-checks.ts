// 静态确认检查器（#15）：按根因类别的 checks[].kind 解释执行确定性检查
// 全部检查无 LLM、无网络——文件系统 + 本地 db，秒级完成
// 判定逻辑：1 次纠正 + 防护缺失 = 可推荐；已有防护 = 降权（疑似误报或已解决）
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { db } from './db.js'
import { ROOT_CAUSES } from './root-causes.js'

export type CheckStatus = 'present' | 'missing' | 'unknown'
export interface CheckResult { kind: string; desc: string; status: CheckStatus; detail: string }
export interface CategoryVerdict {
  category: string
  verdict: 'confirmed-gap' | 'already-protected' | 'unknown'
  recommendable: boolean
  checks: CheckResult[]
}

function readSafe(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

// 项目的 agent 指令文件（AGENTS.md / CLAUDE.md）内容拼接
function instructionsText(projectPath: string): string {
  return ['AGENTS.md', 'CLAUDE.md'].map((f) => readSafe(join(projectPath, f)) ?? '').join('\n')
}

// 已安装 skill 清单（user 级 + 项目级，三家 agent 常见位置）
function installedSkillDirs(projectPath: string): string[] {
  const home = homedir()
  const dirs = [
    join(home, '.pi/agent/skills'), join(home, '.claude/skills'),
    join(projectPath, '.pi/skills'), join(projectPath, '.claude/skills'),
  ]
  const out: string[] = []
  for (const d of dirs) {
    try { out.push(...readdirSync(d)) } catch { /* 目录不存在 */ }
  }
  return out
}

// 已配置 MCP server 名（pi 与 claude 两家的 user 级配置）
function installedMcpNames(): string[] {
  const home = homedir()
  const out: string[] = []
  for (const f of [join(home, '.pi/agent/mcp.json'), join(home, '.claude.json')]) {
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8'))
      out.push(...Object.keys(raw.mcpServers ?? {}))
    } catch { /* 配置不存在或解析失败 */ }
  }
  return out
}

// 搜索词首词子串匹配（粗糙但确定性——取首词是因为搜索词多为 "mcp server" 类短语）
function matchesKeyword(candidates: string[], keywords: string[]): string | undefined {
  return candidates.find((c) => keywords.some((k) => c.toLowerCase().includes(k.split(' ')[0].toLowerCase())))
}

const TEST_CMD = /\b(test|tests|pytest|vitest|jest|mocha|go test|cargo test|phpunit)\b/

// ---- 各检查项实现：present = 防护已存在，missing = 防护缺失，unknown = 判不了 ----
const CHECK_RUNNERS: Record<string, (projectPath: string, keywords: string[]) => { status: CheckStatus; detail: string }> = {}

function defineCheck(kind: string, fn: (projectPath: string, keywords: string[]) => { status: CheckStatus; detail: string }) {
  CHECK_RUNNERS[kind] = fn
}

defineCheck('test-framework', (p) => {
  if (!existsSync(p)) return { status: 'unknown', detail: '项目目录不可读' }
  const pkg = readSafe(join(p, 'package.json'))
  if (pkg) {
    try {
      const j = JSON.parse(pkg)
      const script = j.scripts?.test ?? ''
      if (script && !/no test specified/.test(script)) return { status: 'present', detail: `test 脚本：${script}` }
      const devDeps = Object.keys({ ...j.devDependencies, ...j.dependencies })
      const fw = devDeps.find((d) => /^(vitest|jest|mocha|ava|tap)$/.test(d))
      if (fw) return { status: 'present', detail: `测试框架依赖：${fw}` }
    } catch { /* 解析失败继续查其他标志 */ }
  }
  for (const f of ['pytest.ini', 'pyproject.toml', 'go.mod', 'Cargo.toml']) {
    if (existsSync(join(p, f))) return { status: 'present', detail: `存在 ${f}` }
  }
  return { status: 'missing', detail: '无 test 脚本/测试框架声明' }
})

defineCheck('test-command-ratio', (p) => {
  const since = new Date(Date.now() - 90 * 86400000).toISOString()
  const rows = db.prepare(`
    SELECT m.blocks_json FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE s.project_path = ? AND m.role = 'assistant' AND m.ts >= ?
  `).all(p, since) as { blocks_json: string }[]
  let bash = 0, test = 0
  for (const r of rows) {
    try {
      for (const b of JSON.parse(r.blocks_json) as { type: string; name?: string; input?: unknown }[]) {
        if (b.type === 'tool_call' && b.name && /bash|shell|exec/i.test(b.name)) {
          bash++
          const cmd = typeof b.input === 'object' && b.input ? JSON.stringify(b.input) : ''
          if (TEST_CMD.test(cmd)) test++
        }
      }
    } catch { /* 跳过解析失败 */ }
  }
  const ratio = bash ? test / bash : 0
  return ratio >= 0.05
    ? { status: 'present', detail: `测试命令占比 ${(ratio * 100).toFixed(1)}%（${test}/${bash}）` }
    : { status: 'missing', detail: `测试命令占比 ${(ratio * 100).toFixed(1)}%（${test}/${bash}）` }
})

defineCheck('hook-config', (p) => {
  if (!existsSync(p)) return { status: 'unknown', detail: '项目目录不可读' }
  for (const f of ['.claude/settings.json', '.claude/settings.local.json', '.pi/settings.json']) {
    const raw = readSafe(join(p, f))
    if (raw && /PreToolUse|pre_tool_use|hooks/i.test(raw)) return { status: 'present', detail: `${f} 含 hook 配置` }
  }
  return { status: 'missing', detail: '无 hook 配置文件' }
})

defineCheck('protected-paths', (p) => {
  if (!existsSync(p)) return { status: 'unknown', detail: '项目目录不可读' }
  const text = instructionsText(p)
  return /受保护|不要改|勿改|别改|protected/i.test(text)
    ? { status: 'present', detail: '指令文件含受保护路径声明' }
    : { status: 'missing', detail: '无受保护路径声明' }
})

defineCheck('clarify-skill', (p) => {
  const skills = installedSkillDirs(p)
  const hit = skills.find((s) => /ask|clarify|grill|question|interview/i.test(s))
  return hit ? { status: 'present', detail: `已装澄清类 skill：${hit}` } : { status: 'missing', detail: '无澄清类 skill' }
})

defineCheck('requirement-rule', (p) => {
  const text = instructionsText(p)
  return /复述|确认需求|先问|clarify|confirm.*requirement/i.test(text)
    ? { status: 'present', detail: '指令文件含需求确认规则' }
    : { status: 'missing', detail: '无需求确认规则' }
})

defineCheck('installed-mcp', (_p, keywords) => {
  const names = installedMcpNames()
  const hit = matchesKeyword(names, keywords)
  return hit ? { status: 'present', detail: `已配置 MCP：${hit}` } : { status: 'missing', detail: `无相关 MCP（已配置：${names.join(', ') || '无'}）` }
})

defineCheck('installed-skills', (p, keywords) => {
  const skills = installedSkillDirs(p)
  const hit = matchesKeyword(skills, keywords)
  return hit ? { status: 'present', detail: `已装相关 skill：${hit}` } : { status: 'missing', detail: '无相关 skill' }
})

defineCheck('agents-md-style', (p) => {
  const text = instructionsText(p)
  return /风格|约定|命名|提交信息|style|convention|commit/i.test(text)
    ? { status: 'present', detail: '指令文件含风格约定' }
    : { status: 'missing', detail: '无风格约定' }
})

defineCheck('lint-config', (p) => {
  if (!existsSync(p)) return { status: 'unknown', detail: '项目目录不可读' }
  const files = ['.eslintrc', '.eslintrc.json', '.prettierrc', '.prettierrc.json', 'biome.json', '.editorconfig', 'eslint.config.js']
  const hit = files.find((f) => existsSync(join(p, f)))
  return hit ? { status: 'present', detail: `存在 ${hit}` } : { status: 'missing', detail: '无 lint/格式化配置' }
})

defineCheck('env-docs', (p) => {
  if (!existsSync(p)) return { status: 'unknown', detail: '项目目录不可读' }
  const files = ['CONTEXT.md', 'README.md', 'README.zh-CN.md', 'DEPLOY.md']
  const hit = files.find((f) => {
    const raw = readSafe(join(p, f))
    return raw && /部署|环境|服务器|凭据|deploy|server|environment|credential/i.test(raw)
  })
  return hit ? { status: 'present', detail: `${hit} 含环境/部署内容` } : { status: 'missing', detail: '无环境/部署文档' }
})

defineCheck('env-agents-md', (p) => {
  const text = instructionsText(p)
  return /环境|部署|服务器|路径|deploy|server/i.test(text)
    ? { status: 'present', detail: '指令文件含环境事实' }
    : { status: 'missing', detail: '指令文件无环境事实' }
})

export function runCheck(kind: string, projectPath: string, keywords: string[] = []): CheckResult {
  const runner = CHECK_RUNNERS[kind]
  const desc = ROOT_CAUSES.flatMap((c) => c.checks).find((c) => c.kind === kind)?.desc ?? kind
  if (!runner) return { kind, desc, status: 'unknown', detail: '未实现的检查项' }
  try {
    const r = runner(projectPath, keywords)
    return { kind, desc, status: r.status, detail: r.detail }
  } catch (e) {
    return { kind, desc, status: 'unknown', detail: `检查异常：${(e as Error).message}` }
  }
}

// 类别级判定：任一检查 present → 已有防护（降权）；有 unknown 无 present → unknown；全 missing → 防护缺失（可推荐）
export function verifyCategory(categoryId: string, projectPath: string): CategoryVerdict {
  const cat = ROOT_CAUSES.find((c) => c.id === categoryId)
  const checks = (cat?.checks ?? []).map((c) => runCheck(c.kind, projectPath, cat?.searchTerms ?? []))
  const has = (s: CheckStatus) => checks.some((c) => c.status === s)
  const verdict: CategoryVerdict['verdict'] = has('present') ? 'already-protected' : has('unknown') ? 'unknown' : 'confirmed-gap'
  return { category: categoryId, verdict, recommendable: verdict === 'confirmed-gap', checks }
}

// 项目级验证：跑该项目已分类根因的全部检查，结果 upsert 落库
export function verifyProject(projectPath: string): { results: CategoryVerdict[] } {
  const cats = db.prepare(`
    SELECT DISTINCT sig.root_cause c FROM signals sig JOIN sessions s ON s.id = sig.session_id
    WHERE s.project_path = ? AND sig.root_cause IS NOT NULL AND sig.root_cause != 'other'
  `).all(projectPath) as { c: string }[]
  const upsert = db.prepare(`
    INSERT INTO verifications (project_path, category, verdict, checks_json, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_path, category) DO UPDATE SET verdict = excluded.verdict, checks_json = excluded.checks_json, created_at = excluded.created_at
  `)
  const now = new Date().toISOString()
  const results = cats.map(({ c }) => {
    const v = verifyCategory(c, projectPath)
    upsert.run(projectPath, c, v.verdict, JSON.stringify(v.checks), now)
    return v
  })
  return { results }
}

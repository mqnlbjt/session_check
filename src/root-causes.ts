// 根因分类体系（#14）：封闭枚举 + LLM 选择题分类器
// 每个类别绑定三件资产：①验证检查项（#15 静态确认）②skills 搜索词（#16 推荐物搜索）③推荐物类型路由
import { db } from './db.js'
import { defaultLlm, dominantAgent, extractJsonArray, type LlmFn } from './harness.js'

export interface RootCause {
  id: string
  label: string
  description: string
  checks: { kind: string; desc: string }[]   // #15 按 kind 解释执行
  searchTerms: string[]                       // #16 skills 搜索用
  route: 'hook' | 'skill' | 'mcp'             // 推荐物类型路由
}

// 封闭枚举 6+1：LLM 只做选择题不做创作，分不进的进 other
export const ROOT_CAUSES: RootCause[] = [
  {
    id: 'misunderstanding', label: '需求理解偏差',
    description: 'agent 理解错用户意图，做的不是用户要的',
    checks: [
      { kind: 'clarify-skill', desc: '需求澄清类 skill（提问对齐流程）' },
      { kind: 'requirement-rule', desc: 'AGENTS.md 有需求确认类规则' },
    ],
    searchTerms: ['requirement clarification', 'ask user questions'],
    route: 'skill',
  },
  {
    id: 'overreach', label: '越权改动',
    description: 'agent 改了用户没让改的文件/配置/范围',
    checks: [
      { kind: 'hook-config', desc: 'PreToolUse 类防护 hook 配置' },
      { kind: 'protected-paths', desc: '受保护路径声明' },
    ],
    searchTerms: ['file protection hook', 'guard rails'],
    route: 'hook',
  },
  {
    id: 'missing-verification', label: '测试验证缺失',
    description: 'agent 改完不验证（不跑测试/不看报错就说完成）',
    checks: [
      { kind: 'test-framework', desc: '项目测试框架声明' },
      { kind: 'test-command-ratio', desc: '测试命令占比' },
    ],
    searchTerms: ['tdd', 'test driven development'],
    route: 'skill',
  },
  {
    id: 'tool-gap', label: '工具能力缺口',
    description: '缺少工具/数据源访问能力导致的失败（查不了、连不上、没有 API）',
    checks: [
      { kind: 'installed-mcp', desc: '相关 MCP server' },
      { kind: 'installed-skills', desc: '相关 skill' },
    ],
    searchTerms: ['mcp server'],
    route: 'mcp',
  },
  {
    id: 'style-mismatch', label: '风格约定不符',
    description: '代码风格/提交信息/文档格式不合项目约定',
    checks: [
      { kind: 'agents-md-style', desc: 'AGENTS.md 风格约定覆盖' },
      { kind: 'lint-config', desc: 'lint/格式化配置文件' },
    ],
    searchTerms: ['code style conventions'],
    route: 'skill',
  },
  {
    id: 'env-context', label: '环境上下文缺失',
    description: 'agent 不知道环境事实（路径/依赖/部署方式/凭据位置）',
    checks: [
      { kind: 'env-docs', desc: '环境/部署文档（CONTEXT.md、README 部署节）' },
      { kind: 'env-agents-md', desc: 'AGENTS.md 环境事实覆盖' },
    ],
    searchTerms: ['project context', 'environment setup'],
    route: 'mcp',
  },
  { id: 'other', label: '其他', description: '分不进上述类别的', checks: [], searchTerms: [], route: 'skill' },
]

const VALID_IDS = new Set(ROOT_CAUSES.map((c) => c.id))

interface Unclassified { id: number; rule: string; snippet: string | null }

// 待分类信号：90 天窗口内、未分类的 correction。
// 确认口径：只排除 likely-noise（明确噪声）；confirmed/unconfirmed 都是真实痛点（强弱证据），
// NULL = 老库未跑回填，视同可参与（推荐置信度在 #15/#16 再消费 confirmation 分级）
function unclassifiedSignals(projectPath: string, limit = 30): Unclassified[] {
  const since = new Date(Date.now() - 90 * 86400000).toISOString()
  return db.prepare(`
    SELECT sig.id, sig.rule, sig.snippet FROM signals sig
    JOIN sessions s ON s.id = sig.session_id
    WHERE s.project_path = ? AND sig.kind = 'correction' AND sig.root_cause IS NULL
      AND (sig.confirmation IS NULL OR sig.confirmation != 'likely-noise')
      AND sig.ts >= ?
    ORDER BY sig.ts DESC LIMIT ?
  `).all(projectPath, since, limit) as Unclassified[]
}

function buildPrompt(projectPath: string, signals: Unclassified[]): string {
  const cats = ROOT_CAUSES.map((c) => `- ${c.id}（${c.label}）：${c.description}`).join('\n')
  const sigs = signals.map((s) => `- id=${s.id} 「${s.rule}」：${s.snippet ?? ''}`).join('\n')
  return `你在对 coding agent 被用户纠正的信号做根因分类。项目 ${projectPath}。
你没有任何工具可用——禁止探查项目文件，只根据下面给出的信号文本判断。

根因类别（封闭枚举，只能选这些 id）：
${cats}

待分类信号：
${sigs}

对每条信号判断根因类别。只输出 JSON 数组，不要调用工具、不要输出任何其他内容：
[{"id": 信号id, "category": "类别id", "confidence": 0.0-1.0}]`
}

// 从输出提取分类数组（容错抗噪音：复用 extractJsonArray；非法类别归 other）
export function parseClassification(text: string, validIds: Set<string> = VALID_IDS): { id: number; category: string; confidence: number }[] {
  const arr = extractJsonArray(text)
  if (!arr) return []
  return arr
    .filter((x): x is { id: number; category: string; confidence?: unknown } =>
      typeof x === 'object' && x !== null && typeof (x as any).id === 'number' && typeof (x as any).category === 'string')
    .map((x) => ({
      id: x.id,
      category: validIds.has(x.category) ? x.category : 'other',
      confidence: Math.max(0, Math.min(1, Number(x.confidence) || 0)),
    }))
}

// 手动触发的根因分类：已确认信号 → LLM 选择题 → 落库（幂等：只送未分类的）
export async function classifyRootCauses(projectPath: string, llm: LlmFn = defaultLlm): Promise<{ classified: number; byCategory: Record<string, number> }> {
  const signals = unclassifiedSignals(projectPath)
  if (!signals.length) return { classified: 0, byCategory: {} }
  const out = await llm(dominantAgent(projectPath), buildPrompt(projectPath, signals))
  const results = parseClassification(out)
  const update = db.prepare(`UPDATE signals SET root_cause = ?, cause_confidence = ? WHERE id = ? AND root_cause IS NULL`)
  const byCategory: Record<string, number> = {}
  let classified = 0
  for (const r of results) {
    if (update.run(r.category, r.confidence, r.id).changes > 0) {
      classified++
      byCategory[r.category] = (byCategory[r.category] ?? 0) + 1
    }
  }
  return { classified, byCategory }
}

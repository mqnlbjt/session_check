// 危险操作/敏感信息规则库：在 ingest 时对每条消息实时过，命中落 risks 表
// 纯正则，确定性优先；宁缺毋滥，误报多了规则就失去了意义

import type { Block } from './model.js'

export interface RiskHit {
  rule: string
  severity: 'high' | 'medium'
  snippet: string
}

interface Rule {
  id: string
  severity: 'high' | 'medium'
  pattern: RegExp
  // 命中文本的截取长度
  snip?: number
}

// 命令执行类工具才过命令规则
const COMMAND_TOOLS = /^(bash|shell|execute|run|exec|terminal|sh)$/i

const COMMAND_RULES: Rule[] = [
  { id: 'rm-rf-root', severity: 'high', pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)?(-[a-zA-Z]*\s+)?(\/|~|\$HOME)(\/|\s|$)/ },
  { id: 'rm-rf', severity: 'medium', pattern: /\brm\s+-[a-zA-Z]*[rf]/ },
  { id: 'curl-pipe-sh', severity: 'high', pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/ },
  { id: 'git-push-force', severity: 'medium', pattern: /\bgit\s+push\b[^;&]*\s(-f\b|--force\b)/ },
  { id: 'write-ssh', severity: 'high', pattern: />\s*~?\/?\.ssh\/|cp\s+\S+\s+~?\/?\.ssh\// },
  { id: 'dd-disk', severity: 'high', pattern: /\bdd\b[^;&]*\bof=\/dev\// },
  { id: 'chmod-777', severity: 'medium', pattern: /\bchmod\s+(-R\s+)?777\b/ },
  { id: 'env-secret-leak', severity: 'high', pattern: /\b(curl|wget)\b[^;&]*(Authorization|api[-_]?key|token)[^;&]*\$\{?[A-Z_]*(KEY|TOKEN|SECRET)/i },
]

// 密钥模式：对所有文本/输出生效
const SECRET_RULES: Rule[] = [
  { id: 'openai-key', severity: 'high', pattern: /\bsk-[a-zA-Z0-9_-]{20,}\b/, snip: 12 },
  { id: 'github-pat', severity: 'high', pattern: /\b(ghp|github_pat)_[a-zA-Z0-9_]{20,}\b/, snip: 16 },
  { id: 'aws-akid', severity: 'high', pattern: /\bAKIA[0-9A-Z]{16}\b/, snip: 10 },
  { id: 'private-key', severity: 'high', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, snip: 30 },
]

function cut(s: string, n = 60): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, n)
}

export function scanBlocks(blocks: Block[]): RiskHit[] {
  const hits: RiskHit[] = []
  for (const b of blocks) {
    if (b.type === 'tool_call' && b.name && COMMAND_TOOLS.test(b.name)) {
      const cmd = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? '')
      for (const r of COMMAND_RULES) {
        const m = cmd.match(r.pattern)
        if (m) hits.push({ rule: r.id, severity: r.severity, snippet: cut(m[0] === m.input ? m[0] : cmd) })
      }
    }
    // 密钥扫描：工具入参、文本、工具输出都可能含密钥
    const text = b.type === 'tool_call'
      ? (typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? ''))
      : b.text ?? b.output ?? ''
    if (!text) continue
    for (const r of SECRET_RULES) {
      const m = text.match(r.pattern)
      if (m) hits.push({ rule: r.id, severity: r.severity, snippet: cut(m[0], r.snip ?? 60) + '…' })
    }
  }
  // 同一条消息内同规则只记一次
  const seen = new Set<string>()
  return hits.filter((h) => {
    const k = h.rule + h.snippet
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

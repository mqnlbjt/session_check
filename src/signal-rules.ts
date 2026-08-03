// 返工信号规则库：只扫 role=user 的 text block，识别用户纠正/挫折语句
// 纯正则确定性优先；误报控制策略：宁缺毋滥，词表按真实库回填抽查结果调整

export type SignalKind = 'correction' | 'frustration'

export interface SignalHit {
  rule: string
  kind: SignalKind
  snippet: string
}

interface SignalRule {
  id: string
  kind: SignalKind
  pattern: RegExp
}

// 纠正类：用户明确指出 agent 做错了/要重做 → 计入会话质量分
const CORRECTION_RULES: SignalRule[] = [
  { id: 'wrong', kind: 'correction', pattern: /不对|错了|搞错|弄错/ },
  { id: 'redo', kind: 'correction', pattern: /重来|重新(来|做|写|弄|搞)|从头/ },
  { id: 'not-what-i-said', kind: 'correction', pattern: /我不是说|我的意思是|你理解错|理解错了|会错意/ },
  { id: 'stop-change', kind: 'correction', pattern: /别改|不要改|撤销|回退|还原/ },
  { id: 'why-did-you', kind: 'correction', pattern: /谁让你|你为什么|怎么把.*(改|删)/ },
]

// 挫折类：用户表达沮丧但不一定指明返工 → 单独标记，不计入质量分
const FRUSTRATION_RULES: SignalRule[] = [
  { id: 'again', kind: 'frustration', pattern: /怎么又|又挂了|又错了|又失败/ },
  { id: 'still-broken', kind: 'frustration', pattern: /还是不行|还是错|仍然(不|没)/ },
  { id: 'give-up', kind: 'frustration', pattern: /算了|当我没说/ },
]

const ALL_RULES = [...CORRECTION_RULES, ...FRUSTRATION_RULES]

function cut(s: string, n = 60): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, n)
}

// 机器生成的 user 消息（subagent 任务书、会话续接摘要）不是人类纠正，过滤掉
const MACHINE_MARKERS = /(delegated subagent|being continued from a previous|parent-orchestrated|task\.md|^<file name=|^Task:\s|^\[SUGGESTION MODE)/i
export function isMachineUserText(text: string): boolean {
  return MACHINE_MARKERS.test(text.slice(0, 500))
}

// 输入为 user 消息的 text blocks 拼接文本
export function scanSignals(text: string): SignalHit[] {
  if (isMachineUserText(text)) return []
  const hits: SignalHit[] = []
  for (const r of ALL_RULES) {
    const m = text.match(r.pattern)
    if (m) hits.push({ rule: r.id, kind: r.kind, snippet: cut(text) })
  }
  return hits
}

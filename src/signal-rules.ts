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

// 截取匹配点前后上下文（前 40 字 + 命中 + 后 40 字），让 LLM 看到纠正发生的语境（#12 P2）
const SNIPPET_CTX = 40
function cutAround(s: string, idx: number, matchLen: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  // 空白压缩后索引会漂移，简化处理：短文本直接返回，长文本按原始索引近似截取
  if (flat.length <= SNIPPET_CTX * 2 + matchLen + 10) return flat
  const start = Math.max(0, idx - SNIPPET_CTX)
  const end = Math.min(s.length, idx + matchLen + SNIPPET_CTX)
  const core = s.slice(start, end).replace(/\s+/g, ' ').trim()
  return (start > 0 ? '…' : '') + core + (end < s.length ? '…' : '')
}

// 机器生成的 user 消息（subagent 任务书、会话续接摘要）不是人类纠正，过滤掉
const MACHINE_MARKERS = /(delegated subagent|being continued from a previous|parent-orchestrated|task\.md|^<file name=|^Task:\s|^\[SUGGESTION MODE|^你是.{2,20}(专家|工程师|顾问|助手))/i
export function isMachineUserText(text: string): boolean {
  return MACHINE_MARKERS.test(text.slice(0, 500))
}

// 第一人称纠错（"我搞错了"）是用户在纠正事实/自己，不是在纠正 agent（#12 P3）
// 全文启发式：有第一人称认错、且没有指向 agent 的指责时，correction 不记
// ⚠️ BLAMES_AGENT 与 CORRECTION_RULES 共享领域词汇——调整任一词表时同步检查另一处
const FIRST_PERSON_FAULT = /我(的)?(搞错|弄错|记错|错)(?!觉)/
const BLAMES_AGENT = /你.{0,3}(错|不对)|改错|别改|回退|撤销/

// 输入为 user 消息的 text blocks 拼接文本
export function scanSignals(text: string): SignalHit[] {
  if (isMachineUserText(text)) return []
// 第一人称认错且没有指责 agent 时，correction 全不记（用户在纠正自己/事实，不是 agent 的锅）
  const selfFault = FIRST_PERSON_FAULT.test(text) && !BLAMES_AGENT.test(text)
  const hits: SignalHit[] = []
  for (const r of ALL_RULES) {
    if (selfFault && r.kind === 'correction') continue
    const m = text.match(r.pattern)
    if (m) hits.push({ rule: r.id, kind: r.kind, snippet: cutAround(text, m.index ?? 0, m[0].length) })
  }
  return hits
}

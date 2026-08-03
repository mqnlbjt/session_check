// api_error / reasoning 历史回填：重解析全部 sources，把失败标记和推理 token 补到已入库消息
// （pi: stopReason=error + usage.reasoning；claude: isApiErrorMessage；codex: 无可靠记录，跳过）
import { readFileSync } from 'node:fs'
import { db } from './db.js'
import { createPiParser } from './parsers/pi.js'
import { createClaudeParser } from './parsers/claude.js'

const factories: Record<string, (ctx: { filePath: string }) => (line: any) => any> = {
  pi: createPiParser,
  claude: createClaudeParser,
}

export function backfillApiStats(): { files: number; errors: number; reasoning: number } {
  const sources = db.prepare(`SELECT path, agent, session_id FROM sources WHERE agent IN ('pi', 'claude')`).all() as { path: string; agent: string; session_id: string }[]
  const markError = db.prepare(`UPDATE messages SET api_error = 1 WHERE session_id = ? AND event_id = ?`)
  const setReasoning = db.prepare(`UPDATE messages SET usage_json = json_set(usage_json, '$.reasoning', ?) WHERE session_id = ? AND event_id = ? AND usage_json IS NOT NULL`)
  let files = 0, errors = 0, reasoning = 0

  for (const src of sources) {
    const factory = factories[src.agent]
    if (!factory) continue
    let text: string
    try { text = readFileSync(src.path, 'utf8') } catch { continue }
    const parse = factory({ filePath: src.path })
    const sessionPk = `${src.agent}:${src.session_id}`
    const tx = db.transaction(() => {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        // 快速过滤：只处理可能带目标的行
        if (!line.includes('error') && !line.includes('reasoning') && !line.includes('isApiErrorMessage')) continue
        let obj: any
        try { obj = JSON.parse(line) } catch { continue }
        const r = parse(obj)
        if (!r?.message?.eventId) continue
        if (r.message.apiError) errors += markError.run(sessionPk, r.message.eventId).changes
        const rn = r.message.usage?.reasoning
        if (rn) reasoning += setReasoning.run(rn, sessionPk, r.message.eventId).changes
      }
    })
    tx()
    files++
  }
  return { files, errors, reasoning }
}

// 直接运行：tsx src/backfill-api-stats.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  console.time('backfill-api-stats')
  const r = backfillApiStats()
  console.timeEnd('backfill-api-stats')
  console.log(`重解析 ${r.files} 个文件：标记 ${r.errors} 条 API 错误、回填 ${r.reasoning} 条 reasoning`)
}

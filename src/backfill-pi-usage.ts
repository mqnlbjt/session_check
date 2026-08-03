// pi 历史消息 usage 回填：重解析 pi session 文件，把 usage_json/model 补到已入库的消息上
// 然后按消息重算 pi 会话的 token 汇总（sessions.input_tokens 等）
import { readFileSync } from 'node:fs'
import { db } from './db.js'
import { createPiParser } from './parsers/pi.js'

export function backfillPiUsage(): { files: number; updated: number } {
  const sources = db.prepare(`SELECT path, session_id FROM sources WHERE agent = 'pi'`).all() as { path: string; session_id: string }[]
  const update = db.prepare(
    `UPDATE messages SET usage_json = ?, model = COALESCE(?, model) WHERE session_id = ? AND event_id = ? AND usage_json IS NULL`
  )
  let files = 0
  let updated = 0

  for (const src of sources) {
    let text: string
    try { text = readFileSync(src.path, 'utf8') } catch { continue }
    const parse = createPiParser({ filePath: src.path })
    const sessionPk = `pi:${src.session_id}`
    const tx = db.transaction(() => {
      for (const line of text.split('\n')) {
        if (!line.trim() || !line.includes('"usage"')) continue
        let obj: any
        try { obj = JSON.parse(line) } catch { continue }
        const r = parse(obj)
        if (r?.message?.usage && r.message.eventId) {
          updated += update.run(JSON.stringify(r.message.usage), r.message.model ?? null, sessionPk, r.message.eventId).changes
        }
      }
    })
    tx()
    files++
  }

  // 按消息重算 pi 会话 token 汇总（含 cache 列）
  db.exec(`
    UPDATE sessions SET
      input_tokens    = COALESCE((SELECT SUM(json_extract(usage_json, '$.input')) FROM messages WHERE session_id = sessions.id), 0),
      output_tokens   = COALESCE((SELECT SUM(json_extract(usage_json, '$.output')) FROM messages WHERE session_id = sessions.id), 0),
      cache_read      = COALESCE((SELECT SUM(json_extract(usage_json, '$.cacheRead')) FROM messages WHERE session_id = sessions.id), 0),
      cache_creation  = COALESCE((SELECT SUM(json_extract(usage_json, '$.cacheCreation')) FROM messages WHERE session_id = sessions.id), 0),
      avg_tps         = NULL
    WHERE agent = 'pi'
  `)
  return { files, updated }
}

// 直接运行：tsx src/backfill-pi-usage.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  console.time('backfill-pi-usage')
  const r = backfillPiUsage()
  console.timeEnd('backfill-pi-usage')
  console.log(`重解析 ${r.files} 个文件，回填 ${r.updated} 条消息的 usage`)
}

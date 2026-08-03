// 老会话数据清理：90 天前的会话清空 tool_result output，保留人话/元数据/搜索索引
// 与期1决策协同：tool_result 本来就不进 FTS 索引，清理后搜索和信号完全不受影响
import { db } from './db.js'
import type { Block } from './model.js'

export interface JanitorResult { sessions: number; messages: number; bytesFreed: number }

// 释放超过这个量级才 VACUUM（VACUUM 重写全库，小收益不值得）
const VACUUM_THRESHOLD = 50 * 1024 * 1024

export function runJanitor(olderThanDays = 90): JanitorResult {
  // COALESCE(ended_at, started_at)：started 老但仍在活跃的长跑会话不清
  // datetime() 归一化两侧格式：库存的是 ISO 带 T，直接字符串比较 cutoff 当天会漏清（'T' > ' '）
  const oldSessions = db.prepare(
    `SELECT id FROM sessions WHERE datetime(COALESCE(ended_at, started_at)) < datetime('now', ?)`
  ).all(`-${olderThanDays} days`) as { id: string }[]

  const touched = new Set<string>()
  let messages = 0
  let bytesFreed = 0
  let corrupt = 0

  const tx = db.transaction(() => {
    const update = db.prepare(`UPDATE messages SET blocks_json = ? WHERE id = ?`)
    for (const s of oldSessions) {
      // 快速过滤：只碰含 tool_result 的消息
      const rows = db.prepare(
        `SELECT id, blocks_json FROM messages WHERE session_id = ? AND blocks_json LIKE '%tool_result%'`
      ).all(s.id) as { id: number; blocks_json: string }[]
      for (const r of rows) {
        let blocks: Block[]
        try {
          blocks = JSON.parse(r.blocks_json) as Block[]
        } catch {
          corrupt++ // 单条坏数据不拖垮整个 run
          continue
        }
        let changed = false
        for (const b of blocks) {
          if (b.type === 'tool_result' && b.output) {
            bytesFreed += Buffer.byteLength(b.output) // 真实 UTF-8 字节，不是 UTF-16 字符数
            b.output = ''
            changed = true
          }
        }
        if (changed) {
          update.run(JSON.stringify(blocks), r.id)
          touched.add(s.id)
          messages++
        }
      }
    }
    db.prepare(`INSERT INTO janitor_log (run_at, sessions, messages, bytes_freed) VALUES (?, ?, ?, ?)`)
      .run(new Date().toISOString(), touched.size, messages, bytesFreed)
  })
  tx()

  // WAL 收拢；释放量大才 VACUUM 真正还盘
  db.pragma('wal_checkpoint(TRUNCATE)')
  if (bytesFreed >= VACUUM_THRESHOLD) db.exec('VACUUM')

  if (corrupt > 0) console.warn(`[janitor] 跳过 ${corrupt} 条损坏的 blocks_json`)
  return { sessions: touched.size, messages, bytesFreed }
}

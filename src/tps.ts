import { db, codexAvgTps } from './db.js'

// 会话级平均 TPS 计算（预计算存 sessions.avg_tps，-1 = 已算过但无数据）
// claude/pi 走消息分组估算法；codex 走 token_count 采样差分

const msgRows = db.prepare(`SELECT role, ts, usage_json FROM messages WHERE session_id = ? ORDER BY seq`)

export function computeAvgTps(sessionPk: string, agent: string): number | null {
  if (agent === 'codex') return codexAvgTps(sessionPk)

  // 连续 assistant 消息是同一次响应的分块，按组：组总 output ÷ (组末 - 组前事件)
  const rows = msgRows.all(sessionPk) as { role: string; ts: string; usage_json: string | null }[]
  let genTime = 0, genOut = 0
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].role !== 'assistant') continue
    let j = i, out = 0
    while (j < rows.length && rows[j].role === 'assistant') {
      const u = rows[j].usage_json ? JSON.parse(rows[j].usage_json!) : null
      out += u?.output ?? 0
      j++
    }
    if (out > 0) {
      const t0 = i > 0 ? new Date(rows[i - 1].ts).getTime() : new Date(rows[i].ts).getTime() - 1000
      const t1 = new Date(rows[j - 1].ts).getTime()
      const dt = Math.min(600, Math.max(0.5, (t1 - t0) / 1000))
      genTime += dt
      genOut += out
    }
    i = j - 1
  }
  return genTime > 0 ? Math.round((genOut / genTime) * 10) / 10 : null
}

const dirtyStmt = db.prepare(`SELECT id, agent FROM sessions WHERE avg_tps IS NULL AND message_count > 0`)
const setTps = db.prepare(`UPDATE sessions SET avg_tps = ? WHERE id = ?`)

// 重算所有被标记过期的会话；无数据的写 -1 防止反复重算
export function backfillTps(): number {
  const rows = dirtyStmt.all() as { id: string; agent: string }[]
  for (const r of rows) {
    const v = computeAvgTps(r.id, r.agent)
    setTps.run(v ?? -1, r.id)
  }
  return rows.length
}

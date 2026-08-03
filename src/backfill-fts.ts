// 老数据 FTS 回填：npm run backfill-fts（幂等，可重复跑）
import { backfillFts } from './db.js'

console.time('backfill')
const n = backfillFts()
console.timeEnd('backfill')
console.log(`回填 ${n} 条消息到 FTS 索引`)

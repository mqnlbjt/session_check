// 返工信号回填：npm run backfill-signals（全量重建，幂等）
import { backfillSignals } from './db.js'

console.time('backfill-signals')
const n = backfillSignals()
console.timeEnd('backfill-signals')
console.log(`回填 ${n} 条返工信号`)

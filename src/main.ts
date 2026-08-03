import { scanAll } from './ingest.js'
import { startServer } from './server.js'
import { runJanitor } from './janitor.js'

const cmd = process.argv[2] ?? 'serve'

if (cmd === 'scan') {
  console.time('scan')
  const stats = scanAll()
  console.timeEnd('scan')
  console.log(`扫描 ${stats.files} 个文件，更新 ${stats.ingested} 个，新增 ${stats.added} 条消息`)
} else if (cmd === 'janitor') {
  const r = runJanitor(90)
  console.log(`janitor：清理 ${r.sessions} 个会话、${r.messages} 条消息，释放 ${(r.bytesFreed / 1048576).toFixed(1)}MB`)
} else if (cmd === 'serve') {
  const port = Number(process.env.PORT ?? 8321)
  // 启动时先全量扫一遍，再进入 watch
  const stats = scanAll()
  console.log(`[init] 扫描 ${stats.files} 个文件，新增 ${stats.added} 条消息`)
  // 数据治理：启动跑一次，之后每 24h
  const janitorRun = () => {
    try {
      const r = runJanitor(90)
      if (r.messages > 0) console.log(`[janitor] 清理 ${r.sessions} 个会话、${r.messages} 条消息，释放 ${(r.bytesFreed / 1048576).toFixed(1)}MB`)
    } catch (e) { console.error('[janitor] 失败:', e) }
  }
  janitorRun()
  setInterval(janitorRun, 24 * 3600_000)
  startServer(port)
} else {
  console.log('用法: spectator [scan|serve|janitor]')
  process.exit(1)
}

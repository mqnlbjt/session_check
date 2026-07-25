import { scanAll } from './ingest.js'
import { startServer } from './server.js'

const cmd = process.argv[2] ?? 'serve'

if (cmd === 'scan') {
  console.time('scan')
  const stats = scanAll()
  console.timeEnd('scan')
  console.log(`扫描 ${stats.files} 个文件，更新 ${stats.ingested} 个，新增 ${stats.added} 条消息`)
} else if (cmd === 'serve') {
  const port = Number(process.env.PORT ?? 8321)
  // 启动时先全量扫一遍，再进入 watch
  const stats = scanAll()
  console.log(`[init] 扫描 ${stats.files} 个文件，新增 ${stats.added} 条消息`)
  startServer(port)
} else {
  console.log('用法: spectator [scan|serve]')
  process.exit(1)
}

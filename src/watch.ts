import { watch } from 'chokidar'
import { statSync } from 'node:fs'
import { loadRoots, ingestFile } from './ingest.js'

// 常驻 watch：session 文件是 append-only，add/change 都走增量 ingest
// agent 类型不在 watch 层判断，交给 ingestFile（sources 记录 -> 配置 hint -> 内容嗅探）
export function startWatch(onIngest?: (path: string, added: number) => void) {
  const roots = loadRoots()

  const watcher = watch(roots.map((r) => r.path), {
    ignoreInitial: false,
    depth: 6,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  })

  function handle(path: string) {
    if (!path.endsWith('.jsonl')) return
    if (path.includes('/subagent-artifacts/')) return
    try {
      if (!statSync(path).isFile()) return
    } catch { return }
    const added = ingestFile(path)
    if (added > 0) onIngest?.(path, added)
  }

  watcher.on('add', handle)
  watcher.on('change', handle)
  watcher.on('error', (err) => console.error('[watch]', err))

  console.log(`[watch] 监控 ${roots.length} 个目录:`)
  for (const r of roots) console.log(`  - ${r.path}${r.agent ? ` (${r.agent})` : ' (嗅探)'}`)
  return watcher
}

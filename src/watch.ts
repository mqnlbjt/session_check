import { watch } from 'chokidar'
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import { SOURCES, ingestFile } from './ingest.js'
import type { AgentType } from './model.js'

// 常驻 watch：session 文件是 append-only，add/change 都走增量 ingest
export function startWatch(onIngest?: (path: string, added: number) => void) {
  const agentByRoot = new Map<string, AgentType>()
  const roots: string[] = []
  for (const { agent, roots: rs } of SOURCES) {
    for (const r of rs) { roots.push(r); agentByRoot.set(r, agent) }
  }

  const watcher = watch(roots, {
    ignoreInitial: false,
    depth: 6,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  })

  function agentFor(path: string): AgentType | null {
    for (const [root, agent] of agentByRoot) {
      if (path.startsWith(root + '/')) return agent
    }
    return null
  }

  function handle(path: string) {
    if (!path.endsWith('.jsonl')) return
    if (path.includes('/subagent-artifacts/')) return
    const agent = agentFor(path)
    if (!agent) return
    try {
      if (!statSync(path).isFile()) return
    } catch { return }
    const added = ingestFile(path, agent)
    if (added > 0) onIngest?.(path, added)
  }

  watcher.on('add', handle)
  watcher.on('change', handle)
  watcher.on('error', (err) => console.error('[watch]', err))

  console.log(`[watch] 监控 ${roots.length} 个目录:`)
  for (const r of roots) console.log(`  - ${r}`)
  return watcher
}

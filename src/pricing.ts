// 模型价格表（USD / 1M tokens）：默认值是公开刊例价的近似，可在配置文件覆盖
// spectator.config.json: { "prices": { "gpt-5.4": { "in": 2.5, "out": 15 } } }
// 匹配规则：先去 provider 前缀精确匹配，再按 key 最长包含匹配（gpt-5.2-codex 命中 gpt-5.2）

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

interface Price { in: number; out: number }

const DEFAULT_PRICES: Record<string, Price> = {
  'deepseek-v4-flash': { in: 0.27, out: 1.1 },
  'deepseek-v4-pro': { in: 0.55, out: 2.19 },
  'gpt-5.5': { in: 5, out: 25 },
  'gpt-5.4': { in: 2.5, out: 15 },
  'gpt-5.3': { in: 1.75, out: 12 },
  'gpt-5.2': { in: 1.5, out: 11 },
  'gpt-5.1': { in: 1.25, out: 10 },
  'gpt-5': { in: 1.25, out: 10 },
  'claude-opus': { in: 5, out: 25 },
  'claude-sonnet': { in: 3, out: 15 },
  'gemini-3.5-flash': { in: 0.5, out: 3 },
  'gemini-3-flash': { in: 0.3, out: 2.5 },
  'gemini-3.1-pro': { in: 1.25, out: 10 },
  'glm': { in: 0.6, out: 2.2 },
  'k3': { in: 0.6, out: 2.5 },
  'minimax': { in: 0.3, out: 1.2 },
  'mimo': { in: 0.3, out: 1.2 },
}

let prices: Record<string, Price> | null = null

function load(): Record<string, Price> {
  if (prices) return prices
  prices = { ...DEFAULT_PRICES }
  const HOME = homedir()
  const cfgPaths = [
    process.env.SPECTATOR_CONFIG,
    join(HOME, '.config/spectator/config.json'),
    resolve('spectator.config.json'),
  ].filter(Boolean) as string[]
  for (const p of cfgPaths) {
    if (!existsSync(p)) continue
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf8'))
      Object.assign(prices, cfg.prices ?? {})
    } catch { /* 配置坏了用默认 */ }
  }
  return prices
}

export function findPrice(model: string | null): Price | null {
  if (!model) return null
  const table = load()
  // 去 provider 前缀（deepseek/deepseek-v4-flash → deepseek-v4-flash）
  const bare = (model.includes('/') ? model.split('/').pop()! : model).toLowerCase()
  if (table[bare]) return table[bare]
  // 最长包含匹配
  let best: string | null = null
  for (const key of Object.keys(table)) {
    if (bare.includes(key.toLowerCase()) && (best === null || key.length > best.length)) best = key
  }
  return best ? table[best] : null
}

// 成本（USD）：cache 读 0.1x、cache 写 1.25x（claude ephemeral 口径）
export function costOf(model: string | null, input: number, output: number, cacheRead = 0, cacheCreation = 0): number | null {
  const p = findPrice(model)
  if (!p) return null
  const fresh = Math.max(0, input - cacheRead)
  return (fresh * p.in + cacheRead * p.in * 0.1 + cacheCreation * p.in * 1.25 + output * p.out) / 1e6
}

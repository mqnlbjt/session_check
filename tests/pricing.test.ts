// 成本口径测试：claude/codex 的 input 都是「不含 cache 的净输入」，不得再减 cacheRead
import { describe, expect, it } from 'vitest'
import { costOf } from '../src/pricing.js'

describe('costOf 口径', () => {
  // claude-sonnet 刊例: in $3 / out $15 per 1M
  it('input 全价 + cache 读 0.1x + cache 写 1.25x + output', () => {
    // input=1000(净), cacheRead=5000, cacheCreation=200, output=100
    // = 1000*3 + 5000*0.3 + 200*3.75 + 100*15 = 3000+1500+750+1500 = 6750 / 1e6
    const c = costOf('claude-sonnet-4', 1000, 100, 5000, 200)
    expect(c).toBeCloseTo(0.00675, 8)
  })

  it('cacheRead > input 时净输入仍全价计费（不为 0）', () => {
    // 真实数据形态：input=12, cacheRead=50000 → 12 全价 + 50000*0.1x
    const c = costOf('claude-sonnet-4', 12, 0, 50000)
    expect(c).toBeCloseTo((12 * 3 + 50000 * 0.3) / 1e6, 8)
  })

  it('未知模型返回 null', () => {
    expect(costOf('no-such-model-xyz', 100, 100)).toBeNull()
  })
})

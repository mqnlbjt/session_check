// pi parser usage 提取测试：pi 消息自带完整 usage（含 cache），口径是净输入
import { describe, expect, it } from 'vitest'
import { createPiParser } from '../src/parsers/pi.js'

describe('pi parser usage 提取', () => {
  it('assistant 消息的 usage 映射（cacheWrite → cacheCreation）', () => {
    const parse = createPiParser({ filePath: '/home/x/.pi/agent/sessions/proj/2026-01-01_aaa.jsonl' })
    parse({ type: 'session', id: 's1', cwd: '/p', timestamp: '2026-01-01T00:00:00Z' })
    const r = parse({
      type: 'message', id: 'm1', timestamp: '2026-01-01T00:00:01Z',
      message: {
        role: 'assistant', provider: 'moonshot', model: 'k3',
        content: [{ type: 'text', text: '好的' }],
        usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 5, totalTokens: 165 },
      },
    })
    expect(r?.message?.usage).toEqual({ input: 100, output: 10, cacheRead: 50, cacheCreation: 5 })
    expect(r?.message?.model).toBe('moonshot/k3')
  })

  it('stopReason=error 映射为 apiError，reasoning 进 usage', () => {
    const parse = createPiParser({ filePath: '/home/x/.pi/agent/sessions/proj/2026-01-01_aaa.jsonl' })
    parse({ type: 'session', id: 's1', cwd: '/p', timestamp: '2026-01-01T00:00:00Z' })
    const r = parse({
      type: 'message', id: 'm3', timestamp: '2026-01-01T00:00:03Z',
      message: {
        role: 'assistant', provider: 'moonshot', model: 'k3',
        content: [], stopReason: 'error', errorMessage: 'HTTP 500',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      },
    })
    expect(r?.message?.apiError).toBe(true)
    expect(r?.message?.blocks[0].text).toContain('[API 错误]')
    expect(r?.message?.usage?.reasoning).toBe(0)
  })

  it('user 消息无 usage 不报错', () => {
    const parse = createPiParser({ filePath: '/home/x/.pi/agent/sessions/proj/2026-01-01_aaa.jsonl' })
    parse({ type: 'session', id: 's1', cwd: '/p', timestamp: '2026-01-01T00:00:00Z' })
    const r = parse({
      type: 'message', id: 'm2', timestamp: '2026-01-01T00:00:02Z',
      message: { role: 'user', content: [{ type: 'text', text: '你好' }] },
    })
    expect(r?.message?.usage).toBeUndefined()
  })
})

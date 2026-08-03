// API 层单接缝测试：内存 db + app.request()，不碰真实 spectator.db
import { beforeAll, describe, expect, it } from 'vitest'
import type { Hono } from 'hono'

process.env.SPECTATOR_DB = ':memory:'

let app: Hono
let db: import('better-sqlite3').Database

beforeAll(async () => {
  // env 必须在 import db 之前设好，所以用动态 import
  const server = await import('../src/server.js')
  app = server.app
  db = (await import('../src/db.js')).db
})

describe('测试基建接缝', () => {
  it('内存 db 与真实库隔离', () => {
    expect(db.name).toBe(':memory:')
  })

  it('GET /api/sessions 空库返回空列表', async () => {
    const res = await app.request('/api/sessions')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ total: 0, rows: [] })
  })
})

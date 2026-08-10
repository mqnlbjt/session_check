// schema 单轨 + 迁移助手测试（审计 P2）：新库 CREATE 一步到位，addColumn 只吞 duplicate column
import { beforeAll, describe, expect, it } from 'vitest'

process.env.SPECTATOR_DB = ':memory:'

let dbmod: typeof import('../src/db.js')

beforeAll(async () => {
  dbmod = await import('../src/db.js')
})

describe('新库 schema 单轨（CREATE 含全部列）', () => {
  const cols = (t: string) => (dbmod.db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name)
  it('sessions 含全部后增列', () => {
    for (const c of ['parent_id', 'label', 'avg_tps', 'error_count', 'risk_count', 'cache_read', 'cache_creation']) {
      expect(cols('sessions')).toContain(c)
    }
  })
  it('messages / signals / installations 含后增列', () => {
    expect(cols('messages')).toContain('api_error')
    for (const c of ['confirmation', 'root_cause', 'cause_confidence']) expect(cols('signals')).toContain(c)
    expect(cols('installations')).toContain('version')
  })
})

describe('addColumn 迁移助手', () => {
  it('正常加列生效', () => {
    dbmod.addColumn(`ALTER TABLE sessions ADD COLUMN test_migration_probe TEXT`)
    expect((dbmod.db.prepare(`PRAGMA table_info(sessions)`).all() as any[]).map((c) => c.name)).toContain('test_migration_probe')
  })
  it('duplicate column 静默跳过', () => {
    expect(() => dbmod.addColumn(`ALTER TABLE sessions ADD COLUMN test_migration_probe TEXT`)).not.toThrow()
  })
  it('非 duplicate 错误（语法错/库损坏）必须抛出', () => {
    expect(() => dbmod.addColumn(`ALTER TABLE nonexistent_table ADD COLUMN x TEXT`)).toThrow()
    expect(() => dbmod.addColumn(`ALTER TABLE sessions ADD COLUMN`)).toThrow()
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import {
  openProductState,
  migrate,
  MEMORY_DB,
  type SqliteDatabase
} from '../../../src/main/product-state/database'
import { M0010_CREATE_BOTS } from '../../../src/main/product-state/migrations/0010-create-bots'

let db: SqliteDatabase | null = null

afterEach(() => {
  db?.close()
  db = null
})

describe('Migration 0010: create-bots', () => {
  it('执行迁移后 user_version 推进到 10，创建 bots 表与内置种子 Bot', () => {
    db = openProductState(MEMORY_DB)
    migrate(db)

    const version = db.pragma('user_version', { simple: true }) as number
    expect(version).toBeGreaterThanOrEqual(10)

    // 验证 bots 表结构与默认 3 个内置伴侣
    const rows = db.prepare('SELECT id, name, avatar, persona, description, is_default FROM bots ORDER BY id').all() as Array<{
      id: string
      name: string
      avatar: string
      persona: string
      description: string
      is_default: number
    }>

    expect(rows.length).toBeGreaterThanOrEqual(3)

    const defaultBot = rows.find((r) => r.id === 'bot-default')
    expect(defaultBot).toBeDefined()
    expect(defaultBot?.name).toBe('PersonalAgent')
    expect(defaultBot?.avatar).toBe('🤖')
    expect(defaultBot?.is_default).toBe(1)

    const coderBot = rows.find((r) => r.id === 'bot-coder')
    expect(coderBot).toBeDefined()
    expect(coderBot?.name).toBe('代码极客')
    expect(coderBot?.avatar).toBe('💻')
    expect(coderBot?.is_default).toBe(0)

    const analystBot = rows.find((r) => r.id === 'bot-analyst')
    expect(analystBot).toBeDefined()
    expect(analystBot?.name).toBe('深度分析师')
    expect(analystBot?.avatar).toBe('🔍')
    expect(analystBot?.is_default).toBe(0)
  })

  it('is_default 具有 CHECK (is_default IN (0, 1)) 约束，非法值插入被拒', () => {
    db = openProductState(MEMORY_DB)
    migrate(db)

    expect(() => {
      db!.prepare(`
        INSERT INTO bots (id, name, avatar, persona, description, is_default, created_at, updated_at)
        VALUES ('bot-invalid', '非法测试', '❌', '人设', '描述', 2, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')
      `).run()
    }).toThrow(/CHECK constraint failed/)
  })

  it('内置 3 个 Bot 拥有各自初始化的单伴随永续会话 (c-bot-*)', () => {
    db = openProductState(MEMORY_DB)
    migrate(db)

    const convRows = db.prepare('SELECT id, bot_id, title FROM conversations WHERE bot_id IS NOT NULL').all() as Array<{
      id: string
      bot_id: string
      title: string
    }>

    const botDefaultConv = convRows.find((c) => c.bot_id === 'bot-default')
    expect(botDefaultConv).toBeDefined()
    expect(botDefaultConv?.id).toBe('c-bot-default')

    const botCoderConv = convRows.find((c) => c.bot_id === 'bot-coder')
    expect(botCoderConv).toBeDefined()
    expect(botCoderConv?.id).toBe('c-bot-coder')

    const botAnalystConv = convRows.find((c) => c.bot_id === 'bot-analyst')
    expect(botAnalystConv).toBeDefined()
    expect(botAnalystConv?.id).toBe('c-bot-analyst')
  })

  it('从版本 9 升级时，老旧会话 (bot_id 为 NULL) 自动回填为 bot-default', () => {
    // 模拟一个停留在版本 9 的真实老数据库
    db = openProductState(MEMORY_DB)
    // 这里我们手动建一个纯 v9 表环境验证增量迁移
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO conversations (id, title, created_at, updated_at)
      VALUES ('legacy-c1', '旧对话1', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    `)

    // 执行 M0010
    M0010_CREATE_BOTS.up(db)

    const row = db.prepare('SELECT id, bot_id FROM conversations WHERE id = ?').get('legacy-c1') as {
      id: string
      bot_id: string
    }
    expect(row.bot_id).toBe('bot-default')
  })
})

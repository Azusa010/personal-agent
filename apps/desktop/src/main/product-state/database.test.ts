import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openProductState, migrate, MEMORY_DB, type SqliteDatabase } from './database'
import { MIGRATIONS } from './migrations'
import type { Migration } from './migrations'

let memDb: SqliteDatabase | null = null
let fileDb: SqliteDatabase | null = null
let tmpDir: string | null = null

const version = (db: SqliteDatabase): number =>
  db.pragma('user_version', { simple: true }) as number

const tables = (db: SqliteDatabase): string[] =>
  (
    db.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all('table') as {
      name: string
    }[]
  ).map((r) => r.name)

afterEach(() => {
  memDb?.close()
  memDb = null
  // 必须先 close 再删目录：Windows 上句柄未释放会让 rmSync 失败。
  fileDb?.close()
  fileDb = null
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
})

describe('migrate', () => {
  it('新库：应用全部迁移，user_version 推到最新，tasks 表建出来', () => {
    memDb = openProductState(MEMORY_DB)
    expect(version(memDb)).toBe(0) // 新库起点是 0，不是 null

    const applied = migrate(memDb, MIGRATIONS)

    expect(applied).toEqual([1])
    expect(version(memDb)).toBe(1)
    expect(tables(memDb)).toContain('tasks')
  })

  it('可重复执行：第二次跑返回空数组，不炸也不重复建表', () => {
    memDb = openProductState(MEMORY_DB)
    migrate(memDb, MIGRATIONS)

    // Phase 1 Exit Checklist 第 1 条
    expect(migrate(memDb, MIGRATIONS)).toEqual([])
    expect(version(memDb)).toBe(1)
    expect(tables(memDb).filter((n) => n === 'tasks')).toHaveLength(1)
  })

  it('TASK-009 Validation：重开数据库后数据一致', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pa-store-'))
    const file = join(tmpDir, 'product-state.db')

    fileDb = openProductState(file)
    migrate(fileDb, MIGRATIONS)
    fileDb
      .prepare('INSERT INTO tasks (id, goal, status, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(
        't-1',
        '整理 Downloads 的 PDF',
        'pending',
        '2026-09-06T00:00:00Z',
        '2026-09-06T00:00:00Z'
      )
    fileDb.close()
    fileDb = null

    // 重开同一个文件
    fileDb = openProductState(file)
    expect(migrate(fileDb, MIGRATIONS)).toEqual([]) // 已是最新，不再动结构
    expect(version(fileDb)).toBe(1)

    const row = fileDb.prepare('SELECT id, goal, status FROM tasks').get() as {
      id: string
      goal: string
      status: string
    }
    expect(row).toEqual({ id: 't-1', goal: '整理 Downloads 的 PDF', status: 'pending' })
  })

  it('迁移中途失败：整批回滚，user_version 不前进，不留半成品表', () => {
    memDb = openProductState(MEMORY_DB)

    const good: Migration = {
      version: 1,
      name: 'good',
      up: (db) => db.exec('CREATE TABLE good_t (id TEXT)')
    }
    const bad: Migration = {
      version: 2,
      name: 'bad',
      up: () => {
        throw new Error('模拟迁移失败')
      }
    }

    expect(() => migrate(memDb, [good, bad])).toThrow('模拟迁移失败')

    // 实测依据：user_version 与 DDL 在事务内一起回滚
    expect(version(memDb)).toBe(0)
    expect(tables(memDb)).not.toContain('good_t')

    // 回滚干净后，修好再跑仍能成功
    expect(migrate(memDb, [good])).toEqual([1])
    expect(tables(memDb)).toContain('good_t')
  })

  it('status 的 CHECK 约束把状态机钉进 schema，非法值被 DB 拒绝', () => {
    memDb = openProductState(MEMORY_DB)
    migrate(memDb, MIGRATIONS)

    const insert = memDb.prepare(
      'INSERT INTO tasks (id, goal, status, created_at, updated_at) VALUES (?,?,?,?,?)'
    )
    expect(() =>
      insert.run('t-2', 'g', 'waiting_permission', '2026-09-06T00:00:00Z', '2026-09-06T00:00:00Z')
    ).toThrow()

    // Phase 1 才允许 waiting_permission，Phase 1 Execution Rules 第 1 条现在就该拒
    expect(() =>
      insert.run('t-3', 'g', 'running', '2026-09-06T00:00:00Z', '2026-09-06T00:00:00Z')
    ).not.toThrow()
  })
})

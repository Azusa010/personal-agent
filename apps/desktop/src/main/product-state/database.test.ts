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

const ALL_VERSIONS = [...MIGRATIONS.map((m) => m.version)].sort((a, b) => a - b)
const LATEST_VERSION = Math.max(...MIGRATIONS.map((m) => m.version))

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
    expect(version(memDb)).toBe(0)

    const applied = migrate(memDb, MIGRATIONS)

    expect(applied).toEqual(ALL_VERSIONS)
    expect(version(memDb)).toBe(LATEST_VERSION)
    expect(tables(memDb)).toContain('tasks')
  })

  it('可重复执行：第二次跑返回空数组，不炸也不重复建表', () => {
    memDb = openProductState(MEMORY_DB)
    migrate(memDb, MIGRATIONS)

    expect(migrate(memDb, MIGRATIONS)).toEqual([])
    expect(version(memDb)).toBe(LATEST_VERSION)
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
    expect(migrate(fileDb, MIGRATIONS)).toEqual([])
    expect(version(fileDb)).toBe(LATEST_VERSION)

    const row = fileDb.prepare('SELECT id, goal, status FROM tasks').get() as {
      id: string
      goal: string
      status: string
    }
    expect(row).toEqual({ id: 't-1', goal: '整理 Downloads 的 PDF', status: 'pending' })
  })

  it('迁移中途失败：整批回滚，user_version 不前进，不留半成品表', () => {
    // 用局部 const 承接：memDb 被 afterEach 闭包赋值过，
    // TS 在跨过下面的箭头函数后会放弃对它的 null 窄化。
    const db = openProductState(MEMORY_DB)
    memDb = db

    const good: Migration = {
      version: 1,
      name: 'good',
      up: (d) => d.exec('CREATE TABLE good_t (id TEXT)')
    }
    const bad: Migration = {
      version: 2,
      name: 'bad',
      up: () => {
        throw new Error('模拟迁移失败')
      }
    }

    expect(() => migrate(db, [good, bad])).toThrow('模拟迁移失败')

    // 实测依据：user_version 与 DDL 在事务内一起回滚
    expect(version(db)).toBe(0)
    expect(tables(db)).not.toContain('good_t')

    // 回滚干净后，修好再跑仍能成功
    expect(migrate(db, [good])).toEqual([1])
    expect(tables(db)).toContain('good_t')
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
  it('0002/0003 应用后：user_version = 3，三张表都在', () => {
    const db = openProductState(MEMORY_DB)
    memDb = db

    expect(migrate(db, MIGRATIONS)).toEqual([1, 2, 3])
    expect(version(db)).toBe(3)
    expect(tables(db)).toEqual(expect.arrayContaining(['tasks', 'plans', 'execution_events']))
  })

  it('execution_events 是 append-only：UPDATE 与 DELETE 被库层拒绝', () => {
    const db = openProductState(MEMORY_DB)
    memDb = db
    migrate(db, MIGRATIONS)
    db.prepare(
      'INSERT INTO tasks (id, goal, status, created_at, updated_at) VALUES (?,?,?,?,?)'
    ).run('t-1', 'g', 'running', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z')
    db.prepare(
      'INSERT INTO execution_events (task_id, type, payload, occurred_at) VALUES (?,?,?,?)'
    ).run('t-1', 'task_started', '{}', '2026-09-07T00:00:01Z')

    expect(() =>
      db.prepare('UPDATE execution_events SET type = ? WHERE seq = 1').run('tampered')
    ).toThrow('append-only')
    expect(() => db.prepare('DELETE FROM execution_events WHERE seq = 1').run()).toThrow(
      'append-only'
    )

    // 篡改尝试之后数据完好
    const rows = db.prepare('SELECT seq, type FROM execution_events').all() as {
      seq: number
      type: string
    }[]
    expect(rows).toEqual([{ seq: 1, type: 'task_started' }])
  })

  it('外键生效：指向不存在 task 的事件被拒绝', () => {
    const db = openProductState(MEMORY_DB)
    memDb = db
    migrate(db, MIGRATIONS)

    // better-sqlite3 驱动默认 foreign_keys = 1，REFERENCES 不是装饰
    expect(() =>
      db
        .prepare(
          'INSERT INTO execution_events (task_id, type, payload, occurred_at) VALUES (?,?,?,?)'
        )
        .run('幽灵task', 'task_started', '{}', '2026-09-07T00:00:01Z')
    ).toThrow(/FOREIGN KEY/)
  })

  it('seq 永不复用：即便绕过触发器删掉最大行，新事件也拿新号', () => {
    const db = openProductState(MEMORY_DB)
    memDb = db
    migrate(db, MIGRATIONS)
    db.prepare(
      'INSERT INTO tasks (id, goal, status, created_at, updated_at) VALUES (?,?,?,?,?)'
    ).run('t-1', 'g', 'running', '2026-09-07T00:00:00Z', '2026-09-07T00:00:00Z')
    const append = db.prepare(
      'INSERT INTO execution_events (task_id, type, payload, occurred_at) VALUES (?,?,?,?)'
    )
    append.run('t-1', 'e1', '{}', '2026-09-07T00:00:01Z')
    append.run('t-1', 'e2', '{}', '2026-09-07T00:00:02Z')

    // 故意 DROP 触发器制造最坏情况：验证第二道保险（AUTOINCREMENT）独立生效。
    // 生产路径不会走到这里——触发器已经在上一条测试里证明拦得住。
    db.exec('DROP TRIGGER execution_events_no_delete')
    db.prepare('DELETE FROM execution_events WHERE seq = 2').run()
    append.run('t-1', 'e3', '{}', '2026-09-07T00:00:03Z')

    const seqs = (db.prepare('SELECT seq FROM execution_events').all() as { seq: number }[]).map(
      (r) => r.seq
    )
    expect(seqs).toEqual([1, 3]) // 不是 [1, 2]：2 号已用过，永不重发
  })

  it('注册表 version 撞号被拒，不让第二个迁移静默漏跑', () => {
    const db = openProductState(MEMORY_DB)
    memDb = db

    const dup: Migration[] = [
      { version: 1, name: 'a', up: (d) => d.exec('CREATE TABLE a_t (id TEXT)') },
      { version: 1, name: 'b', up: (d) => d.exec('CREATE TABLE b_t (id TEXT)') }
    ]

    expect(() => migrate(db, dup)).toThrow(/version 重复: 1/)
    expect(version(db)).toBe(0) // 校验在事务之前，库完全没被动过
    expect(tables(db)).not.toContain('a_t')
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { openProductState, migrate, MEMORY_DB, type SqliteDatabase } from './database'
import { MIGRATIONS } from './migrations'
import type { Migration } from './migrations'
import { SqlitePlanRepository } from './plan-repository'
import { SqliteEventRepository } from './event-repository'

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

  it('TASK-009 Validation + Phase 1 Exit 第 2 条：重开后 Task、Plan 和 Event 都可读取', () => {
    const TS = '2026-09-06T00:00:00Z'
    tmpDir = mkdtempSync(join(tmpdir(), 'pa-store-'))
    const file = join(tmpDir, 'product-state.db')

    // 用局部 const 承接：fileDb 被 afterEach 闭包赋值过，
    // 下面出现任何箭头函数后 TS 就会放弃对它的 null 窄化。
    const first = openProductState(file)
    fileDb = first
    migrate(first, MIGRATIONS)
    first
      .prepare('INSERT INTO tasks (id, goal, status, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run('t-1', '整理 Downloads 的 PDF', 'pending', TS, TS)

    // Plan 与 Event 走 repository 写入：
    // 读回时才会真的经过 JSON.parse，验证 steps/payload 跨重启保真。
    // 文件库走 WAL，内存库走 memory journal，两条路径不能互相代替。
    new SqlitePlanRepository(first).append({
      id: 'p-1',
      taskId: 't-1',
      steps: [{ description: '列出下载目录的 PDF', capability: 'filesystem.list' }],
      createdAt: TS
    })
    new SqliteEventRepository(first).append({
      taskId: 't-1',
      type: 'task_started',
      payload: { goal: '整理 Downloads 的 PDF' },
      occurredAt: TS
    })

    first.close()
    fileDb = null

    // 重开同一个文件
    const reopened = openProductState(file)
    fileDb = reopened
    expect(migrate(reopened, MIGRATIONS)).toEqual([])
    expect(version(reopened)).toBe(LATEST_VERSION)

    expect(reopened.prepare('SELECT id, goal, status FROM tasks').get()).toEqual({
      id: 't-1',
      goal: '整理 Downloads 的 PDF',
      status: 'pending'
    })

    const plan = new SqlitePlanRepository(reopened).findLatest('t-1')
    expect(plan?.version).toBe(1)
    expect(plan?.steps).toEqual([
      { description: '列出下载目录的 PDF', capability: 'filesystem.list' }
    ])

    const events = new SqliteEventRepository(reopened).listByTask('t-1')
    expect(events.map((e) => e.seq)).toEqual([1])
    expect(events[0]?.payload).toEqual({ goal: '整理 Downloads 的 PDF' })
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
    // 'waiting' 差一个字符就是非法值。CHECK 是字符串相等，不做前缀匹配。
    expect(() =>
      insert.run('t-2', 'g', 'waiting', '2026-09-06T00:00:00Z', '2026-09-06T00:00:00Z')
    ).toThrow()

    // 0005 之后 waiting_permission 是合法值：Phase 2 的批准挂起靠它
    expect(() =>
      insert.run('t-3', 'g', 'waiting_permission', '2026-09-06T00:00:00Z', '2026-09-06T00:00:00Z')
    ).not.toThrow()
    expect(() =>
      insert.run('t-4', 'g', 'running', '2026-09-06T00:00:00Z', '2026-09-06T00:00:00Z')
    ).not.toThrow()
  })
  it('全量 migration 应用后：user_version = 5，四张表都在', () => {
    const db = openProductState(MEMORY_DB)
    memDb = db

    expect(migrate(db, MIGRATIONS)).toEqual([1, 2, 3, 4, 5])
    expect(version(db)).toBe(5)
    expect(tables(db)).toEqual(
      expect.arrayContaining(['tasks', 'plans', 'execution_events', 'permissions'])
    )
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

describe('migration 0005：重建 tasks 表放宽 CHECK', () => {
  const PRIOR = MIGRATIONS.filter((m) => m.version < 5)

  /** 先升到 4 再往三张子表各写一行。子表都 REFERENCES tasks(id)，
   *  而 0005 要 DROP 并重建 tasks：这些数据能不能活着过去，
   *  以及子表的引用会不会被改写到旧表名，就是这里要钉的两件事。 */
  function seedAtV4(db: SqliteDatabase): void {
    migrate(db, PRIOR)
    db.prepare(
      'INSERT INTO tasks (id, goal, status, created_at, updated_at) VALUES (?,?,?,?,?)'
    ).run('t-1', '整理 Downloads', 'running', '2026-09-07T00:00:00Z', '2026-09-07T00:00:01Z')
    db.prepare(
      'INSERT INTO plans (id, task_id, version, steps, created_at) VALUES (?,?,?,?,?)'
    ).run('p-1', 't-1', 1, '[]', '2026-09-07T00:00:01Z')
    db.prepare(
      'INSERT INTO execution_events (task_id, type, payload, occurred_at) VALUES (?,?,?,?)'
    ).run('t-1', 'task_started', '{}', '2026-09-07T00:00:01Z')
    db.prepare(
      `INSERT INTO permissions (id, task_id, tool_call_id, capability, args_canonical,
         args_hash, status, requested_at, expires_at, source_paths)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      'perm-1',
      't-1',
      'tc-1',
      'filesystem.move',
      '{}',
      'h',
      'pending',
      '2026-09-07T00:00:01Z',
      '2026-09-07T00:05:01Z',
      '[]'
    )
  }

  const childDdl = (db: SqliteDatabase, table: string): string =>
    (
      db
        .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
        .get('table', table) as {
        sql: string
      }
    ).sql

  it('增量升级：旧数据全保留，升级后能写 waiting_permission', () => {
    const db = openProductState(MEMORY_DB)
    memDb = db
    seedAtV4(db)

    expect(migrate(db, MIGRATIONS)).toEqual([5])

    expect(version(db)).toBe(5)
    expect(db.prepare('SELECT id, goal, status, updated_at FROM tasks').all()).toEqual([
      {
        id: 't-1',
        goal: '整理 Downloads',
        status: 'running',
        updated_at: '2026-09-07T00:00:01Z'
      }
    ])
    expect(db.prepare('SELECT COUNT(*) AS n FROM plans').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM execution_events').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM permissions').get()).toEqual({ n: 1 })

    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('waiting_permission', 't-1')
    expect(db.prepare('SELECT status FROM tasks WHERE id = ?').get('t-1')).toEqual({
      status: 'waiting_permission'
    })
  })

  it('子表的外键定义没被 RENAME 改写到旧表名', () => {
    const db = openProductState(MEMORY_DB)
    memDb = db
    seedAtV4(db)
    migrate(db, MIGRATIONS)

    // 先 DROP 旧表再 RENAME 新表，子表的 REFERENCES tasks(id) 才会指向重建后的表。
    // 反过来（先 RENAME 走旧表）会让 SQLite 把它们改写成 REFERENCES tasks_old，
    // DROP 之后引用就悬空了，而且不报错。
    for (const table of ['plans', 'execution_events', 'permissions']) {
      const ddl = childDdl(db, table)
      expect(ddl, `${table} 应仍引用 tasks`).toContain('REFERENCES tasks')
      expect(ddl, `${table} 不应被改写到临时表名`).not.toContain('tasks_new')
    }
    expect(tables(db)).not.toContain('tasks_new')
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('migrate 之后 foreign_keys 回到 ON：开关没泄漏出去', () => {
    const db = openProductState(MEMORY_DB)
    memDb = db
    seedAtV4(db)
    migrate(db, MIGRATIONS)

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    // 外键关着的话这条会静默成功，而这种退化不会报错
    expect(() =>
      db
        .prepare(
          'INSERT INTO execution_events (task_id, type, payload, occurred_at) VALUES (?,?,?,?)'
        )
        .run('幽灵task', 'task_started', '{}', '2026-09-07T00:00:02Z')
    ).toThrow(/FOREIGN KEY/)
  })

  it('migration 中途抛错时 foreign_keys 也回到 ON', () => {
    const db = openProductState(MEMORY_DB)
    memDb = db
    seedAtV4(db)
    const bad: Migration = {
      version: 5,
      name: 'bad',
      up: () => {
        throw new Error('模拟迁移失败')
      }
    }

    expect(() => migrate(db, [...PRIOR, bad])).toThrow('模拟迁移失败')

    expect(version(db)).toBe(4)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(() =>
      db
        .prepare(
          'INSERT INTO execution_events (task_id, type, payload, occurred_at) VALUES (?,?,?,?)'
        )
        .run('幽灵task', 'task_started', '{}', '2026-09-07T00:00:02Z')
    ).toThrow(/FOREIGN KEY/)
  })

  it('关外键期间造成悬空引用时，migrate 宁可启动失败', () => {
    const db = openProductState(MEMORY_DB)
    memDb = db
    seedAtV4(db)
    const orphan: Migration = {
      version: 5,
      name: 'orphan',
      up: (d) => {
        d.prepare(
          'INSERT INTO execution_events (task_id, type, payload, occurred_at) VALUES (?,?,?,?)'
        ).run('幽灵task', 'task_started', '{}', '2026-09-07T00:00:02Z')
      }
    }

    // 事务内 foreign_keys 是 OFF，这条插入不会当场报错；
    // migrate 尾部的 foreign_key_check 是唯一的兜底。
    expect(() => migrate(db, [...PRIOR, orphan])).toThrow(/外键悬空/)
  })
})

import { mkdirSync } from 'fs'
import { Migration, MIGRATIONS } from './migrations'
import { dirname, join } from 'path'
import Database from 'better-sqlite3'
import { app } from 'electron'

export type SqliteDatabase = Database.Database
export const MEMORY_DB = ':memory:'

const PRAGMA_JOURNAL_MODE = 'journal_mode'
const PRAGMA_USER_VERSION = 'user_version'
const JOURNAL_MODE_FILE = 'wal'
const JOURNAL_MODE_MEMORY = 'memory'

export function openProductState(filePath: string): SqliteDatabase {
  const isMemory = filePath === MEMORY_DB ? true : false
  if (!isMemory) {
    mkdirSync(dirname(filePath), { recursive: true })
  }
  const db = new Database(filePath)
  db.pragma(`${PRAGMA_JOURNAL_MODE} = 'wal'`)
  const actual = db.pragma(PRAGMA_JOURNAL_MODE, { simple: true })
  const expected = isMemory ? JOURNAL_MODE_MEMORY : JOURNAL_MODE_FILE
  if (actual !== expected) {
    console.error(`[product_db] journal_mode 未生效: 期望 ${expected}, 实际 ${String(actual)}`)
  }
  return db
}

export function migrate(db: SqliteDatabase, migrations: Migration[] = MIGRATIONS): number[] {
  // 把库从当前user_version 推进到注册表最新
  const from: number = db.pragma(PRAGMA_USER_VERSION, { simple: true }) as number

  const pending = migrations.filter((m) => m.version > from).sort((a, b) => a.version - b.version)
  if (pending.length === 0) {
    return []
  }

  const applied: number[] = []
  const runAll = db.transaction(() => {
    for (const m of pending) {
      m.up(db)
      db.pragma(`${PRAGMA_USER_VERSION} = ${m.version}`)
      applied.push(m.version)
    }
  })
  runAll()
  return applied
}

let store: SqliteDatabase | null = null

export function getStore(): SqliteDatabase {
  if (!store) {
    store = openProductState(join(app.getPath('userData'), 'product-state.db'))
    migrate(store)
  }
  return store
}

export function closeStore(): void {
  if (store) {
    store.close()
    store = null
  }
}

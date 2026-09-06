import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import Database from 'better-sqlite3'
import { app } from 'electron'

export type SqliteDatabase = Database.Database

export const MEMORY_DB = ':memory:'

const PRAGMA_JOURNAL_MODE = 'journal_mode'

const JOURNAL_MODE_FILE = 'wal'
const JOURNAL_MODE_MEMORY = 'memory'

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS pdf_files (
    absolute_path TEXT PRIMARY KEY,
    root_id       TEXT NOT NULL,
    name          TEXT NOT NULL,
    modified_at   TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL
  )
`

export function openDatabase(filePath: string): SqliteDatabase {
  const isMemory = filePath === MEMORY_DB
  if (!isMemory) {
    mkdirSync(dirname(filePath), { recursive: true })
  }
  const db = new Database(filePath)
  db.pragma(`${PRAGMA_JOURNAL_MODE} = WAL`)
  const actual = db.pragma(PRAGMA_JOURNAL_MODE, { simple: true })
  const expected = isMemory ? JOURNAL_MODE_MEMORY : JOURNAL_MODE_FILE
  if (actual !== expected) {
    console.error(`[db] journal_mode 未生效: 期望 ${expected}, 实际 ${String(actual)}`)
  }
  db.exec(CREATE_TABLE)
  return db
}

let db: SqliteDatabase | null = null

export function getDb(): SqliteDatabase {
  if (!db) {
    db = openDatabase(join(app.getPath('userData'), 'personal-agent.db'))
  }
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

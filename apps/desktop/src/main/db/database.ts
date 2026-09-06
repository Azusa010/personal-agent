import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import Database from 'better-sqlite3'
import { app } from 'electron/main'

export type SqliteDatabase = Database.Database

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
  if (filePath !== ':memory:') {
    mkdirSync(dirname(filePath), { recursive: true })
  }
  const db = new Database(filePath)
  db.pragma('journal_model=WAL')
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

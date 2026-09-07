import type { SqliteDatabase } from '../database'

export interface Migration {
  version: number
  name: string
  up: (db: SqliteDatabase) => void
}

// 建表SQL
const TASKS_DDL = `
  CREATE TABLE tasks (
    id         TEXT PRIMARY KEY,
    goal       TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed','cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`

export const M0001_CREATE_TASKS: Migration = {
  version: 1,
  name: 'create-tasks',
  up: (db) => {
    db.exec(TASKS_DDL)
  }
}

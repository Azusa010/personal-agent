import { Migration } from './0001-create-tasks'

const TASKS_NEW_DDL = `
  CREATE TABLE tasks_new (
    id         TEXT PRIMARY KEY,
    goal       TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('pending','running','waiting_permission','completed','failed','cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`

const COPY_ROWS_DDL = `
  INSERT INTO tasks_new (id, goal, status, created_at, updated_at)
  SELECT id, goal, status, created_at, updated_at FROM tasks
`

export const M0005_WIDEN_TASK_STATUS: Migration = {
  version: 5,
  name: 'widen-task-status-check',
  up: (db) => {
    db.exec(TASKS_NEW_DDL)
    db.exec(COPY_ROWS_DDL)
    db.exec('DROP TABLE tasks')
    db.exec('ALTER TABLE tasks_new RENAME TO tasks')
  }
}

import { Migration } from './0001-create-tasks'

const PLANS_DDL = `
  CREATE TABLE plans (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL REFERENCES tasks(id),
    version    INTEGER NOT NULL,
    steps      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (task_id, version)
  )
`

export const M0002_CREATE_PLANS: Migration = {
  version: 2,
  name: 'create-plans',
  up: (db) => {
    db.exec(PLANS_DDL)
  }
}

import { Migration } from './0001-create-tasks'

// task_id UNIQUE 是「同一 Task 不创建重复 Reminder」（TASK-023 验收）的数据库级保证。
// idempotency_key 不设 UNIQUE：key = capability:argsHash 不含 taskId，两个不同任务
// 参数恰好相同（同一时刻 + 同一文案）时 key 相等，但那不是重复 Reminder。
const REMINDERS_DDL = `
  CREATE TABLE reminders (
    id              TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL UNIQUE REFERENCES tasks(id),
    tool_call_id    TEXT NOT NULL,
    remind_at       TEXT NOT NULL,
    message         TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('scheduled','firing','fired','failed')),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    fired_at        TEXT,
    failure_reason  TEXT
  )
`

// 启动恢复（TASK-025）按 status='scheduled' 扫 remind_at 决定重挂还是补发，需要到期索引。
const REMINDERS_DUE_INDEX_DDL = `
  CREATE INDEX idx_reminders_due ON reminders (status, remind_at)
`

export const M0007_CREATE_REMINDERS: Migration = {
  version: 7,
  name: 'create-reminders',
  up: (db) => {
    db.exec(REMINDERS_DDL)
    db.exec(REMINDERS_DUE_INDEX_DDL)
  }
}

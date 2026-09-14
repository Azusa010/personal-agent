import { Migration } from './0001-create-tasks'

const TOOL_EXECUTIONS_DDL = `
  CREATE TABLE tool_executions (
    idempotency_key TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES tasks(id),
    tool_call_id    TEXT NOT NULL,
    capability      TEXT NOT NULL,
    args_hash       TEXT NOT NULL,
    source_paths    TEXT NOT NULL,
    target_path     TEXT,
    status          TEXT NOT NULL CHECK (status IN ('attempting','succeeded','failed')),
    attempted_at    TEXT NOT NULL,
    finished_at     TEXT,
    result_payload  TEXT
  )
`

// recovery 启动 pass 按任务扫遗留的 attempting，所以要 task_id 索引。
const TOOL_EXECUTIONS_TASK_INDEX_DDL = `
  CREATE INDEX idx_tool_executions_task ON tool_executions (task_id, attempted_at)
`

export const M0006_CREATE_TOOL_EXECUTIONS: Migration = {
  version: 6,
  name: 'create-tool-executions',
  up: (db) => {
    db.exec(TOOL_EXECUTIONS_DDL)
    db.exec(TOOL_EXECUTIONS_TASK_INDEX_DDL)
  }
}

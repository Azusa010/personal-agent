import { Migration } from './0001-create-tasks'

// status 不含 expired：过期由 pending 与 expires_at 投影得出，不落库
// tool_call_id 加 UNIQUE：一次工具调用只有一次授权机会，过期之后模型重新发起会是新的 callId
const PERMISSIONS_DDL = `
  CREATE TABLE permissions (
    id             TEXT PRIMARY KEY,
    task_id        TEXT NOT NULL REFERENCES tasks(id),
    tool_call_id   TEXT NOT NULL UNIQUE,
    capability     TEXT NOT NULL,
    args_canonical TEXT NOT NULL,
    args_hash      TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('pending','approved','denied')),
    requested_at   TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    decided_at     TEXT,
    source_paths   TEXT NOT NULL,
    target_path    TEXT
  )
`

const PERMISSIONS_TASK_INDEX_DDL = `
  CREATE INDEX idx_permissions_task ON permissions (task_id, requested_at)
`

const PERMISSIONS_HASH_INDEX_DDL = `
  CREATE INDEX idx_permissions_hash ON permissions (args_hash)
`

export const M0004_CREATE_PERMISSIONS: Migration = {
  version: 4,
  name: 'create-permissions',
  up: (db) => {
    db.exec(PERMISSIONS_DDL)
    db.exec(PERMISSIONS_TASK_INDEX_DDL)
    db.exec(PERMISSIONS_HASH_INDEX_DDL)
  }
}

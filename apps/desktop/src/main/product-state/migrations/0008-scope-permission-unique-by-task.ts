import { Migration } from './0001-create-tasks'

/**
 * 把 permissions 的 `tool_call_id UNIQUE` 收窄成 `UNIQUE(task_id, tool_call_id)`。
 *
 * TASK-028 的完整 Golden Path E2E 跑第二遍时撞出来的：`tool_call_id` 只在**任务内**
 * 有意义——它来自模型这一次决策里的 callId（形如 call-1、call-2……），换个任务又从
 * 头数。全局 UNIQUE 于是让第二个任务在 INSERT 上直接报
 * `UNIQUE constraint failed: permissions.tool_call_id`，任务在批准这一步就崩了。
 *
 * 语义上也该按任务域：权限是「本次任务这一条调用」的批准，判断依据是 taskId +
 * toolCallId + argsHash 三者（SEC-005）。跨任务的同名 callId 不是同一条权限。
 *
 * SQLite 改不了已有约束，只能走重建表（与 0005 同一套动作）。这里没有外键指向
 * permissions，所以不必关外键。
 */

const PERMISSIONS_NEW_DDL = `
  CREATE TABLE permissions_new (
    id             TEXT PRIMARY KEY,
    task_id        TEXT NOT NULL REFERENCES tasks(id),
    tool_call_id   TEXT NOT NULL,
    capability     TEXT NOT NULL,
    args_canonical TEXT NOT NULL,
    args_hash      TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('pending','approved','denied')),
    requested_at   TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    decided_at     TEXT,
    source_paths   TEXT NOT NULL,
    target_path    TEXT,
    UNIQUE(task_id, tool_call_id)
  )
`

const COPY_ROWS_DDL = `
  INSERT INTO permissions_new (
    id, task_id, tool_call_id, capability, args_canonical, args_hash,
    status, requested_at, expires_at, decided_at, source_paths, target_path
  )
  SELECT
    id, task_id, tool_call_id, capability, args_canonical, args_hash,
    status, requested_at, expires_at, decided_at, source_paths, target_path
  FROM permissions
`

const TASK_INDEX_DDL = `
  CREATE INDEX idx_permissions_task ON permissions(task_id)
`

export const M0008_SCOPE_PERMISSION_UNIQUE_BY_TASK: Migration = {
  version: 8,
  name: 'scope-permission-unique-by-task',
  up: (db) => {
    db.exec(PERMISSIONS_NEW_DDL)
    db.exec(COPY_ROWS_DDL)
    db.exec('DROP TABLE permissions')
    db.exec('ALTER TABLE permissions_new RENAME TO permissions')
    db.exec(TASK_INDEX_DDL)
  }
}

import type { Migration } from './0001-create-tasks'
import { M0001_CREATE_TASKS } from './0001-create-tasks'
import { M0002_CREATE_PLANS } from './0002-create-plans'
import { M0003_CREATE_EXECUTION_EVENTS } from './0003-create-execution-events'
import { M0004_CREATE_PERMISSIONS } from './0004-create-permissions'
import { M0005_WIDEN_TASK_STATUS } from './0005-widen-task-status-check'
import { M0006_CREATE_TOOL_EXECUTIONS } from './0006-create-tool-executions'
import { M0007_CREATE_REMINDERS } from './0007-create-reminders'
import { M0008_SCOPE_PERMISSION_UNIQUE_BY_TASK } from './0008-scope-permission-unique-by-task'
import { M0009_CREATE_CONVERSATIONS } from './0009-create-conversations'

export type { Migration }

export const MIGRATIONS: Migration[] = [
  M0001_CREATE_TASKS,
  M0002_CREATE_PLANS,
  M0003_CREATE_EXECUTION_EVENTS,
  M0004_CREATE_PERMISSIONS,
  M0005_WIDEN_TASK_STATUS,
  M0006_CREATE_TOOL_EXECUTIONS,
  M0007_CREATE_REMINDERS,
  M0008_SCOPE_PERMISSION_UNIQUE_BY_TASK,
  M0009_CREATE_CONVERSATIONS
]

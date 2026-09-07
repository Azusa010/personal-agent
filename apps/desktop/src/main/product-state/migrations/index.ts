import type { Migration } from './0001-create-tasks'
import { M0001_CREATE_TASKS } from './0001-create-tasks'
import { M0002_CREATE_PLANS } from './0002-create-plans'
import { M0003_CREATE_EXECUTION_EVENTS } from './0003-create-execution-events'

export type { Migration }

export const MIGRATIONS: Migration[] = [
  M0001_CREATE_TASKS,
  M0002_CREATE_PLANS,
  M0003_CREATE_EXECUTION_EVENTS
]

import type { Migration } from './0001-create-tasks'
import { M0001_CREATE_TASKS } from './0001-create-tasks'

export type { Migration }

export const MIGRATIONS: Migration[] = [M0001_CREATE_TASKS]

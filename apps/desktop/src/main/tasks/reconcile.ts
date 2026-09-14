import type { SqliteDatabase } from '../product-state/database'
import type { EventRepository } from '../product-state/event-repository'
import type { TaskRepository } from '../product-state/task-repository'
import { RUNTIME_ERROR_CODE } from '../runtime/error-code'
import type { TaskStatus } from '../../shared/domain'

const ORPHAN_STATUSES: readonly TaskStatus[] = ['running', 'waiting_permission']

export interface ReconcileDeps {
  db: SqliteDatabase
  tasks: TaskRepository
  events: EventRepository
  /** 默认 new Date().toISOString() */
  now?: () => string
}

export function reconcileOrphanTasks(deps: ReconcileDeps): number {
  const orphans = deps.tasks.findAll().filter((c) => ORPHAN_STATUSES.includes(c.status))
  if (orphans.length === 0) {
    return 0
  }
  let reconciled = 0
  for (const task of orphans) {
    try {
      const runAll = deps.db.transaction(() => {
        deps.events.append({
          taskId: task.id,
          type: 'task_failed',
          payload: {
            code: RUNTIME_ERROR_CODE.ORPHANED,
            message: orphanMessage(task.status)
          },
          occurredAt: deps.now?.() ?? new Date().toISOString()
        })
        deps.tasks.updateStatus(task.id, 'failed', deps.now?.() ?? new Date().toISOString())
      })
      runAll()
      reconciled++
    } catch (e) {
      console.error(e)
    }
  }
  return reconciled
}

function orphanMessage(status: TaskStatus): string {
  if (status === 'waiting_permission') {
    return '进程重启时任务停在等待批准，挂起的批准请求与过期定时器已随进程消失'
  }
  return '进程重启时任务未完成，启动时收成 failed'
}

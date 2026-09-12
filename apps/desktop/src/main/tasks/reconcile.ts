import type { SqliteDatabase } from '../product-state/database'
import type { EventRepository } from '../product-state/event-repository'
import type { TaskRepository } from '../product-state/task-repository'
import { RUNTIME_ERROR_CODE } from '../runtime/error-code'

export interface ReconcileDeps {
  db: SqliteDatabase
  tasks: TaskRepository
  events: EventRepository
  /** 默认 new Date().toISOString() */
  now?: () => string
}

export function reconcileOrphanTasks(deps: ReconcileDeps): number {
  // 启动时把上一次进程遗留的 running 任务收成 failed。
  const running = deps.tasks.findAll().filter((c) => c.status === 'running')
  if (running.length === 0) {
    return 0
  }
  let reconciled = 0
  for (const task of running) {
    try {
      const runAll = deps.db.transaction(() => {
        deps.events.append({
          taskId: task.id,
          type: 'task_failed',
          payload: {
            code: RUNTIME_ERROR_CODE.ORPHANED,
            message: '进程重启时任务未完成，启动时收成 failed'
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

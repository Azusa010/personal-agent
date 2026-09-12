import { ERROR_CODE } from '@personal-agent/protocol'
import type { TimelineIpcResult } from '../../shared/ipc-contract'
import type { EventRepository } from '../product-state/event-repository'
import type { PlanRepository } from '../product-state/plan-repository'
import type { TaskRepository } from '../product-state/task-repository'
import { projectTimeline } from '../product-state/timeline-projection'
import { RUNTIME_ERROR_CODE } from '../runtime/error-code'

export interface GetTimelineDeps {
  tasks: TaskRepository
  events: EventRepository
  plans: PlanRepository
}

// taskId 传 null 表示「读最近创建的那个任务」。Renderer 的 state 在应用重启后
// 会清空，
export function getTimeline(taskId: unknown, deps: GetTimelineDeps): TimelineIpcResult {
  let wanted: string | null
  if (taskId === null) {
    wanted = null
  } else if (typeof taskId === 'string' && taskId.length > 0) {
    wanted = taskId
  } else {
    // undefined 也算非法：只有显式 null 才是「最近一个」，
    return {
      ok: false,
      code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
      message: `taskId 非法: ${String(taskId)}`
    }
  }

  try {
    let target = wanted
    if (target === null) {
      const all = deps.tasks.findAll()
      target = all[all.length - 1]?.id ?? null
    }
    if (target === null) {
      return { ok: true, timeline: null }
    }
    return {
      ok: true,
      timeline: projectTimeline(deps.tasks, deps.events, deps.plans, target)
    }
  } catch (err) {
    return {
      ok: false,
      code: RUNTIME_ERROR_CODE.DB_FAILED,
      message: err instanceof Error ? err.message : String(err)
    }
  }
}

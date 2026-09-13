import { afterEach, describe, expect, it } from 'vitest'

import type { PlanStep } from '../../shared/domain'
import { beginTask, currentTask, endTask, recordExecutedCall, TaskBusyError } from './task-context'

const PLAN: readonly PlanStep[] = [
  { description: '列出 Downloads 下的 PDF', capability: 'filesystem.list' },
  { description: '提取目标 PDF 的每页文本', capability: 'document.extract_pdf' },
  { description: '基于页面内容生成带页码引用的摘要' }
]

// 单槽是模块级状态。漏一次 endTask，后面所有测试都活在别人的任务里，
// 而且失败信息会指向毫不相干的断言。
afterEach(() => {
  endTask()
})

describe('task-context：槽位', () => {
  it('一开始没有当前任务', () => {
    expect(currentTask()).toBeNull()
  })

  it('beginTask 返回的对象就是 currentTask 本身', () => {
    // 同一性而不是深相等：策略拿到的是活对象，recordExecutedCall 改的就是它。
    // 返回副本的话计数永远加不上去，ActionAlignment 会一直拿 0 去比对。
    const task = beginTask('task-1', '整理 PDF', PLAN)

    expect(currentTask()).toBe(task)
    expect(task.taskId).toBe('task-1')
    expect(task.goal).toBe('整理 PDF')
  })

  it('executedCalls 从 0 起', () => {
    expect(beginTask('task-1', '整理 PDF', PLAN).executedCalls).toBe(0)
  })

  it('plan 原样保留：不裁剪、不重排、不过滤掉没有 capability 的步骤', () => {
    // 比对基准就是「计划里第 i 个带 capability 的步骤」，这个筛选由
    // checkAlignment 自己做。这里先筛一遍等于把口径改了两处，漂了查不出来。
    const task = beginTask('task-1', '整理 PDF', PLAN)

    expect(task.plan).toEqual(PLAN)
    expect(task.plan).toHaveLength(3)
    expect(task.plan[2]?.capability).toBeUndefined()
  })

  it('endTask 之后槽位空出来', () => {
    beginTask('task-1', '整理 PDF', PLAN)
    endTask()

    expect(currentTask()).toBeNull()
  })

  it('endTask 幂等：连调两次与没有任务时调都不抛', () => {
    // run-task.ts 在 finally 里调它，而 finally 也会在「根本没 begin 成功」的
    // 路径上跑到。抛一次就把真正的错误盖掉了。
    expect(() => {
      endTask()
      endTask()
    }).not.toThrow()

    beginTask('task-1', '整理 PDF', PLAN)
    expect(() => {
      endTask()
      endTask()
    }).not.toThrow()
  })

  it('endTask 之后能 begin 新任务，计数重新开始', () => {
    beginTask('task-1', '整理 PDF', PLAN)
    recordExecutedCall()
    endTask()

    const next = beginTask('task-2', '再整理一次', PLAN)

    expect(next.taskId).toBe('task-2')
    expect(next.executedCalls).toBe(0)
  })
})

describe('task-context：并发只允许一个', () => {
  it('第二个 beginTask 抛 TaskBusyError，并带上正在跑的 taskId', () => {
    beginTask('task-1', '整理 PDF', PLAN)

    // taskId 必须在消息里：UI 上只能看到「有任务在跑」，
    // 得知道是哪一个才查得下去。
    expect(() => beginTask('task-2', '另一个目标', PLAN)).toThrow(TaskBusyError)
    expect(() => beginTask('task-2', '另一个目标', PLAN)).toThrow(/task-1/)
  })

  it('被拒的 beginTask 不顶掉正在跑的任务', () => {
    // 顶掉了比拒绝更糟：第一个任务的调用会拿第二个任务的计划对齐，
    // 判定结果看起来合法却毫无意义。
    const first = beginTask('task-1', '整理 PDF', PLAN)
    recordExecutedCall()

    expect(() => beginTask('task-2', '另一个目标', PLAN)).toThrow(TaskBusyError)
    expect(currentTask()).toBe(first)
    expect(first.executedCalls).toBe(1)
  })

  it('TaskBusyError 是可识别的错误类型，name 钉住', () => {
    // run-task.ts 靠 instanceof 把它翻译成 RUNTIME_TASK_BUSY。
    // name 是日志与 UI 上唯一看得见身份的字段。
    const err = new TaskBusyError('task-9')

    expect(err.name).toBe('TaskBusyError')
    expect(err.runningTaskId).toBe('task-9')
    expect(err.message).toContain('task-9')
    expect(err).toBeInstanceOf(Error)
  })
})

describe('task-context：放行计数', () => {
  it('每放行一次加一，返回加完之后的序号（从 1 起）', () => {
    beginTask('task-1', '整理 PDF', PLAN)

    expect(recordExecutedCall()).toBe(1)
    expect(recordExecutedCall()).toBe(2)
    expect(currentTask()?.executedCalls).toBe(2)
  })

  it('没有当前任务时返回 0 且不抛', () => {
    // 策略只在 agent origin 上调它，所以生产路径上不会没有任务。
    // 但这是个导出的单例函数：记账函数抛异常会把一次已经放行的调用
    // 变成崩溃，代价远大于返回一个没意义的 0。
    expect(recordExecutedCall()).toBe(0)
    expect(currentTask()).toBeNull()
  })

  it('计数只在放行后加：拒绝由调用方不加，所以这里只钉「加了就留得住」', () => {
    beginTask('task-1', '整理 PDF', PLAN)
    recordExecutedCall()

    // 跨调用留得住，ActionAlignment 才有「第几次」可用。
    expect(currentTask()?.executedCalls).toBe(1)
    expect(recordExecutedCall()).toBe(2)
  })
})

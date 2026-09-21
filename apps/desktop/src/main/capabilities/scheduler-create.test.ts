/**
 * scheduler_create 执行体集成测试（TASK-023）。
 *
 * 与 security-matrix.test.ts 的分工：那边用真 broker 验证 fs WRITE 的 Permission
 * 六步与幂等关；这里聚焦 Reminder 存储链路——接线、同事务事件、同参幂等返回、
 * 异参拒绝、事务回滚。批准关用假 gate（自动批准/拒绝）：broker 自己的行为
 * 已由 permission-broker.test.ts 与 security-matrix.test.ts 覆盖，不重放。
 *
 * 验收对应指导书 TASK-023「同一 Task 不创建重复 Reminder」与 PRD US-06
 * 「Reminder 持久化到 SQLite」「同一 Task 和幂等键不得创建重复 Reminder」。
 */
import { ERROR_CODE, type HostExecuteToolParams } from '@personal-agent/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ExecutionEventRecord } from '../../shared/domain'
import type { BoundArgs } from '../policy/argument-binders'
import { UI_ORIGIN, type PermissionGate } from '../policy/execution-policy'
import {
  MEMORY_DB,
  migrate,
  openProductState,
  type SqliteDatabase
} from '../product-state/database'
import { SqliteEventRepository, type EventRepository } from '../product-state/event-repository'
import { SqliteReminderRepository } from '../product-state/reminder-repository'
import { SqliteTaskRepository } from '../product-state/task-repository'
import { SqliteToolExecutionRepository } from '../product-state/tool-execution-repository'
import { createExecutor, REMINDER_CREATED_EVENT, type CapabilityOutcome } from './executor'
import { idempotencyKey } from './idempotency'
import { RuleBasedToolRetriever } from './retriever'
import type { TaskScope } from './scope'

const TASK_ID = 'task-rem'
const T0 = '2026-09-15T09:00:00.000Z'
// 远未来：binder 的「必须晚于当前时刻」检查用真实时钟也不会误伤。
const REMIND_AT = '2099-01-01T00:00:00.000Z'
const MESSAGE = '该阅读 report-2026.pdf 的摘要了'

const SCHEDULER_SCOPE: TaskScope = {
  taskId: TASK_ID,
  capabilities: ['scheduler_create']
}

let db: SqliteDatabase
let reminderRepo: SqliteReminderRepository
let eventRepo: SqliteEventRepository
let execRepo: SqliteToolExecutionRepository
let gateInputs: Array<{ taskId: string; toolCallId: string; capability: string; bound: BoundArgs }>

beforeEach(() => {
  db = openProductState(MEMORY_DB)
  migrate(db)
  new SqliteTaskRepository(db).insert({
    id: TASK_ID,
    goal: '整理下载目录并提醒阅读',
    status: 'running',
    createdAt: T0,
    updatedAt: T0
  })
  reminderRepo = new SqliteReminderRepository(db)
  eventRepo = new SqliteEventRepository(db)
  execRepo = new SqliteToolExecutionRepository(db)
  gateInputs = []
})

afterEach(() => {
  db.close()
})

/** 自动给出固定结论的假批准关。request 的入参原样留档，供断言「批准的是什么」。 */
function makeGate(decision: 'approved' | 'denied'): PermissionGate {
  return {
    request: async (input) => {
      gateInputs.push(input)
      return decision === 'approved'
        ? { approved: true }
        : { approved: false, code: ERROR_CODE.PERMISSION_DENIED, reason: '测试拒绝' }
    },
    verify: async () => ({ ok: true })
  }
}

function makeRun(
  decision: 'approved' | 'denied',
  opts: { events?: EventRepository; withSchedulerWiring?: boolean; withIdempotency?: boolean } = {}
): (params: HostExecuteToolParams) => Promise<CapabilityOutcome> {
  const withWiring = opts.withSchedulerWiring ?? true
  return createExecutor(
    SCHEDULER_SCOPE,
    UI_ORIGIN,
    new RuleBasedToolRetriever(),
    { gate: makeGate(decision), now: () => T0 },
    opts.withIdempotency ? { executions: execRepo, now: () => T0 } : undefined,
    withWiring
      ? {
          db,
          reminders: reminderRepo,
          events: opts.events ?? eventRepo,
          now: () => T0,
          newId: () => 'r-fixed'
        }
      : undefined
  )
}

function params(callId: string, args: Record<string, unknown>): HostExecuteToolParams {
  return { callId, capability: 'scheduler_create', arguments: args }
}

function reminderEvents(): ExecutionEventRecord[] {
  return eventRepo.listByTask(TASK_ID).filter((e) => e.type === REMINDER_CREATED_EVENT)
}

describe('scheduler_create：批准后创建', () => {
  it('批准 → 落库 scheduled，结果带 reminderId/remindAt/status/created:true', async () => {
    const run = makeRun('approved')
    const out = await run(params('tc-r1', { remindAt: REMIND_AT, message: MESSAGE }))

    expect(out).toEqual({
      ok: true,
      reminderId: 'r-fixed',
      remindAt: REMIND_AT,
      status: 'scheduled',
      created: true
    })
    const record = reminderRepo.findByTaskId(TASK_ID)
    expect(record).not.toBeNull()
    expect(record?.status).toBe('scheduled')
    expect(record?.remindAt).toBe(REMIND_AT)
    expect(record?.message).toBe(MESSAGE)
    expect(record?.toolCallId).toBe('tc-r1')
    expect(record?.createdAt).toBe(T0)
    expect(record?.firedAt).toBeNull()
  })

  it('批准面板拿到的是规范化后的时间：+08:00 写法归一成 UTC 再进 gate', async () => {
    // 时间解析确认（US-06）的接线证据：用户在批准面板看到的、Hash 绑定的、
    // 落库的 remindAt 是同一个 UTC 串，不是模型给的原始写法。
    const run = makeRun('approved')
    const out = await run(
      params('tc-r2', { remindAt: '2099-01-01T08:00:00+08:00', message: MESSAGE })
    )

    expect(out['ok']).toBe(true)
    expect(gateInputs).toHaveLength(1)
    expect(gateInputs[0]?.bound.args).toEqual({ remindAt: REMIND_AT, message: MESSAGE })
    expect(reminderRepo.findByTaskId(TASK_ID)?.remindAt).toBe(REMIND_AT)
  })

  it('idempotencyKey 用统一公式 scheduler_create:{argsHash}，重试可命中', async () => {
    const run = makeRun('approved')
    await run(params('tc-r3', { remindAt: REMIND_AT, message: MESSAGE }))

    const bound: BoundArgs = { args: { remindAt: REMIND_AT, message: MESSAGE }, paths: {} }
    expect(reminderRepo.findByTaskId(TASK_ID)?.idempotencyKey).toBe(
      idempotencyKey(TASK_ID, 'scheduler_create', bound)
    )
  })

  it('创建与 reminder_created 事件同事务落库，payload 带齐证据字段', async () => {
    const run = makeRun('approved')
    await run(params('tc-r4', { remindAt: REMIND_AT, message: MESSAGE }))

    const events = reminderEvents()
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({
      reminderId: 'r-fixed',
      toolCallId: 'tc-r4',
      remindAt: REMIND_AT,
      message: MESSAGE,
      idempotencyKey: reminderRepo.findByTaskId(TASK_ID)?.idempotencyKey
    })
    expect(events[0]?.occurredAt).toBe(T0)
  })

  it('事件落库失败 → SCHEDULER_CREATE_FAILED，且 insert 一起回滚（同事务铁证）', async () => {
    const brokenEvents: EventRepository = {
      append: () => {
        throw new Error('event store down')
      },
      listByTask: () => []
    }
    const run = makeRun('approved', { events: brokenEvents })
    const out = await run(params('tc-r5', { remindAt: REMIND_AT, message: MESSAGE }))

    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.SCHEDULER_CREATE_FAILED)
    // 事务回滚：不允许出现「事件丢了但 Reminder 建了」的半状态。
    expect(reminderRepo.findByTaskId(TASK_ID)).toBeNull()
  })

  it('不进 tool_executions：Reminder 的幂等靠 task_id UNIQUE，不靠 fs 幂等关', async () => {
    // 设计决策的钉子：即使接了幂等 wiring，scheduler_create 也不登记执行记录。
    // 它的副作用是库内一行，insert 原子完成，没有需要 recovery resolver 复查的中间态。
    const run = makeRun('approved', { withIdempotency: true })
    const out = await run(params('tc-r6', { remindAt: REMIND_AT, message: MESSAGE }))

    expect(out['ok']).toBe(true)
    expect(execRepo.findByTaskId(TASK_ID)).toEqual([])
  })
})

describe('scheduler_create：拒绝即零副作用', () => {
  it('Deny → PERMISSION_DENIED，reminders 表为空，事件不落', async () => {
    const run = makeRun('denied')
    const out = await run(params('tc-d1', { remindAt: REMIND_AT, message: MESSAGE }))

    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.PERMISSION_DENIED)
    expect(reminderRepo.findByTaskId(TASK_ID)).toBeNull()
    expect(reminderEvents()).toEqual([])
  })

  it('时间在过去 → REMINDER_TIME_IN_PAST，连批准关都不进', async () => {
    const run = makeRun('approved')
    const out = await run(
      params('tc-d2', { remindAt: '1999-01-01T00:00:00.000Z', message: MESSAGE })
    )

    expect(out['code']).toBe(ERROR_CODE.REMINDER_TIME_IN_PAST)
    expect(gateInputs).toEqual([])
    expect(reminderRepo.findByTaskId(TASK_ID)).toBeNull()
  })

  it('没接 Reminder 存储 → NOT_IMPLEMENTED，不半创建状态', async () => {
    const run = makeRun('approved', { withSchedulerWiring: false })
    const out = await run(params('tc-d3', { remindAt: REMIND_AT, message: MESSAGE }))

    expect(out['code']).toBe(ERROR_CODE.NOT_IMPLEMENTED)
  })
})

describe('scheduler_create：同一 Task 不创建重复 Reminder', () => {
  it('同参重试（新 callId）→ created:false 幂等返回同一条，库里仍只有一条', async () => {
    const run = makeRun('approved')
    const first = await run(params('tc-p1', { remindAt: REMIND_AT, message: MESSAGE }))
    const second = await run(params('tc-p2', { remindAt: REMIND_AT, message: MESSAGE }))

    expect(first['created']).toBe(true)
    expect(second).toEqual({
      ok: true,
      reminderId: 'r-fixed',
      remindAt: REMIND_AT,
      status: 'scheduled',
      created: false
    })
    // 数据库级证据：仍只有一条，事件也只落过一次。
    const all = db.prepare('SELECT COUNT(*) AS n FROM reminders').get() as { n: number }
    expect(all.n).toBe(1)
    expect(reminderEvents()).toHaveLength(1)
    expect(reminderRepo.findByTaskId(TASK_ID)?.toolCallId).toBe('tc-p1')
  })

  it('同参重试命中已有记录时，status 返回库里的当前值而不是写死 scheduled', async () => {
    const run = makeRun('approved')
    await run(params('tc-p3', { remindAt: REMIND_AT, message: MESSAGE }))
    // 模拟 TASK-024 的 timer 已把它翻到 firing，重试仍如实回报。
    reminderRepo.transition('r-fixed', 'firing', T0)

    const retry = await run(params('tc-p4', { remindAt: REMIND_AT, message: MESSAGE }))
    expect(retry['status']).toBe('firing')
    expect(retry['created']).toBe(false)
  })

  it('异参再来（改时间）→ REMINDER_ALREADY_EXISTS，旧 Reminder 原样保留', async () => {
    const run = makeRun('approved')
    await run(params('tc-q1', { remindAt: REMIND_AT, message: MESSAGE }))

    const out = await run(
      params('tc-q2', { remindAt: '2099-06-01T00:00:00.000Z', message: MESSAGE })
    )

    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.REMINDER_ALREADY_EXISTS)
    // 静默用旧记录冒充成功 = 对用户刚批准的新时间撒谎，所以必须拒。
    const record = reminderRepo.findByTaskId(TASK_ID)
    expect(record?.remindAt).toBe(REMIND_AT)
    expect(reminderEvents()).toHaveLength(1)
  })

  it('异参再来（改文案）同样拒绝', async () => {
    const run = makeRun('approved')
    await run(params('tc-q3', { remindAt: REMIND_AT, message: MESSAGE }))

    const out = await run(params('tc-q4', { remindAt: REMIND_AT, message: '换个文案' }))
    expect(out['code']).toBe(ERROR_CODE.REMINDER_ALREADY_EXISTS)
  })

  it('别的任务不受影响：每个 Task 各自至多一条', async () => {
    const run = makeRun('approved')
    await run(params('tc-s1', { remindAt: REMIND_AT, message: MESSAGE }))

    new SqliteTaskRepository(db).insert({
      id: 'task-other',
      goal: '另一个任务',
      status: 'running',
      createdAt: T0,
      updatedAt: T0
    })
    const otherScope: TaskScope = { taskId: 'task-other', capabilities: ['scheduler_create'] }
    const otherRun = createExecutor(
      otherScope,
      UI_ORIGIN,
      new RuleBasedToolRetriever(),
      { gate: makeGate('approved'), now: () => T0 },
      undefined,
      { db, reminders: reminderRepo, events: eventRepo, now: () => T0, newId: () => 'r-other' }
    )
    const out = await otherRun(params('tc-s2', { remindAt: REMIND_AT, message: MESSAGE }))

    // 同参不同任务：idempotencyKey 相同但不是重复——task_id 才是唯一键。
    expect(out['ok']).toBe(true)
    expect(out['created']).toBe(true)
    expect(reminderRepo.findByTaskId('task-other')?.id).toBe('r-other')
    expect(reminderRepo.findByTaskId(TASK_ID)?.id).toBe('r-fixed')
  })
})

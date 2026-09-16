/**
 * 失败回归集（TASK-028）：把系统真的弄坏，看它怎么收场。
 *
 * 与 golden-path.test.ts 的分工：那边验「正常路径能跑完」，这边验「坏掉的时候
 * fail-closed」——没有副作用、留下可查的证据、fault 之后还能继续干活。
 *
 * 与 security-matrix.test.ts 的分工：那边逐个撞安全边界（参数篡改、路径逃逸、
 * 过期），不 spawn Python；这边是整条链路的故障注入（真进程被杀、真拒绝、真预算
 * 耗尽、真通知失败），验的是「编排层怎么收场」。
 *
 * 「什么算收场正确」写在 fault-expectations.ts 的期望表里，判定函数是本轮的陪练点。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  configureHostExecutor,
  executeHostTool,
  listVisibleCapabilities,
  resetHostExecutorWiring
} from '../capabilities/host-executor'
import { toPosix } from '../capabilities/roots'
import { repoRoot } from '../eval/paths'
import { createPermissionBroker, type PermissionBroker } from '../permission/permission-broker'
import { migrate, openProductState, type SqliteDatabase } from '../product-state/database'
import { SqliteEventRepository } from '../product-state/event-repository'
import { SqlitePermissionRepository } from '../product-state/permission-repository'
import { SqlitePlanRepository } from '../product-state/plan-repository'
import { SqliteReminderRepository } from '../product-state/reminder-repository'
import { SqliteTaskRepository } from '../product-state/task-repository'
import { SqliteToolExecutionRepository } from '../product-state/tool-execution-repository'
import { fireReminder } from '../scheduler/fire-reminder'
import { ReminderTimerService } from '../scheduler/reminder-timer'
import { PythonSupervisor } from '../runtime/python-supervisor'
import { runTask, type RunTaskDeps } from '../tasks/run-task'
import { realVerificationPorts } from '../verification/ports'
import { verifyTaskCompletion } from '../verification/verify-task'
import type { NotificationPort, NotificationRequest } from '../notifications/notification-port'
import type { PermissionNotice } from '../../shared/domain'
import type { RunTaskIpcResult } from '../../shared/ipc-contract'
import {
  judgeFault,
  type FaultOutcome,
  type FaultScenario,
  type RootState
} from './fault-expectations'

const ROOT = repoRoot()
const VENV_PYTHON = join(ROOT, 'services', 'agent-runtime', '.venv', 'Scripts', 'python.exe')
const RUNTIME_CWD = join(ROOT, 'services', 'agent-runtime')
const FIXTURE_PDF = join(ROOT, 'tests', 'fixtures', 'pdfs', 'three-page-text.pdf')
const DOWNLOADS_ENV = 'PERSONAL_AGENT_DOWNLOADS_DIR'
const SCRIPT_ENV = 'PERSONAL_AGENT_SCRIPT'
const PDF_NAME = 'three-page-text.pdf'
const GOAL = '整理 Downloads 里的 PDF，给出带页码引用的摘要'
const ROOT_PLACEHOLDER = '{{DOWNLOADS_ROOT}}'
const REMIND_PLACEHOLDER = '{{REMIND_AT}}'

type Decision = Record<string, unknown>

const toolCall = (callId: string, capability: string, args: Record<string, unknown>): Decision => ({
  kind: 'tool_call',
  callId,
  capability,
  arguments: args
})
const summary = (pageRefs: number[] = [1]): Decision => ({
  kind: 'summary',
  facts: [{ text: '第一页讲了 fixture 的内容', pageRefs }]
})

/** 完整 Golden Path 的决策序列（路径用占位符，落盘时替换）。 */
function goldenPathDecisions(): Decision[] {
  return [
    toolCall('c-1', 'filesystem.list', { rootId: 'downloads' }),
    toolCall('c-2', 'document.extract_pdf', { path: `${ROOT_PLACEHOLDER}/${PDF_NAME}` }),
    toolCall('c-3', 'filesystem.create_dir', { path: `${ROOT_PLACEHOLDER}/Reading` }),
    toolCall('c-4', 'filesystem.move', {
      source: `${ROOT_PLACEHOLDER}/${PDF_NAME}`,
      target: `${ROOT_PLACEHOLDER}/Reading/${PDF_NAME}`
    }),
    toolCall('c-5', 'scheduler.create', {
      remindAt: REMIND_PLACEHOLDER,
      message: '读一份刚整理好的 PDF'
    }),
    summary([1])
  ]
}

interface WorldOptions {
  decisions: Decision[]
  /** 批准策略。默认全批准；返回 false 就是拒绝 */
  approve?: (capability: string) => boolean
  /** false = 收到请求也不响应（崩溃场景用：批准窗口一直开着，执行体就卡在挂起上） */
  respond?: boolean
  /** 每次批准请求到达时回调（崩溃注入用）。拿到 supervisor 是为了能真杀进程 */
  onRequest?: (capability: string, supervisor: PythonSupervisor) => void
  /** 用损坏的 PDF 替换 fixture */
  corruptPdf?: boolean
  /** 通知发送失败 */
  failNotification?: boolean
  /** 提醒到点时间（默认一小时后） */
  remindAt?: string
}

interface World {
  root: string
  db: SqliteDatabase
  supervisor: PythonSupervisor
  repos: {
    tasks: SqliteTaskRepository
    plans: SqlitePlanRepository
    events: SqliteEventRepository
    permissions: SqlitePermissionRepository
    executions: SqliteToolExecutionRepository
    reminders: SqliteReminderRepository
  }
  close(): Promise<void>
}

const worlds: World[] = []

async function openWorld(options: WorldOptions): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'pa-fault-'))
  const root = join(dir, 'Downloads')
  mkdirSync(root, { recursive: true })
  if (options.corruptPdf === true) {
    // 坏 PDF：pdfjs 会判 PDF_CORRUPT；不是「不存在」，是读得出来但解析不了。
    writeFileSync(join(root, PDF_NAME), '%PDF-1.4\nthis is not a valid pdf body\n')
  } else {
    copyFileSync(FIXTURE_PDF, join(root, PDF_NAME))
  }

  process.env[DOWNLOADS_ENV] = root
  const db = openProductState(join(dir, 'product-state.db'))
  migrate(db)
  const repos = {
    tasks: new SqliteTaskRepository(db),
    plans: new SqlitePlanRepository(db),
    events: new SqliteEventRepository(db),
    permissions: new SqlitePermissionRepository(db),
    executions: new SqliteToolExecutionRepository(db),
    reminders: new SqliteReminderRepository(db)
  }

  const notify = (notice: PermissionNotice): void => {
    if (notice.kind !== 'requested') return
    const capability = notice.permission.capability
    options.onRequest?.(capability, supervisor)
    // 与 golden-path 同一套：broker 先 notify 再登记挂起项，响应等一拍。
    queueMicrotask(() => {
      if (options.respond === false) return
      const decision = options.approve?.(capability) === false ? 'denied' : 'approved'
      broker.respond(notice.permission.id, decision)
    })
  }
  const broker: PermissionBroker = createPermissionBroker({
    permissions: repos.permissions,
    events: repos.events,
    notify
  })

  const notifications: NotificationPort = {
    async send(
      request: NotificationRequest
    ): Promise<{ ok: true } | { ok: false; reason: string }> {
      // 请求内容不影响这个假端口：要么成功、要么回一个稳定的失败原因。
      void request
      return options.failNotification === true ? { ok: false, reason: '通道忙' } : { ok: true }
    }
  }
  const timer = new ReminderTimerService({
    fire: (reminder) =>
      fireReminder(reminder, {
        db,
        reminders: repos.reminders,
        events: repos.events,
        notifications
      })
  })
  configureHostExecutor({
    permission: { gate: broker, tasks: repos.tasks },
    idempotency: { executions: repos.executions },
    scheduler: {
      db,
      reminders: repos.reminders,
      events: repos.events,
      notifications,
      armTimer: (reminder) => timer.arm(reminder)
    }
  })

  const remindAt = options.remindAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const scriptPath = join(dir, 'script.json')
  writeFileSync(
    scriptPath,
    JSON.stringify(options.decisions, null, 2)
      .replaceAll(ROOT_PLACEHOLDER, toPosix(root))
      .replaceAll(REMIND_PLACEHOLDER, remindAt),
    'utf8'
  )

  const supervisor = new PythonSupervisor({
    command: VENV_PYTHON,
    args: ['-m', 'personal_agent'],
    cwd: RUNTIME_CWD,
    env: { ...process.env, [SCRIPT_ENV]: scriptPath },
    capabilities: listVisibleCapabilities(),
    hostHandler: executeHostTool
  })
  supervisor.start()
  await supervisor.initialize()

  const world: World = {
    root: toPosix(root),
    db,
    supervisor,
    repos,
    async close(): Promise<void> {
      await supervisor.stop().catch(() => {})
      timer.dispose()
      broker.dispose()
      resetHostExecutorWiring()
      db.close()
      rmSync(dir, { recursive: true, force: true })
      delete process.env[DOWNLOADS_ENV]
    }
  }
  worlds.push(world)
  return world
}

afterEach(async () => {
  while (worlds.length > 0) {
    await worlds.pop()?.close()
  }
})

function makeDeps(world: World): RunTaskDeps {
  const { tasks, plans, events, ...rest } = world.repos
  return {
    db: world.db,
    tasks,
    plans,
    events,
    send: (method, params, opts) => world.supervisor.request(method, params, opts),
    verify: (input) =>
      verifyTaskCompletion({ tasks, plans, events, ...rest, ...realVerificationPorts }, input)
  }
}

function rootStateOf(world: World, pdfName = PDF_NAME): RootState {
  const entries = readdirSync(world.root)
  const moved = existsSync(join(world.root, 'Reading', pdfName))
  if (moved) return 'moved'
  if (entries.includes('Reading')) return 'reading_only'
  return 'untouched'
}

function collectOutcome(
  scenario: FaultScenario,
  world: World,
  result: RunTaskIpcResult
): FaultOutcome {
  const taskId = result.ok ? result.taskId : ''
  const events = taskId === '' ? [] : world.repos.events.listByTask(taskId)
  const failed = events.filter((e) => e.type === 'task_failed')
  const payload = (failed.at(-1)?.payload ?? {}) as Record<string, unknown>
  const reminder = taskId === '' ? null : world.repos.reminders.findByTaskId(taskId)

  return {
    scenario,
    taskStatus: result.ok ? result.status : 'unknown',
    failureCode: typeof payload['code'] === 'string' ? payload['code'] : null,
    failureReason: (payload['code'] ?? payload['message'] ?? payload['reason'] ?? null) as
      string | null,
    rootState: rootStateOf(world),
    permissions:
      taskId === ''
        ? []
        : world.repos.permissions
            .findByTaskId(taskId)
            .map((p) => ({ capability: p.capability, status: p.status })),
    failedToolCalls: events
      .filter((e) => e.type === 'tool_result')
      .filter((e) => (e.payload as Record<string, unknown>)['ok'] === false)
      .map((e) => String((e.payload as Record<string, unknown>)['capability'])),
    eventTypes: events.map((e) => e.type),
    reminderStatus: reminder?.status ?? null
  }
}

describe.skipIf(!existsSync(VENV_PYTHON))('失败回归集：坏掉的时候怎么收场', () => {
  it('坏 PDF：读不出来就不许往下走，授权根一个字节不动', async () => {
    // 剧本只走「列举 → 提取 → 摘要」：真实模型拿到读不出来的文件也不会继续移动它。
    // 提取失败 → 没有任何合法页码可引 → SummaryVerifier 拒 → 任务 failed，
    // 后面的 WRITE 一步都没机会执行。
    const world = await openWorld({
      decisions: [
        toolCall('c-1', 'filesystem.list', { rootId: 'downloads' }),
        toolCall('c-2', 'document.extract_pdf', { path: `${ROOT_PLACEHOLDER}/${PDF_NAME}` }),
        summary([1])
      ],
      corruptPdf: true
    })

    const result = await runTask(GOAL, makeDeps(world))
    const outcome = collectOutcome('pdf-unreadable', world, result)

    // —— 集成事实（这一层是 E2E 的本职，断言由 AI 保留）——
    expect(outcome.taskStatus).toBe('failed')
    expect(outcome.rootState).toBe('untouched')
    expect(outcome.failedToolCalls).toContain('document.extract_pdf')
    expect(outcome.permissions).toEqual([])
    expect(outcome.failureReason).not.toBeNull()

    // —— 判定（陪练点）——
    const verdict = judgeFault('pdf-unreadable', outcome)
    expect(verdict.ok, verdict.violations.join(' / ')).toBe(true)
    // 底线：授权根被动过的现场不许判通过（副作用只看文件系统）。
    const dirty = judgeFault('pdf-unreadable', { ...outcome, rootState: 'reading_only' })
    expect(dirty.ok).toBe(false)
    expect(dirty.violations.join(' ')).toContain('授权根')
  })

  it('用户拒绝批准：没有任何副作用，任务收成 failed', async () => {
    const world = await openWorld({
      decisions: goldenPathDecisions(),
      approve: (capability) => capability !== 'filesystem.create_dir'
    })

    const result = await runTask(GOAL, makeDeps(world))
    const outcome = collectOutcome('permission-denied', world, result)

    expect(outcome.taskStatus).toBe('failed')
    expect(outcome.rootState).toBe('untouched')
    expect(outcome.permissions.some((p) => p.status === 'denied')).toBe(true)
    expect(outcome.permissions.some((p) => p.status === 'approved')).toBe(false)

    const verdict = judgeFault('permission-denied', outcome)
    expect(verdict.ok, verdict.violations.join(' / ')).toBe(true)
  })

  it('Python 在 WRITE 挂起时被杀：任务落 failed，副作用没有发生', async () => {
    let killed = false
    const world = await openWorld({
      decisions: goldenPathDecisions(),
      // 不响应批准：否则批准已经在手上，执行体在子进程死后仍会把目录建出来
      // （host handler 跑在本进程里，子进程的死不会撤回已放行的调用）。
      respond: false,
      onRequest: (capability, supervisor) => {
        // 第一条 WRITE 挂起的那一刻真杀掉进程：这时批准确认还没回来，
        // 文件系统一个字节都不该动过。
        if (capability === 'filesystem.create_dir' && !killed) {
          killed = true
          const pid = supervisor.pid
          if (pid !== null) process.kill(pid)
        }
      }
    })

    const result = await runTask(GOAL, makeDeps(world))
    const outcome = collectOutcome('python-crashed', world, result)

    expect(killed, '崩溃注入没生效').toBe(true)
    expect(outcome.taskStatus).toBe('failed')
    expect(outcome.rootState).toBe('untouched')
    expect(outcome.failureCode).toBe('RUNTIME_CRASHED')
    // 权限还没结论就崩了：记录停在 pending，由重启后的过期投影收（TASK-018/025）。
    expect(outcome.permissions.map((p) => p.status)).toEqual(['pending'])

    const verdict = judgeFault('python-crashed', outcome)
    expect(verdict.ok, verdict.violations.join(' / ')).toBe(true)
    // 底线：不是崩溃码的现场不许当成崩溃收场对了。
    const wrongCode = judgeFault('python-crashed', { ...outcome, failureCode: 'RUNTIME_TIMEOUT' })
    expect(wrongCode.ok).toBe(false)
    expect(wrongCode.violations.join(' ')).toContain('RUNTIME_CRASHED')
  })

  it('计划外调用被拦下之后模型改对顺序：任务照样完成，但那条失败留痕', async () => {
    const decisions: Decision[] = [
      // 第一步就想移动：计划第一步是 list，所以这条会被 ACTION_NOT_ALIGNED 拒。
      toolCall('c-x', 'filesystem.move', {
        source: `${ROOT_PLACEHOLDER}/${PDF_NAME}`,
        target: `${ROOT_PLACEHOLDER}/Reading/${PDF_NAME}`
      }),
      ...goldenPathDecisions()
    ]
    const world = await openWorld({ decisions })

    const result = await runTask(GOAL, makeDeps(world))
    const outcome = collectOutcome('out-of-plan-call', world, result)

    expect(outcome.taskStatus).toBe('completed')
    expect(outcome.rootState).toBe('moved')
    // 被拒的调用不占计划序号，所以后面五步仍然对得上。
    expect(outcome.failedToolCalls).toEqual(['filesystem.move'])
    expect(outcome.permissions.map((p) => p.status)).toEqual(['approved', 'approved', 'approved'])

    const verdict = judgeFault('out-of-plan-call', outcome)
    expect(verdict.ok, verdict.violations.join(' / ')).toBe(true)
  })

  it('模型一直犯错直到预算耗尽：停在 failed，且留下 budget_exhausted', async () => {
    // 12 条计划外调用（每条都被拒、但都消耗一步）→ 第 13 次循环时预算耗尽。
    const decisions = Array.from({ length: 12 }, (_, i) =>
      toolCall(`c-bad-${i}`, 'filesystem.move', {
        source: `${ROOT_PLACEHOLDER}/${PDF_NAME}`,
        target: `${ROOT_PLACEHOLDER}/Reading/${PDF_NAME}`
      })
    )
    const world = await openWorld({ decisions })

    const result = await runTask(GOAL, makeDeps(world))
    const outcome = collectOutcome('budget-exhausted', world, result)

    expect(outcome.taskStatus).toBe('failed')
    expect(outcome.rootState).toBe('untouched')
    expect(outcome.eventTypes).toContain('budget_exhausted')
    expect(String(outcome.failureReason)).toContain('预算')

    const verdict = judgeFault('budget-exhausted', outcome)
    expect(verdict.ok, verdict.violations.join(' / ')).toBe(true)
  })

  it('通知发送失败：Reminder 收成 failed，任务本身仍是 completed', async () => {
    const world = await openWorld({
      decisions: goldenPathDecisions(),
      failNotification: true,
      remindAt: new Date(Date.now() + 1200).toISOString()
    })

    const result = await runTask(GOAL, makeDeps(world))
    expect(result.ok && result.status).toBe('completed')

    const fired = await waitFor(() => world.repos.reminders.findAll()[0]?.status === 'failed', 8000)
    expect(fired, '通知失败没有被记下来').toBe(true)
    // 到点之后再读一次：失败原因是在那个事务里写的。
    const reminder = world.repos.reminders.findAll()[0]
    const outcome = collectOutcome('notification-failed', world, result)

    expect(outcome.reminderStatus).toBe('failed')
    expect(outcome.eventTypes).toContain('notification_failed')
    expect(outcome.taskStatus).toBe('completed')
    expect(reminder?.failureReason).not.toBeNull()

    const verdict = judgeFault('notification-failed', outcome)
    expect(verdict.ok, verdict.violations.join(' / ')).toBe(true)
    // 底线：completed 却带着 budget_exhausted 的现场是巧合不是通过。
    const dirty = judgeFault('notification-failed', {
      ...outcome,
      eventTypes: [...outcome.eventTypes, 'budget_exhausted']
    })
    expect(dirty.ok).toBe(false)
    expect(dirty.violations.join(' ')).toContain('budget_exhausted')
  })
})

/** 轮询等待。定时器是真实时间，只能等不能推。 */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return condition()
}

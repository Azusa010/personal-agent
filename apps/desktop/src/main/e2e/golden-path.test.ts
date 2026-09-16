/**
 * 完整 Golden Path E2E（TASK-028；前身是 TASK-016 的只读 E2E）。
 *
 * 真 spawn venv 里的 `python -m personal_agent`，真走 host.execute_tool 反向 RPC，
 * 真读一份 fixture PDF，真过批准面板（测试里是「自动批准的假用户」），真建 Reading、
 * 真移动文件、真建 Reminder、真过 TASK-026 的交付物闸口。
 *
 * 唯一的假成分是两个：模型（PERSONAL_AGENT_SCRIPT 指着一份剧本，ScriptedModel 按
 * 剧本吐五步加摘要的决策）与通知端口（不弹真 Windows 通知，用假 port 收结果）。
 *
 * 与 security-matrix.test.ts 的分工：那边不 spawn Python，用全真组件在 host 侧逐个
 * 撞安全边界；这边走真进程，验「整条链路串起来能跑完、且只跑一次」。
 * 与 python-supervisor.test.ts 的往返同一条规矩：venv 不在就整块跳过。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  configureHostExecutor,
  executeHostTool,
  listVisibleCapabilities,
  resetHostExecutorWiring
} from '../capabilities/host-executor'
import { repoRoot } from '../eval/paths'
import { findCapability } from '../capabilities/registry'
import { ROOT_ENV, toPosix } from '../capabilities/roots'
import { createPermissionBroker, type PermissionBroker } from '../permission/permission-broker'
import { migrate, openProductState, type SqliteDatabase } from '../product-state/database'
import { SqliteEventRepository } from '../product-state/event-repository'
import { SqlitePermissionRepository } from '../product-state/permission-repository'
import { SqlitePlanRepository } from '../product-state/plan-repository'
import { SqliteReminderRepository } from '../product-state/reminder-repository'
import { SqliteTaskRepository } from '../product-state/task-repository'
import { SqliteToolExecutionRepository } from '../product-state/tool-execution-repository'
import { projectTimeline } from '../product-state/timeline-projection'
import { fireReminder, NOTIFICATION_TITLE } from '../scheduler/fire-reminder'
import { ReminderTimerService } from '../scheduler/reminder-timer'
import { PythonSupervisor } from '../runtime/python-supervisor'
import { runTask, type RunTaskDeps } from '../tasks/run-task'
import { realVerificationPorts } from '../verification/ports'
import { verifyTaskCompletion } from '../verification/verify-task'
import type { NotificationPort, NotificationRequest } from '../notifications/notification-port'
import type { PermissionNotice } from '../../shared/domain'
import type { RunTaskIpcResult, SummaryFact } from '../../shared/ipc-contract'

// 仓库根由 eval/paths 的 repoRoot 提供（不写死 '../../../../../'：
// 层级被人挪动时会静默指错地方，而找特征文件失败会直接抛错，看得见）。
const ROOT = repoRoot()
const VENV_PYTHON = join(ROOT, 'services', 'agent-runtime', '.venv', 'Scripts', 'python.exe')
const RUNTIME_CWD = join(ROOT, 'services', 'agent-runtime')
const FIXTURE_PDF = join(ROOT, 'tests', 'fixtures', 'pdfs', 'three-page-text.pdf')
const SCRIPT_TEMPLATE = join(ROOT, 'tests', 'fixtures', 'scripts', 'golden-path.json')

const ROUNDS = 20
const GOAL = '整理 Downloads 里的 PDF，给出带页码引用的摘要'
const PDF_NAME = 'three-page-text.pdf'
const READING = 'Reading'
// 与 runtime.py 的 SCRIPT_ENV 是同一个字面量，跨语言没有共享常量表。
// 名字漂了这里会红成 RUNTIME_MODEL_NOT_CONFIGURED，diagnostic() 会把 stderr 带出来。
const SCRIPT_ENV = 'PERSONAL_AGENT_SCRIPT'
const DOWNLOADS_ENV = ROOT_ENV['downloads'] ?? 'PERSONAL_AGENT_DOWNLOADS_DIR'
const ROOT_PLACEHOLDER = '{{DOWNLOADS_ROOT}}'
const REMIND_PLACEHOLDER = '{{REMIND_AT}}'

// 一轮的事件序列：三条权限各两条（请求/结论）+ Python 的五步 + 交付物闸口两条。
// 权限事件先落地：它们在 host 侧的执行过程中写入，而 Python 的事件是整批在 B1 落的。
const PERMISSION_PAIRS = 3
const GOLDEN_EVENT_TYPES = [
  ...Array.from({ length: PERMISSION_PAIRS }, () => [
    'permission_requested',
    'permission_decision'
  ]).flat(),
  // scheduler.create 与 reminder_created 事件同事务落库（executor.ts），
  // 所以它也在 Python 事件批之前——那批是整批在 B1 落的。
  'reminder_created',
  'task_started',
  'tool_called',
  'tool_result',
  'tool_called',
  'tool_result',
  'tool_called',
  'tool_result',
  'tool_called',
  'tool_result',
  'tool_called',
  'tool_result',
  'task_completed',
  // 后两条是 TS 侧的闸口记录（TASK-026）：Python 说完成了，Main 校验交付物后才翻状态。
  'verification_started',
  'verification_passed'
]

// 与 Python 侧 planning.make_plan 的六步逐字一致。跟 SCRIPT_ENV 同一个处境：
// 跨语言没有共享常量表，只能在这儿钉一份当漂移探测器。钉在 E2E 而不是单元测试里
// 的理由：只有这里走真进程，中文描述真的穿过一次 stdin/stdout。
const PLAN_DESCRIPTIONS = [
  '列出 Downloads 下的 PDF',
  '提取目标 PDF 的每页文本',
  '在 Downloads 下创建 Reading 目录',
  '把选中的 PDF 移到 Reading',
  '创建一次性阅读提醒',
  '基于页面内容生成带页码引用的摘要'
]
const PLAN_CAPABILITIES = [
  'filesystem.list',
  'document.extract_pdf',
  'filesystem.create_dir',
  'filesystem.move',
  'scheduler.create',
  undefined
]
// 三个 WRITE 步骤，按计划顺序。批准记录与幂等登记都按它们断言。
const WRITE_STEPS = ['filesystem.create_dir', 'filesystem.move', 'scheduler.create']

let tempDir = ''
let downloadsRoot = ''
let dbPath = ''
let db: SqliteDatabase | null = null
let supervisor: PythonSupervisor | null = null
let broker: PermissionBroker | null = null
let timer: ReminderTimerService | null = null
const stderrChunks: string[] = []
const notified: NotificationRequest[] = []
// 自动批准没成功的话落在这里，由「三条批准记录」那条用例断言为空。
const approveFailures: string[] = []
let expectedFacts: SummaryFact[] = []
let expectedRemindAt = ''
const rounds: RunTaskIpcResult[] = []
let savedDownloadsEnv: string | undefined

const notifications: NotificationPort = {
  async send(request: NotificationRequest): Promise<{ ok: true }> {
    notified.push(request)
    return { ok: true }
  }
}

/** 剧本里 summary 那一项就是期望摘要。不另抄一份，抄了就会漂。 */
function readExpectedFacts(scriptPath: string): SummaryFact[] {
  const items = JSON.parse(readFileSync(scriptPath, 'utf8')) as Array<Record<string, unknown>>
  const summary = items.find((item) => item['kind'] === 'summary')
  if (summary === undefined) throw new Error(`剧本里没有 summary 项: ${scriptPath}`)
  return summary['facts'] as SummaryFact[]
}

/** 把剧本模板的占位符换成这一次运行的实参，落盘。 */
function writeScript(remindAt: string): string {
  const template = readFileSync(SCRIPT_TEMPLATE, 'utf8')
  for (const placeholder of [ROOT_PLACEHOLDER, REMIND_PLACEHOLDER]) {
    if (!template.includes(placeholder)) {
      throw new Error(`剧本模板里没有 ${placeholder}，替换逻辑要跟着改: ${SCRIPT_TEMPLATE}`)
    }
  }
  const path = join(tempDir, `golden-path-${remindAt.replace(/[:.]/g, '-')}.json`)
  writeFileSync(
    path,
    template
      .replaceAll(ROOT_PLACEHOLDER, toPosix(downloadsRoot))
      .replaceAll(REMIND_PLACEHOLDER, remindAt),
    'utf8'
  )
  return path
}

/** 每一轮都把下载根恢复成「干净的一份 PDF」：上一轮的移动会把文件搬进 Reading。 */
function seedDownloads(): void {
  const reading = join(downloadsRoot, READING)
  rmSync(reading, { recursive: true, force: true })
  copyFileSync(FIXTURE_PDF, join(downloadsRoot, PDF_NAME))
}

function diagnostic(): string {
  const tail = stderrChunks
    .join('')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-20)
    .join('\n')
  return `python stderr 末尾:\n${tail === '' ? '（空）' : tail}`
}

function repos(store: SqliteDatabase): {
  tasks: SqliteTaskRepository
  plans: SqlitePlanRepository
  events: SqliteEventRepository
  permissions: SqlitePermissionRepository
  executions: SqliteToolExecutionRepository
  reminders: SqliteReminderRepository
} {
  return {
    tasks: new SqliteTaskRepository(store),
    plans: new SqlitePlanRepository(store),
    events: new SqliteEventRepository(store),
    permissions: new SqlitePermissionRepository(store),
    executions: new SqliteToolExecutionRepository(store),
    reminders: new SqliteReminderRepository(store)
  }
}

function makeDeps(): RunTaskDeps {
  const store = db
  const sup = supervisor
  if (store === null || sup === null) throw new Error('E2E 环境没起来')
  const { tasks, plans, events, ...rest } = repos(store)
  return {
    db: store,
    tasks,
    plans,
    events,
    send: (method, params, opts) => sup.request(method, params, opts),
    // 真判定器 + 真端口：PDF 页号是从 fixture 文件重读出来的，文件位置是真实 stat 的。
    // 这条 E2E 因此同时是闸口的端到端验收，而且这次计划的交付物是齐的（移动 + Reminder）。
    verify: (input) =>
      verifyTaskCompletion({ tasks, plans, events, ...rest, ...realVerificationPorts }, input)
  }
}

function taskIds(): string[] {
  return rounds.map((r) => (r.ok ? r.taskId : ''))
}

async function spawnRuntime(scriptPath: string): Promise<PythonSupervisor> {
  const sup = new PythonSupervisor({
    command: VENV_PYTHON,
    args: ['-m', 'personal_agent'],
    cwd: RUNTIME_CWD,
    env: { ...process.env, [SCRIPT_ENV]: scriptPath },
    capabilities: listVisibleCapabilities(),
    hostHandler: executeHostTool
  })
  sup.on('stderr', (chunk: string) => stderrChunks.push(chunk))
  sup.start()
  try {
    await sup.initialize()
  } catch (e) {
    throw new Error(`握手失败: ${e instanceof Error ? e.message : String(e)}\n${diagnostic()}`)
  }
  return sup
}

describe.skipIf(!existsSync(VENV_PYTHON))(
  '完整 Golden Path E2E：真 Python + 真批准 + 真移动 + 真提醒',
  () => {
    beforeAll(async () => {
      if (!existsSync(FIXTURE_PDF)) throw new Error(`缺固定 PDF: ${FIXTURE_PDF}`)

      tempDir = mkdtempSync(join(tmpdir(), 'pa-golden-'))
      downloadsRoot = join(tempDir, 'Downloads')
      mkdirSync(downloadsRoot, { recursive: true })
      seedDownloads()

      // 授权根是 host 侧（也就是本进程）读的，不在子进程 env 里。
      savedDownloadsEnv = process.env[DOWNLOADS_ENV]
      process.env[DOWNLOADS_ENV] = downloadsRoot

      dbPath = join(tempDir, 'product-state.db')
      db = openProductState(dbPath)
      migrate(db)
      const store = db
      const { tasks, events, permissions, executions, reminders } = repos(store)

      // 假用户：权限一挂起就批准。响应要等一拍——broker 是「先 notify 再登记挂起项」，
      // 同步 respond 会撞上「批准窗口已经关闭」（真实用户当然也是过一会儿才点）。
      broker = createPermissionBroker({
        permissions,
        events,
        notify: (notice: PermissionNotice) => {
          if (notice.kind !== 'requested') return
          queueMicrotask(() => {
            const result = broker?.respond(notice.permission.id, 'approved')
            if (result === undefined || !result.ok) {
              approveFailures.push(`${notice.permission.capability}: ${JSON.stringify(result)}`)
            }
          })
        }
      })
      timer = new ReminderTimerService({
        fire: (reminder) => fireReminder(reminder, { db: store, reminders, events, notifications })
      })
      configureHostExecutor({
        permission: { gate: broker, tasks },
        idempotency: { executions },
        scheduler: {
          db: store,
          reminders,
          events,
          notifications,
          armTimer: (reminder) => timer?.arm(reminder)
        }
      })

      // 提醒时间取跑起来的「一小时后」：20 轮不等它触发，触发路径由下面单独一条用例验。
      expectedRemindAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      const scriptPath = writeScript(expectedRemindAt)
      expectedFacts = readExpectedFacts(scriptPath)

      supervisor = await spawnRuntime(scriptPath)
    }, 60_000)

    afterAll(async () => {
      await supervisor?.stop().catch(() => {})
      supervisor = null
      timer?.dispose()
      timer = null
      broker?.dispose()
      broker = null
      resetHostExecutorWiring()
      db?.close()
      db = null
      if (savedDownloadsEnv === undefined) delete process.env[DOWNLOADS_ENV]
      else process.env[DOWNLOADS_ENV] = savedDownloadsEnv
      if (tempDir !== '') rmSync(tempDir, { recursive: true, force: true })
    }, 30_000)

    it('握手时下发的清单就是完整 Golden Path 的五个能力', () => {
      const visible = listVisibleCapabilities()

      expect(visible.map((c) => c.name)).toEqual(PLAN_CAPABILITIES.filter(Boolean))
      // READ 两个 + WRITE 三个；notification.send 不在内（它由 Reminder 到点触发）。
      expect(visible.filter((c) => c.kind === 'READ')).toHaveLength(2)
      expect(visible.filter((c) => c.kind === 'WRITE')).toHaveLength(3)
    })

    it(`连跑 ${ROUNDS} 轮全部 completed，且每轮摘要逐字相同`, async () => {
      for (let i = 0; i < ROUNDS; i++) {
        seedDownloads()
        rounds.push(await runTask(GOAL, makeDeps()))
      }

      expect(rounds, diagnostic()).toHaveLength(ROUNDS)
      // 逐个报出问题轮次，而不是只给一句 toBe(false)：20 轮里哪一轮坏了得看得见。
      const broken = rounds
        .map((r, i) => {
          if (!r.ok) return `#${i + 1} ${r.code}: ${r.message}`
          if (r.status !== 'completed') return `#${i + 1} failed: ${r.reason ?? '（无 reason）'}`
          return null
        })
        .filter((line): line is string => line !== null)
      expect(broken, diagnostic()).toEqual([])

      // completed 本身就说明闸口放行了完整交付物（摘要页码 + 文件到位 + 批准 + Reminder）。
      for (const r of rounds) {
        expect(r.ok && r.facts).toEqual(expectedFacts)
      }
      expect(new Set(taskIds()).size).toBe(ROUNDS)
    }, 300_000)

    it('每轮真的产生了副作用：PDF 进了 Reading、源目录里只剩 Reading', () => {
      const entries = readdirSync(downloadsRoot).sort()

      expect(entries).toEqual([READING])
      expect(existsSync(join(downloadsRoot, READING, PDF_NAME))).toBe(true)
      // 移动后的字节与原文件一致：搬的是同一份，不是复制出一份截断的。
      expect(readFileSync(join(downloadsRoot, READING, PDF_NAME)).byteLength).toBe(
        readFileSync(FIXTURE_PDF).byteLength
      )
    })

    it('每轮三条 WRITE 都等到了批准：三条批准记录、状态 approved', () => {
      const store = db as SqliteDatabase
      const permissions = new SqlitePermissionRepository(store)

      for (const taskId of taskIds()) {
        const records = permissions.findByTaskId(taskId)

        expect(approveFailures, taskId).toEqual([])
        expect(
          records.map((p) => p.capability),
          taskId
        ).toEqual(WRITE_STEPS)
        expect(
          records.every((p) => p.status === 'approved'),
          taskId
        ).toBe(true)
      }
    })

    it('文件类副作用登记在幂等表里：两条 succeeded，调度不登记', () => {
      // scheduler.create 是 WRITE 但不进幂等关：它的副作用是库内一行 + task_id UNIQUE，
      // 没有需要 recovery resolver 复查的中间态（executor.ts 里有这段推导）。
      const store = db as SqliteDatabase
      const executions = new SqliteToolExecutionRepository(store)

      for (const taskId of taskIds()) {
        const rows = executions.findByTaskId(taskId)

        expect(
          rows.map((r) => r.capability),
          taskId
        ).toEqual(['filesystem.create_dir', 'filesystem.move'])
        expect(
          rows.every((r) => r.status === 'succeeded'),
          taskId
        ).toBe(true)
      }
    })

    it('每轮落一条 Reminder，时间就是剧本里那个未来时刻，且定时器挂上了', () => {
      const store = db as SqliteDatabase
      const reminders = new SqliteReminderRepository(store)

      for (const taskId of taskIds()) {
        const reminder = reminders.findByTaskId(taskId)

        expect(reminder, taskId).not.toBeNull()
        expect(reminder?.status).toBe('scheduled')
        expect(reminder?.remindAt).toBe(expectedRemindAt)
        expect(reminder?.message).toContain(PDF_NAME)
        // 挂表是「应用重启后还能触发」的前提；恢复路径另有十例测试（TASK-025）。
        expect(timer?.isArmed(reminder?.id ?? ''), taskId).toBe(true)
      }
    })

    it('每轮事件流形状一致：六条权限事件 + 五步工具 + 闸口两条', () => {
      const deps = makeDeps()
      const perRound = GOLDEN_EVENT_TYPES.length

      for (const [i, taskId] of taskIds().entries()) {
        const timeline = projectTimeline(deps.tasks, deps.events, deps.plans, taskId)
        const seqs = timeline?.events.map((e) => e.seq) ?? []
        const first = seqs[0] ?? -1

        expect(timeline?.task.status).toBe('completed')
        expect(timeline?.events.map((e) => e.type)).toEqual(GOLDEN_EVENT_TYPES)
        // seq 是整表自增、跨任务接着走的，所以只能钉「一轮占满若干条且连续」。
        expect(first).toBe(i * perRound + 1)
        expect(seqs).toEqual(Array.from({ length: perRound }, (_, j) => first + j))
      }
    })

    it('每轮都落一份 v1 计划，内容从 Python 回传且逐字稳定', () => {
      const deps = makeDeps()

      for (const taskId of taskIds()) {
        const plan = projectTimeline(deps.tasks, deps.events, deps.plans, taskId)?.plan

        expect(plan?.version).toBe(1)
        expect(plan?.steps.map((s) => s.capability)).toEqual(PLAN_CAPABILITIES)
        // 编码错的话这里就是一串 mojibake，而上面那条 capability 断言照样绿。
        expect(plan?.steps.map((s) => s.description)).toEqual(PLAN_DESCRIPTIONS)
        // 计划里出现的能力必须在 registry 里，而且都是这次任务 Scope 放行的五个。
        for (const step of plan?.steps ?? []) {
          if (step.capability === undefined) continue
          const found = findCapability(step.capability)
          expect(found, `${step.capability} 不在 registry 里`).not.toBeNull()
          expect(PLAN_CAPABILITIES).toContain(step.capability)
        }
      }
    })

    it('重开数据库后，最后一轮的摘要正文与计划仍读得回来', () => {
      const lastTaskId = taskIds()[ROUNDS - 1]
      db?.close()
      db = openProductState(dbPath)
      const deps = makeDeps()

      const timeline = projectTimeline(deps.tasks, deps.events, deps.plans, lastTaskId)
      const completed = timeline?.events.filter((e) => e.type === 'task_completed')

      expect(completed).toHaveLength(1)
      expect(completed?.[0]?.payload).toEqual({
        factCount: expectedFacts.length,
        facts: expectedFacts
      })
      expect(timeline?.plan?.steps).toHaveLength(PLAN_DESCRIPTIONS.length)
      expect(timeline?.task.status).toBe('completed')
    })
  }
)

describe.skipIf(!existsSync(VENV_PYTHON))('提醒到点：真定时器 + 假通知端口', () => {
  it('剧本里的提醒时间到了就发一次通知，并记录结果', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-golden-fire-'))
    const root = join(dir, 'Downloads')
    mkdirSync(root, { recursive: true })
    const savedRoot = process.env[DOWNLOADS_ENV]
    process.env[DOWNLOADS_ENV] = root

    const store = openProductState(join(dir, 'product-state.db'))
    migrate(store)
    const { tasks, events, permissions, executions, reminders } = repos(store)
    const sent: NotificationRequest[] = []
    const port: NotificationPort = {
      async send(request: NotificationRequest): Promise<{ ok: true }> {
        sent.push(request)
        return { ok: true }
      }
    }
    const service = new ReminderTimerService({
      fire: (reminder) =>
        fireReminder(reminder, { db: store, reminders, events, notifications: port })
    })
    const autoBroker = createPermissionBroker({
      permissions,
      events,
      notify: (notice: PermissionNotice) => {
        // 与主 describe 同一套：broker 先 notify 再登记挂起项，响应等一拍。
        if (notice.kind === 'requested') {
          queueMicrotask(() => autoBroker.respond(notice.permission.id, 'approved'))
        }
      }
    })
    configureHostExecutor({
      permission: { gate: autoBroker, tasks },
      idempotency: { executions },
      scheduler: {
        db: store,
        reminders,
        events,
        notifications: port,
        armTimer: (r) => service.arm(r)
      }
    })

    let sup: PythonSupervisor | null = null
    try {
      copyFileSync(FIXTURE_PDF, join(root, PDF_NAME))
      // 1.2 秒后到点：够走完五步，又不用等太久。
      const remindAt = new Date(Date.now() + 1200).toISOString()
      const template = readFileSync(SCRIPT_TEMPLATE, 'utf8')
      const scriptPath = join(dir, 'fire.json')
      writeFileSync(
        scriptPath,
        template
          .replaceAll(ROOT_PLACEHOLDER, toPosix(root))
          .replaceAll(REMIND_PLACEHOLDER, remindAt),
        'utf8'
      )
      sup = await spawnRuntime(scriptPath)

      const result = await runTask(GOAL, makeDepsWith(store, sup))
      expect(result.ok && result.status, JSON.stringify(result)).toBe('completed')

      const reminder = reminders.findAll()[0]
      expect(reminder?.status).toBe('scheduled')

      // 等到点：真定时器，真 fireReminder，假端口收结果。
      const fired = await waitFor(() => reminders.findAll()[0]?.status === 'fired', 8000)
      expect(fired, '提醒没有到点触发').toBe(true)
      expect(sent).toEqual([{ title: NOTIFICATION_TITLE, body: reminder?.message }])

      const firedEvents = new SqliteEventRepository(store)
        .listByTask(reminder?.taskId ?? '')
        .filter((e) => e.type === 'notification_sent')
      expect(firedEvents).toHaveLength(1)
      expect(reminders.findAll()[0]?.firedAt).not.toBeNull()
    } finally {
      await sup?.stop().catch(() => {})
      service.dispose()
      autoBroker.dispose()
      resetHostExecutorWiring()
      store.close()
      if (savedRoot === undefined) delete process.env[DOWNLOADS_ENV]
      else process.env[DOWNLOADS_ENV] = savedRoot
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  /** 与主 describe 的 makeDeps 同形，但用的是这一轮自己的库与进程。 */
  function makeDepsWith(store: SqliteDatabase, sup: PythonSupervisor): RunTaskDeps {
    const { tasks, plans, events, ...rest } = repos(store)
    return {
      db: store,
      tasks,
      plans,
      events,
      send: (method, params, opts) => sup.request(method, params, opts),
      verify: (input) =>
        verifyTaskCompletion({ tasks, plans, events, ...rest, ...realVerificationPorts }, input)
    }
  }
})

/** 轮询等待一个条件成立。定时器是真实时间，所以只能等，不能推进。 */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return condition()
}

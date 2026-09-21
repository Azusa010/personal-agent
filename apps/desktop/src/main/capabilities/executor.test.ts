import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CapabilityFailure,
  DocumentExtractPdfOutcome,
  ERROR_CODE,
  FilesystemListResult,
  HostExecuteToolResult,
  NotificationSendResult,
  type HostExecuteToolParams
} from '@personal-agent/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createExecutor, REMINDER_CREATED_EVENT, type ExecutorSchedulerWiring } from './executor'
import type { ReminderRecord } from '../../shared/domain'
import type {
  NotificationOutcome,
  NotificationPort,
  NotificationRequest
} from '../notifications/notification-port'
import { UI_ORIGIN, type PermissionGate } from '../policy/execution-policy'
import {
  MEMORY_DB,
  migrate,
  openProductState,
  type SqliteDatabase
} from '../product-state/database'
import { SqliteEventRepository } from '../product-state/event-repository'
import { SqliteReminderRepository } from '../product-state/reminder-repository'
import { SqliteTaskRepository } from '../product-state/task-repository'
import {
  fireReminder,
  NOTIFICATION_FAILED_EVENT,
  NOTIFICATION_SENT_EVENT,
  NOTIFICATION_TITLE
} from '../scheduler/fire-reminder'
import { ReminderTimerService, type TimerHandle } from '../scheduler/reminder-timer'
import { buildCorruptPdf, buildEncryptedPdf, buildPdf } from './pdf-fixtures'
import { RuleBasedToolRetriever, type AuthorizeDenialCode, type ToolRetriever } from './retriever'
import { toPosix } from './roots'
import { readOnlyScope, type TaskScope } from './scope'

const ENV_NAME = 'PERSONAL_AGENT_DOWNLOADS_DIR'

let dir: string
let run: (params: HostExecuteToolParams) => Promise<Record<string, unknown>>

function params(
  capability: HostExecuteToolParams['capability'],
  args: Record<string, unknown>
): HostExecuteToolParams {
  return { callId: 'tc-9f3a', capability, arguments: args }
}

/** 拒绝一切的 retriever。用来证明 authorize 在分发之前。 */
function denyRetriever(code: AuthorizeDenialCode): ToolRetriever {
  return {
    listVisible: () => [],
    authorize: (_scope, name) => ({
      allowed: false,
      code,
      name,
      reason: `测试拒绝: ${name}`
    })
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-exec-'))
  vi.stubEnv(ENV_NAME, dir)
  // ui origin：本文件测的是契约校验、路径关卡、错误码三件事，
  // 不该被任务槽耦合进去。agent origin 的行为在 execution-policy.test.ts。
  run = createExecutor(readOnlyScope('task-1'), UI_ORIGIN)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

describe('executor：authorize 是唯一关口（TEST-005）', () => {
  it('Scope 外的 WRITE 能力回 CAPABILITY_OUT_OF_SCOPE，而不是 NOT_IMPLEMENTED', async () => {
    // 四个 WRITE 能力在 registry 里都有描述符但都没有执行体。
    // 若 authorize 不在分发之前，这里会落到 default 分支返回 NOT_IMPLEMENTED。
    // 用码的区别证明顺序，比 spy 更直接。
    const out = await run(params('filesystem_move', { from: 'a', to: 'b' }))
    expect(out['code']).toBe(ERROR_CODE.CAPABILITY_OUT_OF_SCOPE)
  })

  it('readOnlyScope 放行两个 READ 能力', async () => {
    // 空目录，filesystem_list 成功返回空 entries。
    const out = await run(params('filesystem_list', { rootId: 'downloads' }))
    expect(out['ok']).toBe(true)
  })

  it('被 authorize 拒绝时执行体没有运行', async () => {
    // 根指向不存在的目录：若执行体跑了会返回 FILESYSTEM_ROOT_UNAVAILABLE。
    // 返回 CAPABILITY_OUT_OF_SCOPE 就证明 listPdfs 一次都没被调用。
    vi.stubEnv(ENV_NAME, join(dir, 'nope'))
    const denied = createExecutor(
      readOnlyScope('task-1'),
      UI_ORIGIN,
      denyRetriever('CAPABILITY_OUT_OF_SCOPE')
    )
    const out = await denied(params('filesystem_list', { rootId: 'downloads' }))
    expect(out['code']).toBe(ERROR_CODE.CAPABILITY_OUT_OF_SCOPE)
  })

  it('未注册能力回 CAPABILITY_NOT_REGISTERED', async () => {
    // 两个拒绝码必须分开：NOT_REGISTERED 说明模型幻觉出一个不存在的工具，
    // OUT_OF_SCOPE 说明工具存在但这个任务不许用。混成一个码之后
    // RISK-005 的"错工具"和"越权"在日志里分不开。
    const denied = createExecutor(
      readOnlyScope('task-1'),
      UI_ORIGIN,
      denyRetriever('CAPABILITY_NOT_REGISTERED')
    )
    const out = await denied(params('filesystem_list', { rootId: 'downloads' }))
    expect(out['code']).toBe(ERROR_CODE.CAPABILITY_NOT_REGISTERED)
  })
})

describe('executor：arguments 二次校验', () => {
  it('rootId 不在白名单 -> INVALID_ARGUMENT', async () => {
    // envelope 层的 arguments 是 z.record(z.string(), z.unknown())，
    // 什么都能过。收窄只能在这里做。
    const out = await run(params('filesystem_list', { rootId: 'system32' }))
    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.INVALID_ARGUMENT)
  })

  it('缺 rootId -> INVALID_ARGUMENT', async () => {
    const out = await run(params('filesystem_list', {}))
    expect(out['code']).toBe(ERROR_CODE.INVALID_ARGUMENT)
  })

  it('rootId 类型错 -> INVALID_ARGUMENT', async () => {
    const out = await run(params('filesystem_list', { rootId: 123 }))
    expect(out['code']).toBe(ERROR_CODE.INVALID_ARGUMENT)
  })

  it('path 为空 -> INVALID_ARGUMENT', async () => {
    const out = await run(params('document_extract_pdf', { path: '' }))
    expect(out['code']).toBe(ERROR_CODE.INVALID_ARGUMENT)
  })

  it('缺 path -> INVALID_ARGUMENT', async () => {
    const out = await run(params('document_extract_pdf', {}))
    expect(out['code']).toBe(ERROR_CODE.INVALID_ARGUMENT)
  })

  it('INVALID_ARGUMENT 是单数拼写', () => {
    // 钉值。写成复数 INVALID_ARGUMENTS 的话，与 errors.ts 里的键不一致，
    // TS 会在编译期报 undefined 属性，但 Python 侧 engine 的码表匹配是
    // 字符串比较，漂移只会表现为"未知错误码"。
    expect(ERROR_CODE.INVALID_ARGUMENT).toBe('INVALID_ARGUMENT')
  })
})

describe('executor：filesystem_list', () => {
  it('成功时 ok 是 boolean true', async () => {
    await writeFile(join(dir, 'a.pdf'), 'A')
    const out = await run(params('filesystem_list', { rootId: 'downloads' }))

    // toBe 是严格相等：ok 写成字符串 'true' 的话这里就红。
    // 契约里 HostExecuteToolResult 钉的是 z.boolean()。
    expect(out['ok']).toBe(true)
    expect(Array.isArray(out['entries'])).toBe(true)
  })

  it('成功输出同时过 envelope 层与 payload 层契约', async () => {
    await writeFile(join(dir, 'a.pdf'), 'A')
    const out = await run(params('filesystem_list', { rootId: 'downloads' }))

    // 两层各管一件事：HostExecuteToolResult 钉 ok 是 boolean，
    // FilesystemListResult 钉 entries 形状。只过其中一层证明不了 wire 合法
    //（z.object 会把 ok strip 掉）。
    expect(() => HostExecuteToolResult.parse(out)).not.toThrow()
    expect(() => FilesystemListResult.parse(out)).not.toThrow()
  })

  it('根目录不存在 -> FILESYSTEM_ROOT_UNAVAILABLE', async () => {
    vi.stubEnv(ENV_NAME, join(dir, 'nope'))
    const out = await run(params('filesystem_list', { rootId: 'downloads' }))
    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.FILESYSTEM_ROOT_UNAVAILABLE)
    // reason 里要带原始 errno，否则"目录不存在"和"没权限"分不开。
    expect(String(out['reason'])).toContain('ENOENT')
  })

  it('根是文件而不是目录 -> FILESYSTEM_ROOT_UNAVAILABLE', async () => {
    const filePath = join(dir, 'not-a-dir')
    await writeFile(filePath, 'x')
    vi.stubEnv(ENV_NAME, filePath)
    const out = await run(params('filesystem_list', { rootId: 'downloads' }))
    expect(out['code']).toBe(ERROR_CODE.FILESYSTEM_ROOT_UNAVAILABLE)
    expect(String(out['reason'])).toContain('ENOTDIR')
  })

  it('失败输出过 CapabilityFailure 契约', async () => {
    vi.stubEnv(ENV_NAME, join(dir, 'nope'))
    const out = await run(params('filesystem_list', { rootId: 'downloads' }))
    expect(() => CapabilityFailure.parse(out)).not.toThrow()
  })
})

describe('executor：document_extract_pdf', () => {
  it('真 PDF 返回 pages 且过判别联合契约', async () => {
    const pdfPath = join(dir, 'report.pdf')
    await writeFile(pdfPath, buildPdf(['page one text', 'page two text']))

    const out = await run(params('document_extract_pdf', { path: pdfPath }))
    expect(out['ok']).toBe(true)
    expect(() => DocumentExtractPdfOutcome.parse(out)).not.toThrow()

    const parsed = DocumentExtractPdfOutcome.parse(out)
    if (parsed.ok) {
      expect(parsed.pages).toHaveLength(2)
      expect(parsed.pages[0]).toEqual({ pageNumber: 1, text: 'page one text' })
    } else {
      throw new Error('期望成功分支')
    }
  })

  it('根外绝对路径 -> PATH_OUT_OF_ROOT', async () => {
    const outside = join(tmpdir(), 'pa-outside-secret.pdf')
    await writeFile(outside, buildPdf(['secret']))
    try {
      const out = await run(params('document_extract_pdf', { path: outside }))
      expect(out['ok']).toBe(false)
      expect(out['code']).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
    } finally {
      await rm(outside, { force: true })
    }
  })

  it('.. 逃逸 -> PATH_OUT_OF_ROOT', async () => {
    // 模型给出的路径不可信（SEC-006）。resolve 会吃掉 '..'，
    // 所以先 resolve 再前缀比较才挡得住。
    const out = await run(
      params('document_extract_pdf', { path: join(dir, '..', '..', 'secret.pdf') })
    )
    expect(out['code']).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
  })

  it('同名前缀的兄弟目录 -> PATH_OUT_OF_ROOT', async () => {
    // 不补分隔符时 startsWith 会误判通过（实测 'D:/pa-root-evil/x'
    // .startsWith('D:/pa-root') === true）。
    const evilDir = `${dir}-evil`
    await mkdir(evilDir, { recursive: true })
    await writeFile(join(evilDir, 'x.pdf'), buildPdf(['x']))
    try {
      const out = await run(params('document_extract_pdf', { path: join(evilDir, 'x.pdf') }))
      expect(out['code']).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
    } finally {
      await rm(evilDir, { recursive: true, force: true })
    }
  })

  it('根内不存在的文件 -> FILE_UNREADABLE', async () => {
    const out = await run(params('document_extract_pdf', { path: join(dir, 'ghost.pdf') }))
    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.FILE_UNREADABLE)
    expect(String(out['reason'])).toContain('ENOENT')
  })

  it('拿根目录当文件 -> FILE_UNREADABLE', async () => {
    // path-guard 放行 candidate === root（不算越界），
    // readFile 抛 EISDIR，必须被接住而不是冒泡成 HOST_HANDLER_FAILED。
    const out = await run(params('document_extract_pdf', { path: dir }))
    expect(out['code']).toBe(ERROR_CODE.FILE_UNREADABLE)
    expect(String(out['reason'])).toContain('EISDIR')
  })

  it('PDF 业务失败原样透传，不改码', async () => {
    // extractPdf 自己返回 PDF_EMPTY / PDF_CORRUPT / PDF_ENCRYPTED /
    // PDF_NO_TEXT。executor 不能把它们改写成别的码，否则
    // document-extract-pdf.test.ts 钉的稳定码在这一层就丢了。
    const cases: { name: string; bytes: Uint8Array; code: string }[] = [
      { name: 'empty.pdf', bytes: new Uint8Array(0), code: 'PDF_EMPTY' },
      { name: 'corrupt.pdf', bytes: buildCorruptPdf(), code: 'PDF_CORRUPT' },
      { name: 'encrypted.pdf', bytes: buildEncryptedPdf(), code: 'PDF_ENCRYPTED' }
    ]
    for (const c of cases) {
      const full = join(dir, c.name)
      await writeFile(full, c.bytes)
      const out = await run(params('document_extract_pdf', { path: full }))
      expect(out['ok'], c.name).toBe(false)
      expect(out['code'], c.name).toBe(c.code)
      expect(() => CapabilityFailure.parse(out), c.name).not.toThrow()
    }
  })
})

describe('executor：永不 throw', () => {
  it('所有失败输入都返回 ok:false，没有一条冒泡成异常', async () => {
    // 冒泡的话 supervisor 的 catch 会把 code 写死成 HOST_HANDLER_FAILED，
    // 精确码全丢。这里直接 await：抛了测试就红。
    vi.stubEnv(ENV_NAME, join(dir, 'nope'))
    const inputs: HostExecuteToolParams[] = [
      params('filesystem_list', { rootId: 'downloads' }),
      params('filesystem_list', { rootId: 'nope' }),
      params('filesystem_list', {}),
      params('document_extract_pdf', { path: '' }),
      params('document_extract_pdf', { path: 'C:/Windows/win.ini' }),
      params('document_extract_pdf', { path: join(dir, 'ghost.pdf') }),
      params('filesystem_move', { from: 'a', to: 'b' }),
      params('scheduler_create', {}),
      params('notification_send', {})
    ]
    for (const input of inputs) {
      const out = await run(input)
      expect(out['ok'], input.capability).toBe(false)
      expect(typeof out['code'], input.capability).toBe('string')
      expect(() => CapabilityFailure.parse(out), input.capability).not.toThrow()
    }
  })

  it('执行体没接线的能力回 NOT_IMPLEMENTED', async () => {
    // TASK-024 之后六个能力都有了 binder + 执行体分支，switch 的 default
    // 兜底不再能从真实能力名到达（保留它是防「加了 binder 忘了执行体」的
    // 静默漂移）。NOT_IMPLEMENTED 现在从分支内部来：执行体在、依赖没接。
    // 用假 retriever 放行一切，kind 写 READ 是为了把「没接线」与「需要批准」
    // 隔开：WRITE 在接上批准通道之后会先挂起等 permission.respond，这条测试
    // 就再也不会以 NOT_IMPLEMENTED 结束，而是卡在没人响应的 promise 上。
    // 参数必须合法（notification_send 在 TASK-024 有了绑定器，空参数会先撞
    // INVALID_ARGUMENT），才能走到执行体看到「没有接线通知端口」。
    const allowAll: ToolRetriever = {
      listVisible: () => [],
      authorize: () => ({
        allowed: true,
        capability: { name: 'notification_send', kind: 'READ', description: 'test' }
      })
    }
    const permissive = createExecutor(readOnlyScope('task-1'), UI_ORIGIN, allowAll)
    const out = await permissive(params('notification_send', { reminderId: 'r-1' }))
    expect(out['code']).toBe(ERROR_CODE.NOT_IMPLEMENTED)
  })
})

describe('executor：WRITE 能力经批准后执行（TASK-020 接线）', () => {
  // readOnlyScope 不放 WRITE，这里自定义一个只含两个目标能力的 scope。
  const writeScope: TaskScope = {
    taskId: 'task-1',
    capabilities: ['filesystem_create_dir', 'filesystem_move']
  }
  // 自动批准的 gate：request 直接 approved，verify 直接 ok。
  // 真实批准流程在 execution-policy.test.ts / permission-broker.test.ts。
  const approveGate: PermissionGate = {
    request: async () => ({ approved: true }),
    verify: async () => ({ ok: true })
  }

  function writeRun(): (params: HostExecuteToolParams) => Promise<Record<string, unknown>> {
    return createExecutor(writeScope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: approveGate
    })
  }

  async function isDir(p: string): Promise<boolean> {
    try {
      return (await stat(p)).isDirectory()
    } catch {
      return false
    }
  }

  async function exists(p: string): Promise<boolean> {
    try {
      await stat(p)
      return true
    } catch {
      return false
    }
  }

  it('create_dir：批准后走执行体，path 是 bound.paths 的 realpath（正斜杠）', async () => {
    const reading = toPosix(join(dir, 'Reading'))
    const out = await writeRun()(params('filesystem_create_dir', { path: join(dir, 'Reading') }))

    // 未实现占位返回 CREATE_DIR_FAILED；填完 createDir 后应为 ok:true created:true。
    // path 必须是 realpath 后的正斜杠形式，证明接线传的是 bound.paths 而非原始 arguments。
    expect(out['ok']).toBe(true)
    expect(out['path']).toBe(reading)
    expect(out['created']).toBe(true)
    expect(await isDir(reading)).toBe(true)
  })

  it('move：批准后走执行体，source/target 是 bound.paths 的 realpath', async () => {
    const source = join(dir, 'report.pdf')
    await writeFile(source, 'X')
    await mkdir(join(dir, 'Reading'))
    const target = join(dir, 'Reading', 'report.pdf')

    const out = await writeRun()(params('filesystem_move', { source, target }))
    expect(out['ok']).toBe(true)
    expect(out['source']).toBe(toPosix(source))
    expect(out['target']).toBe(toPosix(target))
    // 真的搬走了：source 不在，target 在。
    expect(await exists(source)).toBe(false)
    expect(await exists(target)).toBe(true)
  })

  it('Deny：gate 拒绝时执行体不跑，目录不建（Phase2 Exit: Deny 后不变化）', async () => {
    const denyGate: PermissionGate = {
      request: async () => ({
        approved: false,
        code: ERROR_CODE.PERMISSION_DENIED,
        reason: '用户拒绝'
      }),
      verify: async () => ({ ok: true })
    }
    const denyRun = createExecutor(writeScope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: denyGate
    })
    const reading = join(dir, 'Reading')
    const out = await denyRun(params('filesystem_create_dir', { path: reading }))

    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.PERMISSION_DENIED)
    // 这条现在就该绿：拒绝发生在执行体之前，与 createDir 是否实现无关。
    expect(await isDir(reading)).toBe(false)
  })
})

describe('executor：notification_send（TASK-024 接线）', () => {
  const T0 = '2026-09-15T09:00:00.000Z'
  /** 注入给 wiring 的「现在」。fireReminder 的到点判定、stamp 全用它。 */
  const NOW = '2026-09-15T20:00:00.500Z'
  /** 已到点的 remindAt（早于 NOW）。 */
  const DUE = '2026-09-15T20:00:00.000Z'
  /** 还没到点的 remindAt（晚于 NOW）。 */
  const FUTURE = '2026-09-15T21:00:00.000Z'

  let db: SqliteDatabase
  let reminders: SqliteReminderRepository
  let events: SqliteEventRepository
  let sentRequests: NotificationRequest[]
  let portCalls: number
  let portOutcome: NotificationOutcome

  const fakePort: NotificationPort = {
    send: async (req) => {
      portCalls += 1
      sentRequests.push(req)
      return portOutcome
    }
  }
  const approveGate: PermissionGate = {
    request: async () => ({ approved: true }),
    verify: async () => ({ ok: true })
  }
  const notifyScope: TaskScope = {
    taskId: 'task-1',
    capabilities: ['scheduler_create', 'notification_send']
  }

  beforeEach(() => {
    db = openProductState(MEMORY_DB)
    migrate(db)
    const tasks = new SqliteTaskRepository(db)
    tasks.insert({
      id: 'task-1',
      goal: '目标 task-1',
      status: 'running',
      createdAt: T0,
      updatedAt: T0
    })
    tasks.insert({
      id: 'task-2',
      goal: '目标 task-2',
      status: 'running',
      createdAt: T0,
      updatedAt: T0
    })
    reminders = new SqliteReminderRepository(db)
    events = new SqliteEventRepository(db)
    sentRequests = []
    portCalls = 0
    portOutcome = { ok: true }
  })

  afterEach(() => {
    db.close()
  })

  function makeRun(
    overrides: Partial<ExecutorSchedulerWiring> = {}
  ): (params: HostExecuteToolParams) => Promise<Record<string, unknown>> {
    return createExecutor(
      notifyScope,
      UI_ORIGIN,
      new RuleBasedToolRetriever(),
      { gate: approveGate },
      undefined,
      { db, reminders, events, notifications: fakePort, now: () => NOW, ...overrides }
    )
  }

  function seedReminder(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
    const record: ReminderRecord = {
      id: 'r-1',
      taskId: 'task-1',
      toolCallId: 'tc-1',
      remindAt: DUE,
      message: '该阅读 report-2026.pdf 的摘要了',
      idempotencyKey: 'scheduler_create:hash-r1',
      status: 'scheduled',
      createdAt: T0,
      updatedAt: T0,
      firedAt: null,
      failureReason: null,
      ...overrides
    }
    reminders.insert(record)
    return record
  }

  it('没有接线通知端口时回 NOT_IMPLEMENTED', async () => {
    // 两种没接线：整个 scheduler wiring 缺席 vs 有仓储但没 notifications。
    // 都要「明说没接线」，不能半执行。
    const noScheduler = createExecutor(notifyScope, UI_ORIGIN, new RuleBasedToolRetriever(), {
      gate: approveGate
    })
    const out1 = await noScheduler(params('notification_send', { reminderId: 'r-1' }))
    expect(out1['code']).toBe(ERROR_CODE.NOT_IMPLEMENTED)

    const noPort = makeRun({ notifications: undefined })
    const out2 = await noPort(params('notification_send', { reminderId: 'r-1' }))
    expect(out2['code']).toBe(ERROR_CODE.NOT_IMPLEMENTED)
    expect(portCalls).toBe(0)
  })

  it('查无 Reminder 回 REMINDER_NOT_FOUND', async () => {
    const out = await makeRun()(params('notification_send', { reminderId: 'ghost' }))
    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.REMINDER_NOT_FOUND)
    expect(portCalls).toBe(0)
  })

  it('跨任务的 Reminder 装作不存在，不泄露存在性', async () => {
    // task-1 的调用引用 task-2 的 Reminder：必须按 REMINDER_NOT_FOUND 拒绝。
    // 实现落地前此用例红（占位实现回 NOT_IMPLEMENTED）。
    seedReminder({ id: 'r-2', taskId: 'task-2' })
    const out = await makeRun()(params('notification_send', { reminderId: 'r-2' }))
    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.REMINDER_NOT_FOUND)
    expect(portCalls).toBe(0)
  })

  it('到点 → 发送一次并记录结果：fired + firedAt + notification_sent 事件', async () => {
    // TASK-024 验收本体（executor 入口）；实现落地前红。
    seedReminder()
    const out = await makeRun()(params('notification_send', { reminderId: 'r-1' }))

    // wire 形状与 NotificationSendResult 逐字段一致
    expect(() => NotificationSendResult.parse(out)).not.toThrow()
    expect(out['ok']).toBe(true)
    expect(out['status']).toBe('fired')
    expect(out['sent']).toBe(true)
    expect(out['sentAt']).toBe(NOW)

    // 端口收到的是落库的 message 与常量标题，恰好一次
    expect(portCalls).toBe(1)
    expect(sentRequests[0]).toEqual({
      title: NOTIFICATION_TITLE,
      body: '该阅读 report-2026.pdf 的摘要了'
    })

    // 落库：fired + firedAt
    const row = reminders.findById('r-1')
    expect(row?.status).toBe('fired')
    expect(row?.firedAt).toBe(NOW)

    // 事件：notification_sent 落了，没有失败事件
    const types = events.listByTask('task-1').map((e) => e.type)
    expect(types).toContain(NOTIFICATION_SENT_EVENT)
    expect(types).not.toContain(NOTIFICATION_FAILED_EVENT)
  })

  it('已 fired 的重复触发 → 幂等返回 sent:false，绝不重发', async () => {
    // 「同一 Reminder 最多通知一次」：fired 是终态，重复调用不算失败，
    // 但端口一次都不能再碰。
    seedReminder({ status: 'fired', firedAt: DUE })
    const out = await makeRun()(params('notification_send', { reminderId: 'r-1' }))
    expect(out['ok']).toBe(true)
    expect(out['sent']).toBe(false)
    expect(out['sentAt']).toBe(DUE)
    expect(portCalls).toBe(0)
  })

  it('未到点 → REMINDER_NOT_DUE，不碰通知端口', async () => {
    // 到点发送是 timer 的职责；提前调用必须拿稳定错误码而不是静默发送。
    seedReminder({ remindAt: FUTURE })
    const out = await makeRun()(params('notification_send', { reminderId: 'r-1' }))
    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.REMINDER_NOT_DUE)
    expect(portCalls).toBe(0)
    expect(reminders.findById('r-1')?.status).toBe('scheduled')
  })

  it('发送失败 → NOTIFICATION_SEND_FAILED，落 failed + failure_reason，不伪造成功', async () => {
    portOutcome = { ok: false, reason: 'Windows 通知通道不可用' }
    seedReminder()
    const out = await makeRun()(params('notification_send', { reminderId: 'r-1' }))
    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.NOTIFICATION_SEND_FAILED)
    expect(String(out['reason'])).toContain('Windows 通知通道不可用')

    const row = reminders.findById('r-1')
    expect(row?.status).toBe('failed')
    expect(row?.failureReason).toContain('Windows 通知通道不可用')

    const types = events.listByTask('task-1').map((e) => e.type)
    expect(types).toContain(NOTIFICATION_FAILED_EVENT)
    expect(types).not.toContain(NOTIFICATION_SENT_EVENT)
  })
})

describe('scheduler_create → timer → 到时发送一次（TASK-024 验收链路）', () => {
  // 真 fireReminder + 真 ReminderTimerService + 假通知端口 + 注入时钟。
  // 这组在 fireReminder / schedule 落地前红——它就是验收
  // 「到时发送一次并记录结果」的端到端表达。
  const T0 = '2026-09-15T09:00:00.000Z'

  interface FakeTimerEntry {
    id: number
    fn: () => void
    dueAt: number
  }

  let db: SqliteDatabase
  let reminders: SqliteReminderRepository
  let events: SqliteEventRepository
  let timerService: ReminderTimerService
  let run2: (params: HostExecuteToolParams) => Promise<Record<string, unknown>>
  let sentBodies: string[]
  let clockMs: number
  let fakeTimers: FakeTimerEntry[]
  let nextTimerId: number

  const fakePort: NotificationPort = {
    send: async (req) => {
      sentBodies.push(req.body)
      return { ok: true }
    }
  }
  const approveGate: PermissionGate = {
    request: async () => ({ approved: true }),
    verify: async () => ({ ok: true })
  }

  const setTimer = (fn: () => void, ms: number): TimerHandle => {
    const entry: FakeTimerEntry = { id: nextTimerId++, fn, dueAt: clockMs + ms }
    fakeTimers.push(entry)
    return entry.id as unknown as TimerHandle
  }
  const clearTimer = (handle: TimerHandle): void => {
    const id = handle as unknown as number
    fakeTimers = fakeTimers.filter((t) => t.id !== id)
  }
  /** 把时钟拨到 target，途中到点的 timer 按顺序逐个触发（支持分段重挂链）。 */
  function advanceTo(target: number): void {
    for (;;) {
      const due = fakeTimers.filter((t) => t.dueAt <= target).sort((a, b) => a.dueAt - b.dueAt)[0]
      if (due === undefined) break
      clockMs = due.dueAt
      fakeTimers = fakeTimers.filter((t) => t.id !== due.id)
      due.fn()
    }
    clockMs = target
  }
  /** 让 onDue 里的 void fire(...).then 链跑完（真 setTimeout 0 即可，
   *  注入的假时钟只影响 ReminderTimerService 自己）。 */
  async function flushAsync(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  beforeEach(() => {
    clockMs = Date.now()
    fakeTimers = []
    nextTimerId = 1
    sentBodies = []
    db = openProductState(MEMORY_DB)
    migrate(db)
    new SqliteTaskRepository(db).insert({
      id: 'task-1',
      goal: '目标 task-1',
      status: 'running',
      createdAt: T0,
      updatedAt: T0
    })
    reminders = new SqliteReminderRepository(db)
    events = new SqliteEventRepository(db)
    const stamp = (): string => new Date(clockMs).toISOString()
    timerService = new ReminderTimerService({
      fire: (reminder) =>
        fireReminder(reminder, { db, reminders, events, notifications: fakePort, now: stamp }),
      now: () => clockMs,
      setTimer,
      clearTimer
    })
    run2 = createExecutor(
      { taskId: 'task-1', capabilities: ['scheduler_create', 'notification_send'] },
      UI_ORIGIN,
      new RuleBasedToolRetriever(),
      { gate: approveGate },
      undefined,
      {
        db,
        reminders,
        events,
        notifications: fakePort,
        now: stamp,
        armTimer: (r) => timerService.arm(r)
      }
    )
  })

  afterEach(() => {
    timerService.dispose()
    db.close()
  })

  it('创建即挂表；到点发送一次并落库；再拨时钟不重发', async () => {
    const start = clockMs
    // binder 用真实 Date.now() 拒过去时刻：remindAt 取「注入时钟 + 60s」，
    // 注入时钟起点就是真实 now，所以 binder 也能过。
    const remindAt = new Date(start + 60_000).toISOString()
    const created = await run2(
      params('scheduler_create', { remindAt, message: '该阅读 report-2026.pdf 的摘要了' })
    )
    expect(created['ok']).toBe(true)
    expect(created['created']).toBe(true)
    const reminderId = String(created['reminderId'])
    // armTimer 钩子：落库提交成功后表就挂上了
    expect(timerService.isArmed(reminderId)).toBe(true)

    // 差 1ms 不到点：什么都不发生
    advanceTo(start + 59_999)
    await flushAsync()
    expect(sentBodies).toHaveLength(0)
    expect(reminders.findById(reminderId)?.status).toBe('scheduled')

    // 到点：恰好发送一次，结果落库
    advanceTo(start + 60_000)
    await vi.waitFor(() => expect(sentBodies).toHaveLength(1))
    expect(sentBodies[0]).toBe('该阅读 report-2026.pdf 的摘要了')
    const row = reminders.findById(reminderId)
    expect(row?.status).toBe('fired')
    expect(row?.firedAt).toBe(remindAt)
    const types = events.listByTask('task-1').map((e) => e.type)
    expect(types).toContain(REMINDER_CREATED_EVENT)
    expect(types).toContain(NOTIFICATION_SENT_EVENT)

    // 再拨一小时：终态就是终态，不重发（「发送一次」）
    advanceTo(start + 3_600_000)
    await flushAsync()
    expect(sentBodies).toHaveLength(1)
  })

  it('到点发送失败 → failed + notification_failed，表不重挂', async () => {
    // 失败路径的链路表达：US-06「通知失败时记录失败事件，不伪造成功」。
    const failingPort: NotificationPort = {
      send: async () => ({ ok: false, reason: '通道忙' })
    }
    const stamp = (): string => new Date(clockMs).toISOString()
    const failingService = new ReminderTimerService({
      fire: (reminder) =>
        fireReminder(reminder, {
          db,
          reminders,
          events,
          notifications: failingPort,
          now: stamp
        }),
      now: () => clockMs,
      setTimer,
      clearTimer
    })
    reminders.insert({
      id: 'r-fail',
      taskId: 'task-1',
      toolCallId: 'tc-fail',
      remindAt: new Date(clockMs + 1_000).toISOString(),
      message: '会失败的通知',
      idempotencyKey: 'scheduler_create:hash-fail',
      status: 'scheduled',
      createdAt: T0,
      updatedAt: T0,
      firedAt: null,
      failureReason: null
    })
    failingService.arm(reminders.findById('r-fail')!)

    advanceTo(clockMs + 1_000)
    await vi.waitFor(() => expect(reminders.findById('r-fail')?.status).toBe('failed'))
    const row = reminders.findById('r-fail')
    expect(row?.failureReason).toContain('通道忙')
    const types = events.listByTask('task-1').map((e) => e.type)
    expect(types).toContain(NOTIFICATION_FAILED_EVENT)
    expect(types).not.toContain(NOTIFICATION_SENT_EVENT)
    // failed 只允许显式重试：timer 不自动重挂
    expect(failingService.isArmed('r-fail')).toBe(false)
    failingService.dispose()
  })
})

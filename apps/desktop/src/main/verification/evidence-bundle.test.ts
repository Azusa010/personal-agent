/**
 * 取证（TASK-026）：把「这个任务到底交付了什么」从真库、真实文件系统
 * 与真实 PDF 里查出来。
 *
 * 真内存库（better-sqlite3 :memory: + 全量 migration）+ 假端口：
 * 库查询走真 SQL，**PDF 与文件系统是替身**——断言的是「取证把哪条事实
 * 认成了什么」，不是 pdfjs 或 Windows 文件系统的行为（那两样由 e2e 覆盖）。
 *
 * 这份文件是「验证与质量」的练习场（AGENTS.md §6）：场景与 seed 由 AI 给，
 * 覆盖陪练函数（collectToolResults / lastExtractedPath / currentPathOf /
 * finalPathOf / collectMoveEvidence / collectPdfPages）的用例里
 * **`expect(...)` 由你写**，末尾的「期望」就是取证必须满足的规格。
 * 保留给 AI 的断言：库内记录的映射（我写的搬运）、只按 taskId 取数、
 * eventSequenceRange 与 pageReferences 这两个直接可算的派生字段。
 *
 * 陪练点对应关系（TODO 在 evidence-bundle.ts 里）：
 *   - 选中的 PDF / 跟随移动 / 最终路径 → 思维与算法
 *   - 探测失败与缺口收场 → 边界与异常
 *   - 事件 payload 的配对与畸形载荷 → 思维与算法 + 边界与异常
 */
import { afterEach, describe, expect, it } from 'vitest'

import type { ExecutionEventRecord, PlanStep } from '../../shared/domain'
import type { SummaryFact } from '../../shared/ipc-contract'
import {
  MEMORY_DB,
  migrate,
  openProductState,
  type SqliteDatabase
} from '../product-state/database'
import { SqliteEventRepository } from '../product-state/event-repository'
import { SqlitePermissionRepository } from '../product-state/permission-repository'
import { SqlitePlanRepository } from '../product-state/plan-repository'
import { SqliteReminderRepository } from '../product-state/reminder-repository'
import { SqliteTaskRepository } from '../product-state/task-repository'
import { SqliteToolExecutionRepository } from '../product-state/tool-execution-repository'
import {
  collectEvidence,
  collectToolResults,
  completedReply,
  currentPathOf,
  finalPathOf,
  lastExtractedPath,
  type CollectedEvidence,
  type EvidenceDeps,
  type PageNumbersRead,
  type VerificationPorts
} from './evidence-bundle'

const AT = '2026-09-15T09:00:00.000Z'
const TASK_ID = 't-1'
const OTHER_TASK_ID = 't-2'
const GOAL = '整理 Downloads 里的 PDF'
const PDF = 'D:/downloads/report.pdf'
const READING = 'D:/downloads/Reading/report.pdf'

const FACTS: SummaryFact[] = [{ text: '第一页与第三页讲了同一件事', pageRefs: [3, 1, 3] }]

const PLAN: PlanStep[] = [
  { description: '列出 Downloads 下的 PDF', capability: 'filesystem.list' },
  { description: '提取目标 PDF 的每页文本', capability: 'document.extract_pdf' },
  { description: '把选中的 PDF 移到 Reading', capability: 'filesystem.move' },
  { description: '创建阅读提醒', capability: 'scheduler.create' }
]

let db: SqliteDatabase | null = null

afterEach(() => {
  db?.close()
  db = null
})

/** 假端口：PDF 与文件系统的「事实」由测试直接给定，读过的路径留痕供断言。 */
class FakeWorld implements VerificationPorts {
  readonly resolveMap = new Map<string, string | null>()
  readonly pages = new Map<string, number[]>()
  readonly existing = new Set<string>()
  readonly refused = new Set<string>()
  readonly reads: string[] = []
  readonly seeks: string[] = []
  resolveThrows = false

  async resolvePath(rawPath: string): Promise<string | null> {
    if (this.resolveThrows) throw new Error('授权根不可用')
    return this.resolveMap.has(rawPath) ? (this.resolveMap.get(rawPath) ?? null) : rawPath
  }

  async readPageNumbers(absPath: string): Promise<PageNumbersRead> {
    this.reads.push(absPath)
    const pageNumbers = this.pages.get(absPath)
    return pageNumbers === undefined
      ? { ok: false, reason: 'PDF_CORRUPT: PDF 结构损坏' }
      : { ok: true, pageNumbers }
  }

  async pathExists(absPath: string): Promise<boolean> {
    this.seeks.push(absPath)
    if (this.refused.has(absPath)) throw new Error('EPERM: 权限不足')
    return this.existing.has(absPath)
  }
}

function openHarness(world: FakeWorld = new FakeWorld()): EvidenceDeps {
  const store = openProductState(MEMORY_DB)
  db = store
  migrate(store)
  // 端口挂在 FakeWorld 实例上（类方法不在自有属性里，展开会丢），
  // 所以就地把它补成 EvidenceDeps：调用方手里的 world 引用依然能查 reads / seeks。
  return Object.assign(world, {
    tasks: new SqliteTaskRepository(store),
    plans: new SqlitePlanRepository(store),
    events: new SqliteEventRepository(store),
    permissions: new SqlitePermissionRepository(store),
    executions: new SqliteToolExecutionRepository(store),
    reminders: new SqliteReminderRepository(store)
  })
}

function seedTask(deps: EvidenceDeps, id: string = TASK_ID, goal: string = GOAL): void {
  deps.tasks.insert({ id, goal, status: 'running', createdAt: AT, updatedAt: AT })
}

function seedPlan(deps: EvidenceDeps, steps: PlanStep[] = PLAN, taskId = TASK_ID): void {
  deps.plans.append({ id: `p-${taskId}`, taskId, steps, createdAt: AT })
}

function seedEvent(deps: EvidenceDeps, type: string, payload: unknown, taskId = TASK_ID): number {
  return deps.events.append({ taskId, type, payload, occurredAt: AT })
}

function seedPermission(
  deps: EvidenceDeps,
  over: Partial<Parameters<EvidenceDeps['permissions']['insert']>[0]> = {}
): void {
  deps.permissions.insert({
    id: 'perm-1',
    taskId: TASK_ID,
    toolCallId: 'c-move',
    capability: 'filesystem.move',
    argsCanonical:
      '{"source":"D:/downloads/report.pdf","target":"D:/downloads/Reading/report.pdf"}',
    argsHash: 'h-move',
    status: 'approved',
    requestedAt: AT,
    expiresAt: AT,
    decidedAt: AT,
    sourcePaths: [PDF],
    targetPath: READING,
    ...over
  })
}

function seedExecution(
  deps: EvidenceDeps,
  over: Partial<Parameters<EvidenceDeps['executions']['insert']>[0]> = {}
): void {
  deps.executions.insert({
    idempotencyKey: 'filesystem.move:h-move',
    taskId: TASK_ID,
    toolCallId: 'c-move',
    capability: 'filesystem.move',
    argsHash: 'h-move',
    sourcePaths: [PDF],
    targetPath: READING,
    status: 'succeeded',
    attemptedAt: AT,
    finishedAt: AT,
    resultPayload: { ok: true },
    ...over
  })
}

function seedReminder(
  deps: EvidenceDeps,
  over: Partial<Parameters<EvidenceDeps['reminders']['insert']>[0]> = {}
): void {
  deps.reminders.insert({
    id: 'r-1',
    taskId: TASK_ID,
    toolCallId: 'c-remind',
    remindAt: '2026-09-15T20:00:00.000Z',
    message: '今晚读那份 PDF',
    idempotencyKey: 'scheduler.create:h-remind',
    status: 'scheduled',
    createdAt: AT,
    updatedAt: AT,
    firedAt: null,
    failureReason: null,
    ...over
  })
}

/** Golden Path 的事件流：list → extract → move → scheduler.create → summary。 */
function seedGoldenEvents(deps: EvidenceDeps, taskId = TASK_ID): void {
  seedEvent(deps, 'task_started', { goal: GOAL }, taskId)
  seedEvent(
    deps,
    'tool_called',
    { callId: 'c-list', capability: 'filesystem.list', arguments: { rootId: 'downloads' } },
    taskId
  )
  seedEvent(
    deps,
    'tool_result',
    { callId: 'c-list', capability: 'filesystem.list', ok: true },
    taskId
  )
  seedEvent(
    deps,
    'tool_called',
    { callId: 'c-extract', capability: 'document.extract_pdf', arguments: { path: PDF } },
    taskId
  )
  seedEvent(
    deps,
    'tool_result',
    { callId: 'c-extract', capability: 'document.extract_pdf', ok: true },
    taskId
  )
  seedEvent(deps, 'task_completed', { factCount: FACTS.length }, taskId)
}

/** 契约底线（AI 保留）：取证没抛错、证据包认的是这个任务。留着它也让你不必重复接一次调用。 */
function expectBundleForTask(evidence: CollectedEvidence): void {
  expect(evidence.taskId).toBe(TASK_ID)
}

/** 纯函数检查点用的事件：不碰库，直接造。 */
function event(seq: number, type: string, payload: unknown): ExecutionEventRecord {
  return { seq, taskId: TASK_ID, type, payload, occurredAt: AT }
}

// ---------------------------------------------------------------------------
// 纯函数检查点：这四个函数不吃库、不吃端口，喂事件数组就能验
// ---------------------------------------------------------------------------

describe('collectToolResults：调用与结果的配对', () => {
  it('三种情况分清：成功、失败、没有结果', () => {
    const events = [
      event(1, 'tool_called', { callId: 'c-1', capability: 'filesystem.list' }),
      event(2, 'tool_result', { callId: 'c-1', capability: 'filesystem.list', ok: true }),
      event(3, 'tool_called', { callId: 'c-2', capability: 'document.extract_pdf' }),
      event(4, 'tool_result', { callId: 'c-2', capability: 'document.extract_pdf', ok: false }),
      event(5, 'tool_called', { callId: 'c-3', capability: 'filesystem.move' })
    ]

    expect(collectToolResults(events)).toEqual([
      { callId: 'c-1', capability: 'filesystem.list', ok: true, hasResult: true },
      { callId: 'c-2', capability: 'document.extract_pdf', ok: false, hasResult: true },
      { callId: 'c-3', capability: 'filesystem.move', ok: false, hasResult: false }
    ])
  })

  it('畸形载荷跳过，不抛错', () => {
    const events = [
      event(1, 'tool_called', '这不是一个对象'),
      event(2, 'tool_called', { capability: 'filesystem.list' }),
      event(3, 'tool_called', { callId: '', capability: 'filesystem.list' }),
      event(4, 'tool_result', null),
      event(5, 'task_started', { goal: GOAL })
    ]

    expect(collectToolResults(events)).toEqual([])
  })
})

describe('lastExtractedPath：摘要依据的是哪份 PDF', () => {
  it('取最后一次成功的提取；失败的那次不算数', () => {
    const events = [
      event(1, 'tool_called', {
        callId: 'c-1',
        capability: 'document.extract_pdf',
        arguments: { path: 'D:/downloads/a.pdf' }
      }),
      event(2, 'tool_result', { callId: 'c-1', capability: 'document.extract_pdf', ok: false }),
      event(3, 'tool_called', {
        callId: 'c-2',
        capability: 'document.extract_pdf',
        arguments: { path: 'D:/downloads/b.pdf' }
      }),
      event(4, 'tool_result', { callId: 'c-2', capability: 'document.extract_pdf', ok: true }),
      event(5, 'tool_called', {
        callId: 'c-3',
        capability: 'document.extract_pdf',
        arguments: { path: 'D:/downloads/c.pdf' }
      }),
      event(6, 'tool_result', { callId: 'c-3', capability: 'document.extract_pdf', ok: true })
    ]

    expect(lastExtractedPath(events)).toBe('D:/downloads/c.pdf')
  })

  it('没有成功的提取 → null；缺 arguments.path → 定不出来', () => {
    const failed = [
      event(1, 'tool_called', {
        callId: 'c-1',
        capability: 'document.extract_pdf',
        arguments: { path: PDF }
      }),
      event(2, 'tool_result', { callId: 'c-1', capability: 'document.extract_pdf', ok: false })
    ]
    const noPath = [
      event(1, 'tool_called', { callId: 'c-2', capability: 'document.extract_pdf' }),
      event(2, 'tool_result', { callId: 'c-2', capability: 'document.extract_pdf', ok: true })
    ]

    expect(lastExtractedPath(failed)).toBeNull()
    expect(lastExtractedPath(noPath)).toBeNull()
    // 路径为空串同样不算数
    expect(
      lastExtractedPath([
        event(1, 'tool_called', {
          callId: 'c-3',
          capability: 'document.extract_pdf',
          arguments: { path: '' }
        }),
        event(2, 'tool_result', { callId: 'c-3', capability: 'document.extract_pdf', ok: true })
      ])
    ).toBeNull()
  })
})

describe('currentPathOf / finalPathOf：文件现在在哪、哪条算交付', () => {
  it('搬走了就读新位置，没搬就读原位置', () => {
    const moved = [{ sourcePath: PDF, targetPath: READING, sourceGone: true, targetPresent: true }]
    const notMoved = [
      { sourcePath: PDF, targetPath: READING, sourceGone: false, targetPresent: false }
    ]

    expect(currentPathOf(PDF, moved)).toBe(READING)
    // 目标没落地就不跟：文件此刻还在源路径
    expect(currentPathOf(PDF, notMoved)).toBe(PDF)

    // 链条（A→B→C）：搬过两次就跟到底
    const chained = [
      {
        sourcePath: PDF,
        targetPath: 'D:/downloads/mid.pdf',
        sourceGone: true,
        targetPresent: true
      },
      {
        sourcePath: 'D:/downloads/mid.pdf',
        targetPath: READING,
        sourceGone: true,
        targetPresent: true
      }
    ]
    expect(currentPathOf(PDF, chained)).toBe(READING)
  })

  it('最终路径只认搬成功的那条', () => {
    const moves = [
      {
        sourcePath: 'D:/downloads/a.pdf',
        targetPath: 'D:/downloads/Reading/a.pdf',
        sourceGone: false,
        targetPresent: false
      },
      { sourcePath: PDF, targetPath: READING, sourceGone: true, targetPresent: true }
    ]

    // 第一条没搬成，不算交付
    expect(finalPathOf(moves)).toBe(READING)
    expect(finalPathOf([])).toBeNull()
  })
})

describe('collectEvidence：库内记录的搬运与派生字段', () => {
  it('goal / 计划 / 摘要 / 权限 / 执行 / 提醒原样映射进证据包', async () => {
    const world = new FakeWorld()
    world.existing.add(READING)
    world.pages.set(READING, [1, 2, 3])

    const deps = openHarness(world)
    seedTask(deps)
    seedPlan(deps)
    seedGoldenEvents(deps)
    seedPermission(deps)
    seedExecution(deps)
    seedReminder(deps)

    const evidence = await collectEvidence(deps, { taskId: TASK_ID, facts: FACTS })

    expect(evidence.goal).toBe(GOAL)
    expect(evidence.planVersion).toBe(1)
    expect(evidence.planSteps).toEqual(PLAN)
    expect(evidence.summary).toEqual(FACTS)
    // pageRefs 里的 3、1、3 → 去重升序
    expect(evidence.pageReferences).toEqual([1, 3])
    expect(evidence.permissions).toEqual([
      {
        toolCallId: 'c-move',
        capability: 'filesystem.move',
        status: 'approved',
        argsHash: 'h-move'
      }
    ])
    expect(evidence.executions).toHaveLength(1)
    expect(evidence.reminder).toEqual({
      id: 'r-1',
      remindAt: '2026-09-15T20:00:00.000Z',
      status: 'scheduled',
      idempotencyKey: 'scheduler.create:h-remind'
    })
    expect(evidence.eventSequenceRange).toEqual({ from: 1, to: 6 })
    expect(evidence.gaps).toEqual([])
  })

  it('选中的 PDF：重读的是它移动后的位置，文件位置来自真实存在性检查', async () => {
    const world = new FakeWorld()
    // 移动成功：源已消失、目标在
    world.existing.add(READING)
    world.pages.set(READING, [1, 2, 3])

    const deps = openHarness(world)
    seedTask(deps)
    seedPlan(deps)
    seedGoldenEvents(deps)
    seedPermission(deps)
    seedExecution(deps)
    seedReminder(deps)

    const evidence = await collectEvidence(deps, { taskId: TASK_ID, facts: FACTS })
    expectBundleForTask(evidence)

    expect(evidence.selectedPdf).toBe(PDF)
    // 文件被搬走了，重读从它此刻的位置读——读源路径会得到「文件不存在」
    expect(evidence.resolvedPdfPath).toBe(READING)
    expect(world.reads).toEqual([READING])
    expect(evidence.parsedPageNumbers).toEqual([1, 2, 3])
    expect(evidence.parsedPageCount).toBe(3)
    expect(evidence.moves).toEqual([
      { sourcePath: PDF, targetPath: READING, sourceGone: true, targetPresent: true }
    ])
    expect(evidence.finalFilePath).toBe(READING)
    // 源与目标各查一次，顺序固定
    expect(world.seeks).toEqual([PDF, READING])
  })

  it('工具调用与结果按 callId 配对；失败调用与缺结果的调用如实记录', async () => {
    const deps = openHarness()
    seedTask(deps)
    seedEvent(deps, 'tool_called', { callId: 'c-1', capability: 'filesystem.list' })
    seedEvent(deps, 'tool_result', { callId: 'c-1', capability: 'filesystem.list', ok: true })
    seedEvent(deps, 'tool_called', { callId: 'c-2', capability: 'document.extract_pdf' })
    seedEvent(deps, 'tool_result', { callId: 'c-2', capability: 'document.extract_pdf', ok: false })
    seedEvent(deps, 'tool_called', { callId: 'c-3', capability: 'filesystem.move' })

    const evidence = await collectEvidence(deps, { taskId: TASK_ID, facts: FACTS })
    expectBundleForTask(evidence)

    expect(evidence.toolResults).toEqual([
      { callId: 'c-1', capability: 'filesystem.list', ok: true, hasResult: true },
      { callId: 'c-2', capability: 'document.extract_pdf', ok: false, hasResult: true },
      { callId: 'c-3', capability: 'filesystem.move', ok: false, hasResult: false }
    ])
  })
})

describe('collectEvidence：证据缺口如实记录（不抛错、不编造）', () => {
  it('时间线里没有成功的 extract_pdf → gap，页号为空，端口一次没碰', async () => {
    const world = new FakeWorld()
    const deps = openHarness(world)
    seedTask(deps)
    seedEvent(deps, 'tool_called', {
      callId: 'c-extract',
      capability: 'document.extract_pdf',
      arguments: { path: PDF }
    })
    seedEvent(deps, 'tool_result', {
      callId: 'c-extract',
      capability: 'document.extract_pdf',
      ok: false
    })

    const evidence = await collectEvidence(deps, { taskId: TASK_ID, facts: FACTS })
    expectBundleForTask(evidence)

    expect(evidence.selectedPdf).toBeNull()
    expect(evidence.resolvedPdfPath).toBeNull()
    expect(evidence.parsedPageNumbers).toBeNull()
    expect(evidence.parsedPageCount).toBeNull()
    expect(evidence.gaps.join()).toContain('没有成功的 document.extract_pdf')
    // 连不上路径就不该去碰文件系统
    expect(world.reads).toEqual([])
    expect(world.seeks).toEqual([])
  })

  it('摘要依据的 PDF 不在授权根内 → gap，不读文件', async () => {
    const world = new FakeWorld()
    world.resolveMap.set(PDF, null)
    const deps = openHarness(world)
    seedTask(deps)
    seedGoldenEvents(deps)

    const evidence = await collectEvidence(deps, { taskId: TASK_ID, facts: FACTS })
    expectBundleForTask(evidence)

    // selectedPdf 是「从事件里选出来的那条」，即使它解析不到根内也照实记录
    expect(evidence.selectedPdf).toBe(PDF)
    expect(evidence.resolvedPdfPath).toBeNull()
    expect(evidence.parsedPageNumbers).toBeNull()
    expect(evidence.gaps.join()).toContain('不在授权根内')
    expect(world.reads).toEqual([])
  })

  it('路径解析抛错（根不可用）→ gap 记下原因，不让整次取证炸掉', async () => {
    const world = new FakeWorld()
    world.resolveThrows = true
    const deps = openHarness(world)
    seedTask(deps)
    seedGoldenEvents(deps)

    const evidence = await collectEvidence(deps, { taskId: TASK_ID, facts: FACTS })
    expectBundleForTask(evidence)

    expect(evidence.parsedPageNumbers).toBeNull()
    expect(evidence.resolvedPdfPath).toBeNull()
    expect(evidence.gaps.join()).toContain('授权根不可用')
  })

  it('重读 PDF 失败 → gap 记下原因与路径，页号为空', async () => {
    const world = new FakeWorld()
    // pages 里没有这个路径 = 读不出来
    const deps = openHarness(world)
    seedTask(deps)
    seedGoldenEvents(deps)

    const evidence = await collectEvidence(deps, { taskId: TASK_ID, facts: FACTS })
    expectBundleForTask(evidence)

    // 页号拿不到，但「本来打算读哪个路径」要留下——排障时这条比错误码有用
    expect(evidence.resolvedPdfPath).toBe(PDF)
    expect(evidence.parsedPageNumbers).toBeNull()
    expect(evidence.parsedPageCount).toBeNull()
    expect(evidence.gaps.join()).toContain(PDF)
    expect(evidence.gaps.join()).toContain('PDF_CORRUPT')
  })

  it('源还在、目标不在（移动没发生）→ 如实记录，重读退回源路径', async () => {
    const world = new FakeWorld()
    world.existing.add(PDF)
    world.pages.set(PDF, [1, 2, 3])

    const deps = openHarness(world)
    seedTask(deps)
    seedGoldenEvents(deps)
    seedExecution(deps, { status: 'attempting', finishedAt: null })

    const evidence = await collectEvidence(deps, { taskId: TASK_ID, facts: FACTS })
    expectBundleForTask(evidence)

    // attempting 只是「打算移」，不进 moves；但它仍在 executions 里
    expect(evidence.moves).toEqual([])
    expect(evidence.executions).toHaveLength(1)
    expect(evidence.finalFilePath).toBeNull()
    expect(world.reads).toEqual([PDF])
  })

  it('移动记录在但目标不存在 → moves 记下真实状态，finalFilePath 仍为 null', async () => {
    const world = new FakeWorld()
    world.existing.add(PDF)
    world.pages.set(PDF, [1])

    const deps = openHarness(world)
    seedTask(deps)
    seedGoldenEvents(deps)
    seedExecution(deps)

    const evidence = await collectEvidence(deps, { taskId: TASK_ID, facts: FACTS })
    expectBundleForTask(evidence)

    expect(evidence.moves).toEqual([
      { sourcePath: PDF, targetPath: READING, sourceGone: false, targetPresent: false }
    ])
    // 目标都不存在，凭什么说这是交付
    expect(evidence.finalFilePath).toBeNull()
  })

  it('文件系统检查抛错（权限不足）→ gap，不把「查不出来」说成「文件不在」', async () => {
    const world = new FakeWorld()
    world.existing.add(READING)
    world.refused.add(READING)

    const deps = openHarness(world)
    seedTask(deps)
    seedGoldenEvents(deps)
    seedExecution(deps)

    const evidence = await collectEvidence(deps, { taskId: TASK_ID, facts: FACTS })
    expectBundleForTask(evidence)

    // 探测失败就不能断言文件位置：这条记录不进 moves，改记一条缺口
    expect(evidence.moves).toEqual([])
    expect(evidence.finalFilePath).toBeNull()
    expect(evidence.gaps.join()).toContain('文件系统检查失败')
    expect(evidence.gaps.join()).toContain('EPERM')
  })

  it('任务行缺失 → gap，不抛错', async () => {
    // 事件表对 tasks 有外键，造不出「有事件没任务」的库；这里验的是取证对
    // 「任务查不到」这一事实的反应：记 gap、其余字段退化成空，而不是崩掉。
    const deps = openHarness()

    const evidence = await collectEvidence(deps, { taskId: 't-missing', facts: FACTS })

    expect(evidence.goal).toBe('')
    expect(evidence.planVersion).toBeNull()
    expect(evidence.eventSequenceRange).toBeNull()
    expect(evidence.gaps.join()).toContain('任务不存在')
  })

  it('没有事件 → eventSequenceRange 为 null（工具结果与页号由上面各例覆盖）', async () => {
    const deps = openHarness()
    seedTask(deps)

    const evidence = await collectEvidence(deps, { taskId: TASK_ID, facts: FACTS })

    expect(evidence.eventSequenceRange).toBeNull()
  })

  it('事件载荷畸形（不是对象 / 缺 callId）→ 跳过该条，不崩', async () => {
    const deps = openHarness()
    seedTask(deps)
    seedEvent(deps, 'tool_called', '这不是一个对象')
    seedEvent(deps, 'tool_called', { capability: 'filesystem.list' })
    seedEvent(deps, 'tool_result', null)
    seedEvent(deps, 'task_started', { goal: GOAL })

    const evidence = await collectEvidence(deps, { taskId: TASK_ID, facts: FACTS })
    expectBundleForTask(evidence)

    expect(evidence.toolResults).toEqual([])
    expect(evidence.gaps.join()).toContain('没有成功的 document.extract_pdf')
    expect(evidence.eventSequenceRange).toEqual({ from: 1, to: 4 })
  })
})

describe('collectEvidence：只取本任务的事实', () => {
  it('别的任务的权限 / 执行 / 提醒不串进来', async () => {
    const deps = openHarness()
    seedTask(deps)
    seedTask(deps, OTHER_TASK_ID, '另一个目标')
    seedPlan(deps)
    seedGoldenEvents(deps)
    seedPermission(deps)
    seedExecution(deps)
    seedReminder(deps)

    // t-2 的同类记录：取证按 taskId 过滤，一条都不该混进 t-1 的证据包。
    seedPermission(deps, { id: 'perm-2', taskId: OTHER_TASK_ID, toolCallId: 'c-move-2' })
    seedExecution(deps, {
      idempotencyKey: 'filesystem.move:h-move-2',
      taskId: OTHER_TASK_ID,
      toolCallId: 'c-move-2',
      argsHash: 'h-move-2'
    })
    seedReminder(deps, { id: 'r-2', taskId: OTHER_TASK_ID })

    const evidence = await collectEvidence(deps, { taskId: TASK_ID, facts: FACTS })

    expect(evidence.permissions.map((p) => p.toolCallId)).toEqual(['c-move'])
    expect(evidence.executions.map((e) => e.idempotencyKey)).toEqual(['filesystem.move:h-move'])
    expect(evidence.reminder?.id).toBe('r-1')
  })
})

// ---------------------------------------------------------------------------
// completedReply 与零工具轮次的取证（TASK-031）
// ---------------------------------------------------------------------------

const CHAT_REPLY = '你好！我可以帮你整理 Downloads 里的 PDF。'
const CHAT_PLAN: PlanStep[] = [{ description: '直接回答用户' }]

describe('completedReply：从事件流里取给用户的回复', () => {
  it('task_completed 的 payload.reply 是非空字符串 → 原样返回', () => {
    const events = [
      event(1, 'task_started', { goal: GOAL }),
      event(2, 'task_completed', { reply: CHAT_REPLY, factCount: 0, facts: [] })
    ]

    expect(completedReply(events)).toBe(CHAT_REPLY)
  })

  it('没有 task_completed → null', () => {
    expect(completedReply([event(1, 'task_started', { goal: GOAL })])).toBeNull()
    expect(completedReply([])).toBeNull()
  })

  it('reply 缺失、空串或非字符串 → null', () => {
    const withPayload = (payload: unknown): ExecutionEventRecord[] => [
      event(1, 'task_completed', payload)
    ]

    expect(completedReply(withPayload({ factCount: 0 }))).toBeNull()
    expect(completedReply(withPayload({ reply: '' }))).toBeNull()
    expect(completedReply(withPayload({ reply: 42 }))).toBeNull()
  })

  it('多条 task_completed 取最后一条（脏数据以最终结局为准）', () => {
    const events = [
      event(1, 'task_completed', { reply: '旧的' }),
      event(2, 'task_completed', { reply: '最终的' })
    ]

    expect(completedReply(events)).toBe('最终的')
  })
})

describe('collectEvidence：零工具轮次的取证（TASK-031）', () => {
  function seedChatTurn(deps: EvidenceDeps): void {
    seedTask(deps, TASK_ID, '你好')
    seedPlan(deps, CHAT_PLAN)
    seedEvent(deps, 'task_started', { goal: '你好' })
    seedEvent(deps, 'task_completed', { reply: CHAT_REPLY, factCount: 0, facts: [] })
  }

  it('reply 进证据包', async () => {
    const deps = openHarness()
    seedChatTurn(deps)

    const evidence = await collectEvidence(deps, { taskId: TASK_ID, facts: [] })

    expect(evidence.reply).toBe(CHAT_REPLY)
  })

  it('计划没有 extract_pdf 时，「没有成功的提取调用」不算缺口', async () => {
    const deps = openHarness()
    seedChatTurn(deps)

    const evidence = await collectEvidence(deps, { taskId: TASK_ID, facts: [] })

    // 这条 gap 会让 fail-closed 的总判定无条件拒绝——零工具轮次会被它卡死
    expect(evidence.gaps).toEqual([])
  })

  it('计划里有 extract_pdf 但没有成功提取 → 照旧记缺口（fail-closed 不松）', async () => {
    const deps = openHarness()
    seedTask(deps)
    seedPlan(deps)
    seedEvent(deps, 'task_started', { goal: GOAL })
    seedEvent(deps, 'task_completed', { reply: CHAT_REPLY, factCount: 0, facts: [] })

    const evidence = await collectEvidence(deps, { taskId: TASK_ID, facts: FACTS })

    expect(evidence.gaps.some((gap) => gap.includes('document.extract_pdf'))).toBe(true)
  })
})

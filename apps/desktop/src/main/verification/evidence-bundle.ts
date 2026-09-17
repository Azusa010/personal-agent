import { CapabilityId, EXTRACT_PDF_CAPABILITY, type SummaryFact } from '@personal-agent/protocol'

import type {
  ExecutionEventRecord,
  PermissionStatus,
  PlanRecord,
  PlanStep,
  ReminderRecord,
  ReminderStatus,
  TaskRecord,
  ToolExecutionStatus
} from '../../shared/domain'
import type { EventRepository } from '../product-state/event-repository'
import type { PermissionRepository } from '../product-state/permission-repository'
import type { PlanRepository } from '../product-state/plan-repository'
import type { ReminderRepository } from '../product-state/reminder-repository'
import type { TaskRepository } from '../product-state/task-repository'
import type { ToolExecutionRepository } from '../product-state/tool-execution-repository'

/**
 * Evidence Bundle。
 *
 * 本文件负责 取证 ：把「这个任务到底交付了什么」从可信侧的真实状态里查出来，
 * 而不是听 Python 或模型自述。真实状态有三处来源：
 *
 *   1. Product State（tasks / plans / execution_events / permissions /
 *      tool_executions / reminders）；
 *   2. 真实文件系统（源路径是否已消失、目标路径是否真的存在）；
 *   3. 真实 PDF（重新读一次页号集合，摘要的页码引用要落在这个集合里）。
 *
 * 第 2、3 项走 VerificationPorts 端口，生产实现在 ports.ts，
 *
 * 判定不在这里：本文件只负责「查出事实」，哪些事实算交付、缺了算不算失败，
 * 全部收在 verify-deliverables.ts 的判定表里。
 */

export const TOOL_CALLED_EVENT = 'tool_called'
export const TOOL_RESULT_EVENT = 'tool_result'

/**
 * 能力名只有 protocol 一个事实来源：`CapabilityId` 是 zod enum，
 * `CapabilityId.enum[...]` 的值就是能力名字面量本身——名字漂了在编译期报错，
 * 而不是在运行时静默变成「查不到证据」。
 */
export { EXTRACT_PDF_CAPABILITY }

/** filesystem.move 的能力名。同一条派生规则，不在本文件写第二份字面量。 */
const MOVE_CAPABILITY = CapabilityId.enum['filesystem.move']
/** 判定表的检查项。id 是稳定契约：报告、UI、验收测试都按 id 断言，不要改名。 */
export const VERIFICATION_CHECK_IDS = [
  /** 摘要存在，且每条 fact 带非空页码引用 */
  'summary_present',
  /** 页码引用全部落在「重读真实 PDF」得到的页集合里 */
  'page_refs_grounded',
  /** 计划里每个带 capability 的步骤都有成功的 tool_result */
  'plan_steps_completed',
  /** 时间线含完成判定所需的证据（task_started / task_completed，且取证没有缺口） */
  'timeline_evidence',
  /** 计划里的 WRITE 步骤都有 approved 的 Permission，且与执行记录同参 */
  'permission_approved',
  /** 被拒绝（denied）的调用没有产生副作用 */
  'denied_no_side_effect',
  /** 被批准移动的文件确实位于目标目录（源已消失、目标存在） */
  'file_at_target',
  /** Reminder 已持久化，且带唯一幂等键 */
  'reminder_persisted',
  /** 有回复存在 */
  'reply_present'
] as const

export type VerificationCheckId = (typeof VERIFICATION_CHECK_IDS)[number]

export interface VerificationCheck {
  id: VerificationCheckId
  ok: boolean
  /** 人可读的判定依据：通过时写看到了什么，不通过时写缺了什么。 */
  detail: string
}

export interface VerificationReport {
  /** 全部检查通过才是 true。completed 只认这个字段 */
  ok: boolean
  checks: VerificationCheck[]
  /** 不通过时的一句话原因（进 task_failed 事件与 IPC reason）；通过时为 null */
  reason: string | null
}

/** 一次工具调用的可见结果。hasResult=false 表示时间线里没有配对的 tool_result。 */
export interface ToolCallEvidence {
  callId: string
  capability: string
  ok: boolean
  hasResult: boolean
}

/** 一次授权记录。status 是库里原样读出的值（pending 也是事实）。 */
export interface PermissionEvidence {
  toolCallId: string
  capability: string
  status: PermissionStatus
  argsHash: string
}

/** 一次副作用执行的登记（幂等 store）。WRITE 能力才有。 */
export interface ExecutionEvidence {
  idempotencyKey: string
  capability: string
  argsHash: string
  status: ToolExecutionStatus
  sourcePaths: string[]
  targetPath: string | null
}

/** 一次已成功的移动 + 它的真实文件系统状态。 */
export interface MoveEvidence {
  sourcePath: string
  targetPath: string
  /** 源路径此刻已不存在：移动确实发生过 */
  sourceGone: boolean
  /** 目标路径此刻存在：文件真的在目标位置 */
  targetPresent: boolean
}

export interface ReminderEvidence {
  id: string
  remindAt: string
  status: ReminderStatus
  idempotencyKey: string
}

/** 本次判定所依据的事件序号区间（闭区间） */
export interface EventSequenceRange {
  from: number
  to: number
}

/**
 * 判定表的输入。字段全部是「查出来的事实」，不含任何结论——
 * 哪些算交付物、缺了算不算失败，是 verify-deliverables.ts 的事。
 */
export interface CollectedEvidence {
  taskId: string
  goal: string
  planVersion: number | null
  planSteps: PlanStep[]
  /** Agent 的完成声明（已过 Python 侧 SummaryVerifier，但在可信侧仍只是声明） */
  summary: SummaryFact[]
  /** summary 里出现过的页码，去重升序 */
  reply: string | null
  pageReferences: number[]
  /** 摘要依据的那份 PDF：时间线里最后一次成功的 document.extract_pdf 的入参路径 */
  selectedPdf: string | null
  /** selectedPdf 解析到授权根内的真实路径；被移动过则取移动后的位置 */
  resolvedPdfPath: string | null
  /** 重读真实 PDF 得到的页号集合（升序）。null = 读不出来 */
  parsedPageNumbers: number[] | null
  /** 重读得到的页数。null = 读不出来。可读的 PDF 一定 ≥ 1 页 */
  parsedPageCount: number | null
  toolResults: ToolCallEvidence[]
  permissions: PermissionEvidence[]
  executions: ExecutionEvidence[]
  moves: MoveEvidence[]
  /** 成功移动且目标此刻存在的最终文件路径；没有就是 null */
  finalFilePath: string | null
  reminder: ReminderEvidence | null
  eventSequenceRange: EventSequenceRange | null
  /** 取证过程中的失败（路径解析不了、PDF 读不出来、任务行缺失…）。判定表必须据此拒绝 */
  gaps: string[]
}

/** 留档产物：判定前收集到的事实 + 判定结论。落进 verification_* 事件的 payload。 */
export interface EvidenceBundle extends CollectedEvidence {
  verificationReport: VerificationReport
}

/** 重读真实 PDF 的结果。读不出来是「事实」，不是异常。 */
export type PageNumbersRead = { ok: true; pageNumbers: number[] } | { ok: false; reason: string }

/**
 * 取证的三个外部依赖。生产实现在 ports.ts；测试注入假件。
 * 三个都可能 reject（比如文件系统报错），collectEvidence 会把它收进 gaps。
 */
export interface VerificationPorts {
  /** 把事件里的原始路径解析成授权根内的真实绝对路径。null = 越界或根不可用 */
  resolvePath(rawPath: string): Promise<string | null>
  readPageNumbers(absPath: string): Promise<PageNumbersRead>
  pathExists(absPath: string): Promise<boolean>
}

export interface EvidenceDeps extends VerificationPorts {
  tasks: TaskRepository
  plans: PlanRepository
  events: EventRepository
  permissions: PermissionRepository
  executions: ToolExecutionRepository
  reminders: ReminderRepository
}

export interface EvidenceInput {
  taskId: string
  /** Python 的完成声明。取证侧只把它当声明看 */
  facts: SummaryFact[]
}

/**
 * 读事件 payload 的两个助手：payload 是 unknown，六种事件各有各的形状。
 * 供本文件的 TODO 实现直接取用；判定表不 import 它们——判定表的输入已经是结构化事实。
 */
export function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * 工具调用与结果的配对（数据转换）。
 *
 * tool_called 与 tool_result 是事件流里两条独立记录，配对键是 payload.callId
 * （Python 侧 engine.py 保证同一次调用两条事件共用一个 callId）。所以结论只有
 * 两趟才做得出来：第一趟先按事件顺序产出调用记录，第二趟拿结果回填。
 *
 * 两个字段的语义（判定表按它们分开处置「失败」与「没回来」）：
 *   - 有配对结果：hasResult = true，ok = (payload.ok === true)；
 *   - 没有配对结果：hasResult = false，ok = false。
 * 同一 callId 出现多次（重试）时以**最后一条**结果为准。
 */
export function collectToolResults(events: ExecutionEventRecord[]): ToolCallEvidence[] {
  const out: ToolCallEvidence[] = []

  const readPayload = (
    e: ExecutionEventRecord
  ): { callId: string; capability: string; ok: unknown } | null => {
    const payload = asRecord(e.payload)
    if (Object.keys(payload).length === 0) return null

    const callId = asString(payload['callId'])
    const capability = asString(payload['capability'])
    if (callId === null || capability === null) return null

    return { callId, capability, ok: payload['ok'] }
  }

  // 第一趟：按事件顺序产出，此时还不知道有没有结果
  for (const e of events) {
    if (e.type !== TOOL_CALLED_EVENT) continue
    const p = readPayload(e)
    if (p === null) continue
    out.push({ callId: p.callId, capability: p.capability, ok: false, hasResult: false })
  }

  // 第二趟：结果回填。callId 出现多次时后到的覆盖先到的（重试以最后一条为准）
  const byCallId = new Map(out.map((item) => [item.callId, item]))
  for (const e of events) {
    if (e.type !== TOOL_RESULT_EVENT) continue
    const p = readPayload(e)
    if (p === null) continue
    const evidence = byCallId.get(p.callId)
    if (evidence === undefined) continue
    evidence.hasResult = true
    evidence.ok = p.ok === true
  }

  return out
}

/**
 * 摘要依据的那份 PDF 是哪个（业务主逻辑）。
 *
 * 规则：**最后一次成功的** document.extract_pdf 调用的入参路径。
 *  - 「成功」= 该 callId 有 tool_result 且 ok === true；失败的那次不算数，
 *    它引用的页集合根本不存在；
 *  - 多次提取时取最后一次：后一次提取会覆盖前一次的页集合，摘要依据的是它；
 *  - 缺 arguments.path / path 为空串 → 这一次定不出路径，不算数；
 *  - 一次都没有 → null（取证会记一条 gap）。
 */
export function lastExtractedPath(events: ExecutionEventRecord[]): string | null {
  const succeeded = new Set(
    collectToolResults(events)
      .filter((r) => r.capability === EXTRACT_PDF_CAPABILITY && r.ok && r.hasResult)
      .map((r) => r.callId)
  )
  if (succeeded.size === 0) return null

  let lastPath: string | null = null
  for (const e of events) {
    if (e.type !== TOOL_CALLED_EVENT) continue
    const payload = asRecord(e.payload)
    const callId = asString(payload['callId'])
    if (callId === null || !succeeded.has(callId)) continue
    const path = asString(asRecord(payload['arguments'])['path'])
    if (path !== null) lastPath = path
  }
  return lastPath
}

export function completedReply(events: ExecutionEventRecord[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e === undefined || e.type !== 'task_completed') continue
    const payload = asRecord(e.payload)
    const reply = asString(payload['reply'])
    return typeof reply === 'string' && reply.length > 0 ? reply : null
  }
  return null
}

/**
 * 重读页号时该读哪个路径（业务主逻辑）。
 *
 * 规则：从当前路径出发，沿「源路径相等且源已消失、目标存在」的移动走到底——
 * 一次移动可能只是链条中的一环（A→B→C），走不动了就停在当前路径。
 * 注意这里返回的是**路径**，不是「文件在不在」的判定：判定表有自己的规则兜底。
 */
export function currentPathOf(resolvedPath: string, moves: MoveEvidence[]): string {
  for (const [index, move] of moves.entries()) {
    if (move.sourcePath === resolvedPath && move.sourceGone && move.targetPresent) {
      return currentPathOf(move.targetPath, moves.slice(index + 1))
    }
  }
  return resolvedPath
}

function collectPageReferences(facts: readonly SummaryFact[]): number[] {
  const refs = new Set<number>()
  for (const fact of facts) {
    for (const ref of fact.pageRefs) refs.add(ref)
  }
  return [...refs].sort((a, b) => a - b)
}

function toSequenceRange(events: readonly ExecutionEventRecord[]): EventSequenceRange | null {
  if (events.length === 0) return null
  const seqs = events.map((e) => e.seq)
  return { from: Math.min(...seqs), to: Math.max(...seqs) }
}

/**
 * 「最终文件路径」取哪一条（数据转换）。
 *
 * 规则：**最后一条**「源已消失且目标存在」的移动的目标路径——这才是真正落地的那次交付。
 * 只「打算移」（源还在）或目标不存在的记录不算交付；一条都没有就 null。
 */
export function finalPathOf(moves: MoveEvidence[]): string | null {
  for (const move of [...moves].reverse()) {
    if (move.sourceGone && move.targetPresent) return move.targetPath
  }
  return null
}

/**
 * 移动证据的文件系统探测与失败收场（健壮性）。
 *
 * 只有 capability 是 filesystem.move 且 status === 'succeeded' 的执行记录算移动证据：
 * attempting / failed 是「打算移」而不是「移完了」，它们已经完整地在 executions 里，
 * 判定表自己会看。
 *
 * 探测是并行的，但**顺序必须确定**：结果按记录顺序回填，gap 也在同一个循环里
 * 按序追加——这两样会进 Evidence Bundle 与 task_failed，顺序漂了排障时会读出
 * 一个假的「变化」。并发度天然有界（一个任务的移动记录数封顶），不是无界并发。
 *
 * 单条记录失败不影响其余记录：一条坏记录不该让整个任务无法完成。
 */
async function collectMoveEvidence(
  executions: ExecutionEvidence[],
  ports: VerificationPorts,
  gaps: string[]
): Promise<MoveEvidence[]> {
  const candidates = executions.filter(
    (exec) => exec.capability === MOVE_CAPABILITY && exec.status === 'succeeded'
  )

  const probed = await Promise.all(
    candidates.map(async (exec): Promise<{ gap: string | null; move: MoveEvidence | null }> => {
      const sourcePath = exec.sourcePaths[0]
      const targetPath = exec.targetPath
      if (sourcePath === undefined || targetPath === null) {
        return {
          gap: `移动记录 ${exec.idempotencyKey} 缺 source/target，无法核对文件位置`,
          move: null
        }
      }
      try {
        const [sourceExists, targetExists] = await Promise.all([
          ports.pathExists(sourcePath),
          ports.pathExists(targetPath)
        ])
        return {
          gap: null,
          move: { sourcePath, targetPath, sourceGone: !sourceExists, targetPresent: targetExists }
        }
      } catch (e) {
        return { gap: `文件系统检查失败 (${targetPath}): ${describeThrown(e)}`, move: null }
      }
    })
  )

  const moves: MoveEvidence[] = []
  for (const item of probed) {
    if (item.gap !== null) gaps.push(item.gap)
    if (item.move !== null) moves.push(item.move)
  }
  return moves
}

/**
 * 真实 PDF 页号的取证与缺口分流（健壮性）。
 *
 * 三处失败各自的收场：路径解析不了就不去碰文件系统；读不出来仍要写清
 * 「本来打算读哪个路径」；端口抛错与返回失败同样对待。每一步都留一条 gap——
 * 这条字符串会一路进 task_failed 事件，是「为什么没完成」在 UI 上唯一的解释。
 */
async function collectPdfPages(
  deps: EvidenceDeps,
  events: ExecutionEventRecord[],
  moves: MoveEvidence[],
  gaps: string[],
  planHasExtractPdf: boolean
): Promise<{
  selectedPdf: string | null
  resolvedPdfPath: string | null
  parsedPageNumbers: number[] | null
  parsedPageCount: number | null
}> {
  const selectedPdf = lastExtractedPath(events)
  if (selectedPdf === null) {
    if (planHasExtractPdf) {
      gaps.push('时间线里没有成功的 document.extract_pdf 调用，拿不到摘要依据的 PDF')
    }
    return {
      selectedPdf: null,
      resolvedPdfPath: null,
      parsedPageNumbers: null,
      parsedPageCount: null
    }
  }

  let resolvedPath: string | null
  try {
    resolvedPath = await deps.resolvePath(selectedPdf)
  } catch (e) {
    gaps.push(`解析 PDF 路径失败 (${selectedPdf}): ${describeThrown(e)}`)
    return { selectedPdf, resolvedPdfPath: null, parsedPageNumbers: null, parsedPageCount: null }
  }
  if (resolvedPath === null) {
    gaps.push(`摘要依据的 PDF 不在授权根内: ${selectedPdf}`)
    return { selectedPdf, resolvedPdfPath: null, parsedPageNumbers: null, parsedPageCount: null }
  }

  const readPath = currentPathOf(resolvedPath, moves)
  try {
    const read = await deps.readPageNumbers(readPath)
    if (!read.ok) {
      gaps.push(`重读真实 PDF 失败 (${readPath}): ${read.reason}`)
      return {
        selectedPdf,
        resolvedPdfPath: readPath,
        parsedPageNumbers: null,
        parsedPageCount: null
      }
    }
    // 去重升序：判定表按集合语义用它。PDF 页号天然唯一，去重是防端口给脏数据。
    const pageNumbers = [...new Set(read.pageNumbers)].sort((a, b) => a - b)
    return {
      selectedPdf,
      resolvedPdfPath: readPath,
      parsedPageNumbers: pageNumbers,
      parsedPageCount: pageNumbers.length
    }
  } catch (e) {
    gaps.push(`重读真实 PDF 抛错 (${readPath}): ${describeThrown(e)}`)
    return {
      selectedPdf,
      resolvedPdfPath: readPath,
      parsedPageNumbers: null,
      parsedPageCount: null
    }
  }
}

/** 端口抛出的可能是任意值（不是 Error 也不奇怪），统一压成一行文案。 */
function describeThrown(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code
    return code ? `${code}: ${e.message}` : e.message
  }
  return String(e)
}

/**
 * 取证主流程。只读，不改任何状态：判定要能重复跑出同一结论。
 *
 * 每一步的失败都收进 gaps 而不是抛出去——判定表拿到完整事实后统一决定，
 * 比中途抛错更可解释（«缺什么» 比 «第几步炸了» 有用）。
 *
 * 读库收在 readProductState 里，本函数只做编排：先探文件系统（move 证据决定了
 * 文件此刻在哪），再按当前位置重读 PDF，最后拼出证据包。两步之间是真依赖
 * （读 PDF 要用 moves 的结果），所以不并行；能并行的部分在 collectMoveEvidence 内部。
 */
export async function collectEvidence(
  deps: EvidenceDeps,
  input: EvidenceInput
): Promise<CollectedEvidence> {
  const gaps: string[] = []
  const state = readProductState(deps, input.taskId)
  if (state.task === null) {
    gaps.push(`任务不存在: ${input.taskId}`)
  }

  const hasExtractPdf = (state.plan?.steps ?? []).some(
    (step) => step.capability === 'document.extract_pdf'
  )

  const moves = await collectMoveEvidence(state.executions, deps, gaps)
  const pdf = await collectPdfPages(deps, state.events, moves, gaps, hasExtractPdf)

  return {
    taskId: input.taskId,
    goal: state.task?.goal ?? '',
    planVersion: state.plan?.version ?? null,
    planSteps: state.plan?.steps ?? [],
    summary: input.facts,
    reply: completedReply(state.events),
    pageReferences: collectPageReferences(input.facts),
    selectedPdf: pdf.selectedPdf,
    resolvedPdfPath: pdf.resolvedPdfPath,
    parsedPageNumbers: pdf.parsedPageNumbers,
    parsedPageCount: pdf.parsedPageCount,
    toolResults: collectToolResults(state.events),
    permissions: state.permissions,
    executions: state.executions,
    moves,
    finalFilePath: finalPathOf(moves),
    reminder:
      state.reminder === null
        ? null
        : {
            id: state.reminder.id,
            remindAt: state.reminder.remindAt,
            status: state.reminder.status,
            idempotencyKey: state.reminder.idempotencyKey
          },
    eventSequenceRange: toSequenceRange(state.events),
    gaps
  }
}

/** 一个任务在 Product State 里的全部相关行，六张表读齐、映射成证据包要的形状。 */
interface ProductStateSnapshot {
  task: TaskRecord | null
  plan: PlanRecord | null
  events: ExecutionEventRecord[]
  permissions: PermissionEvidence[]
  executions: ExecutionEvidence[]
  reminder: ReminderRecord | null
}

function readProductState(deps: EvidenceDeps, taskId: string): ProductStateSnapshot {
  return {
    task: deps.tasks.findById(taskId),
    plan: deps.plans.findLatest(taskId),
    events: deps.events.listByTask(taskId),
    permissions: deps.permissions.findByTaskId(taskId).map((p) => ({
      toolCallId: p.toolCallId,
      capability: p.capability,
      status: p.status,
      argsHash: p.argsHash
    })),
    executions: deps.executions.findByTaskId(taskId).map((e) => ({
      idempotencyKey: e.idempotencyKey,
      capability: e.capability,
      argsHash: e.argsHash,
      status: e.status,
      sourcePaths: e.sourcePaths,
      targetPath: e.targetPath
    })),
    reminder: deps.reminders.findByTaskId(taskId)
  }
}

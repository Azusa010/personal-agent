import { stat } from 'node:fs/promises'
import { Stats } from 'node:fs'

import type { ToolExecutionRecord } from '../../shared/domain'
import { fingerprintArguments } from '../permission/args-hash'
import type { BoundArgs } from '../policy/argument-binders'
import type { AuthorizedCall } from '../policy/execution-policy'
import type { ToolExecutionRepository } from '../product-state/tool-execution-repository'

async function safeStat(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

// ---------- 1. 幂等键 ----------
/**
 * 从任务、能力名与绑定参数算出稳定的幂等键，格式固定为 `taskId:capability:argsHash`。
 *
 * 带 taskId 是必须的：「同一副作用只执行一次」是**任务内**的承诺，两个任务参数恰好
 * 相同不是重复（reminders 那边不设 UNIQUE 也是这个口径）。而 tool_executions 的主键
 * 就是这把键——不带 taskId 时，第二个任务只要是同一份文件、同一个目标，就会在 INSERT
 * 上撞主键；就算不撞，命中的也是别的任务的记录，本次操作会被静默跳过。
 *
 * 键里带 taskId 还让排查时一眼看得出这条登记属于哪个任务。
 */
export function idempotencyKey(taskId: string, capability: string, bound: BoundArgs): string {
  return `${taskId}:${capability}:${fingerprintArguments(bound).hash}`
}

// ---------- 2. 崩溃恢复判定 ----------

/** resolver 对一条 attempting 记录的判定结论。
 *  done = 文件系统证明副作用已发生 → 翻 succeeded、跳过重跑；
 *  not-done = 文件系统证明副作用没发生 → 可以安全重跑；
 *  unknown = 状态自相矛盾，不敢判定 → 翻 failed，交上层处理。
 */
export type RecoveryVerdict =
  | { readonly kind: 'done' }
  | { readonly kind: 'not-done' }
  | { readonly kind: 'unknown'; readonly reason: string }

/** 按能力把恢复判定分发到各自的文件系统检查 */
export async function resolveExecution(record: ToolExecutionRecord): Promise<RecoveryVerdict> {
  switch (record.capability) {
    case 'filesystem.move':
      return resolveMove(record)
    case 'filesystem.create_dir':
      return resolveCreateDir(record)
    default:
      return { kind: 'unknown', reason: `没有崩溃恢复判定的能力: ${record.capability}` }
  }
}

/** filesystem.move 的崩溃恢复判定 */
async function resolveMove(record: ToolExecutionRecord): Promise<RecoveryVerdict> {
  if (record.sourcePaths.length === 0 || record.targetPath === null) {
    return { kind: 'unknown', reason: '数据异常：sourcePaths 为空或 targetPath 为 null' }
  }
  const sourceStats = await safeStat(record.sourcePaths[0])
  const targetStats = await safeStat(record.targetPath)
  if (!sourceStats && targetStats) {
    return { kind: 'done' }
  }
  if (!sourceStats && !targetStats) {
    return { kind: 'unknown', reason: '源路径和目标路径都不存在' }
  }
  if (sourceStats && targetStats) {
    return { kind: 'unknown', reason: '源路径和目标路径同时存在' }
  }
  return { kind: 'not-done' }
}

/** filesystem.create_dir 的崩溃恢复判定。*/
async function resolveCreateDir(record: ToolExecutionRecord): Promise<RecoveryVerdict> {
  if (record.targetPath === null) {
    return { kind: 'unknown', reason: '数据异常：targetPath 为 null' }
  }
  const targetStats = await safeStat(record.targetPath)
  if (targetStats && targetStats.isDirectory()) {
    return { kind: 'done' }
  }
  if (targetStats && !targetStats.isDirectory()) {
    return { kind: 'unknown', reason: '目标路径存在但不是目录' }
  }
  return { kind: 'not-done' }
}

// ---------- 3. 执行链编排 ----------

/** 编排依赖：执行记录仓库 + 可选时钟。executor 集成时注入，测试里传内存库。 */
export interface IdempotencyDeps {
  readonly executions: ToolExecutionRepository
  readonly now?: () => string
}

/** 执行前幂等关的三种决策。
 *  proceed = 副作用还没发生，让 executor 去跑（记录已就位为 attempting，跑完 afterExecute 翻转）；
 *  skip = 副作用确认已发生，直接返回缓存/构造的成功结果，绝不再跑；
 *  reject = 文件系统处于矛盾态，不敢跑也不敢跳，翻 failed 并返回失败结果交上层。
 */
export type BeforeDecision =
  | { readonly kind: 'proceed'; readonly key: string }
  | { readonly kind: 'skip'; readonly key: string; readonly result: Record<string, unknown> }
  | { readonly kind: 'reject'; readonly key: string; readonly result: Record<string, unknown> }

/** 会产生文件系统副作用、需要幂等保护的能力。只读能力（list/extract_pdf）不在内。 */
const WRITE_CAPABILITIES: ReadonlySet<string> = new Set([
  'filesystem.move',
  'filesystem.create_dir'
])

export function isWriteCapability(name: string): boolean {
  return WRITE_CAPABILITIES.has(name)
}

/** 从 bound.paths 提取这次调用的副作用路径，写进记录供 resolver 崩溃后复查。
 *  字段名 per-capability：move 是 source/target，create_dir 只有 path（当作 target，无 source）。
 */
function extractSideEffects(
  capability: string,
  bound: BoundArgs
): { sourcePaths: string[]; targetPath: string | null } {
  switch (capability) {
    case 'filesystem.move':
      return { sourcePaths: [bound.paths['source']], targetPath: bound.paths['target'] }
    case 'filesystem.create_dir':
      return { sourcePaths: [], targetPath: bound.paths['path'] }
    default:
      return { sourcePaths: [], targetPath: null }
  }
}

/** 执行前的幂等关：查这个 key 以前登记过没有，决定这次要不要真的跑副作用。*/
export async function beginAttempt(
  deps: IdempotencyDeps,
  call: AuthorizedCall
): Promise<BeforeDecision> {
  const capability = call.capability.name
  const key = idempotencyKey(call.taskId, capability, call.bound)
  const existing = deps.executions.findByKey(key)
  const stamp = (): string => deps.now?.() ?? new Date().toISOString()
  const sideEffects = extractSideEffects(capability, call.bound)
  const freshRecord: ToolExecutionRecord = {
    idempotencyKey: key,
    taskId: call.taskId,
    toolCallId: call.callId,
    capability,
    argsHash: fingerprintArguments(call.bound).hash,
    sourcePaths: sideEffects.sourcePaths,
    targetPath: sideEffects.targetPath,
    status: 'attempting',
    attemptedAt: stamp(),
    finishedAt: null,
    resultPayload: null
  }

  if (existing === null) {
    deps.executions.insert(freshRecord)
    return { kind: 'proceed', key }
  }

  if (existing.status === 'succeeded') {
    return { kind: 'skip', key, result: existing.resultPayload as Record<string, unknown> }
  }

  if (existing.status === 'attempting') {
    const verdict = await resolveExecution(existing)
    if (verdict.kind === 'done') {
      deps.executions.transition(key, 'succeeded', stamp())
      return { kind: 'skip', key, result: { ok: true, idempotent: true } }
    }
    if (verdict.kind === 'not-done') {
      return { kind: 'proceed', key }
    }
    if (verdict.kind === 'unknown') {
      deps.executions.transition(key, 'failed', stamp())
      return {
        kind: 'reject',
        key,
        result: { ok: false, code: 'IDEMPOTENCY_CONFLICT', reason: verdict.reason }
      }
    }
  }
  if (existing.status === 'failed') {
    deps.executions.transition(key, 'attempting', stamp())
    return { kind: 'proceed', key }
  }
  return {
    kind: 'reject',
    key,
    result: { ok: false, code: 'IDEMPOTENCY_CONFLICT', reason: '未知状态' }
  }
}

/** 执行后翻转状态：把 attempting 翻成 succeeded 或 failed，并记下完成时间。 */
export function afterExecute(
  deps: IdempotencyDeps,
  key: string,
  outcome: Record<string, unknown>
): void {
  const stamp = (): string => deps.now?.() ?? new Date().toISOString()
  if (outcome['ok'] === true) {
    deps.executions.transition(key, 'succeeded', stamp(), outcome)
  } else {
    deps.executions.transition(key, 'failed', stamp())
  }
}

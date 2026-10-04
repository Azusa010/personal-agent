import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

import { extractPdf } from '../capabilities/document-extract-pdf'
import type { EventRepository } from '../product-state/event-repository'
import type { TaskRepository } from '../product-state/task-repository'
import { EXTRACT_PDF_CAPABILITY, SummaryFact } from '@personal-agent/protocol'
import type { CaseObservation, CaseToolCall } from './judge'

/**
 * 一次 case 跑完之后，把判定要读的事实取出来。
 *
 * 与  evidence-bundle 同一个立场：取证独立于被取证方的自述。
 * 页集合是**重新读一遍目标 PDF** 得到的（不是抄模型或 host 回传的页数），
 * 工具调用与事件从库里读（不是从 runTask 的回包里读——那是"声明"）。
 */

/**
 * model_usage 事件的 payload。
 *
 * 字段名与 Python 的 ModelUsage 逐字对齐，靠 observation.test.ts 里的
 * 跨语言用例钉住：那边从 venv 里真的打印一份 model_dump_json，这边用这个
 * schema 解析。改名而只改一侧不会报错，只会让成本统计静默变成 0。
 */
export const ModelUsagePayload = z.object({
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative()
})

export type ModelUsagePayload = z.infer<typeof ModelUsagePayload>

/** 事件类型字面值。与 Python engine.py 的 EVENT_* 常量对应 */
const EVENT_TOOL_CALLED = 'tool_called'
const EVENT_TOOL_RESULT = 'tool_result'
const EVENT_TASK_COMPLETED = 'task_completed'
const EVENT_TASK_FAILED = 'task_failed'
const EVENT_BUDGET_EXHAUSTED = 'budget_exhausted'
const EVENT_VERIFICATION_PASSED = 'verification_passed'
const EVENT_VERIFICATION_FAILED = 'verification_failed'
const EVENT_MODEL_USAGE = 'model_usage'

export interface ObservationDeps {
  tasks: TaskRepository
  events: EventRepository
}

export interface CollectInput {
  caseId: string
  taskId: string
  /** 这次任务期望被提取的那份 PDF 的绝对路径（工作区物化时就知道，不依赖模型选对） */
  targetPath: string
  /**
   * case 工作区根。给了就顺带取一份**终态文件清单**（stateful 判定的证据，与
   * 取证同立场：读盘，不采信模型或闸口的自述）；不给就是 null（读链路用不上）。
   */
  rootDir?: string | null
}

export interface CollectedCase {
  observation: CaseObservation
  /** 有 model_usage 事件才有；scripted 模式恒为 null（成本按 0 报，不是按未知） */
  modelUsage: ModelUsagePayload | null
}

export async function collectObservation(
  deps: ObservationDeps,
  input: CollectInput
): Promise<CollectedCase> {
  const events = deps.events.listByTask(input.taskId)
  const task = deps.tasks.findById(input.taskId)

  const facts = collectFacts(events)
  const toolCalls = collectToolCalls(events)
  const extractedPaths = toolCalls
    .filter(
      (call) => call.capability === EXTRACT_PDF_CAPABILITY || call.capability === 'read_document'
    )
    .map((call) => call.arguments['path'])
    .filter((path): path is string => typeof path === 'string')
  const finalFiles =
    input.rootDir === null || input.rootDir === undefined
      ? null
      : await collectFinalFiles(input.rootDir)

  return {
    observation: {
      caseId: input.caseId,
      taskId: input.taskId,
      status: task?.status === 'completed' || task?.status === 'failed' ? task.status : 'unknown',
      facts,
      realPageNumbers: await readPageNumbers(input.targetPath),
      toolCalls,
      extractedPaths,
      budgetExhausted: events.some((e) => e.type === EVENT_BUDGET_EXHAUSTED),
      verificationOk: collectVerification(events),
      verificationReason: collectVerificationReason(events),
      failedToolCalls: collectFailedToolCalls(events),
      finalFiles
    },
    modelUsage: collectModelUsage(events)
  }
}

/** 目标 PDF 的真实页号。读不出来就是 null —— 判定侧按 fail-closed 处理 */
async function readPageNumbers(path: string): Promise<number[] | null> {
  try {
    const extracted = await extractPdf(new Uint8Array(await readFile(path)))
    if (!extracted.ok) return null
    return extracted.pages.map((page) => page.pageNumber)
  } catch {
    // 文件不在、读不动、PDF 解析库抛错：都归"拿不到页集合"这一类。
    // 判定表的 fail-closed 底线就靠这个 null。
    return null
  }
}

/**
 * 终态文件清单：相对 rootDir 的 posix 路径，递归、排序。判定读它核对「谁动了
 * 工作区」。目录读不出来就抛给调用方——collectObservation 的 rootDir 来自
 * materializeCase 刚建出来的目录，读不出来说明环境坏了，按缺口处理（fail-closed）。
 */
export async function collectFinalFiles(rootDir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(rel: string): Promise<void> {
    const entries = await readdir(join(rootDir, rel), { withFileTypes: true })
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) await walk(child)
      else out.push(child)
    }
  }
  await walk('')
  return out.sort((a, b) => a.localeCompare(b))
}

function collectFacts(events: { type: string; payload: unknown }[]): SummaryFact[] {
  const completed = events.filter((e) => e.type === EVENT_TASK_COMPLETED)
  const last = completed.at(-1)
  if (last === undefined) return []
  const payload = asRecord(last.payload)
  const parsed = z.array(SummaryFact).safeParse(payload['facts'])
  return parsed.success ? parsed.data : []
}

function collectToolCalls(events: { type: string; payload: unknown }[]): CaseToolCall[] {
  const calls: CaseToolCall[] = []
  for (const event of events) {
    if (event.type !== EVENT_TOOL_CALLED) continue
    const payload = asRecord(event.payload)
    const capability = payload['capability']
    if (typeof capability !== 'string' || capability === '') continue
    calls.push({ capability, arguments: asRecord(payload['arguments']) })
  }
  return calls
}

function collectFailedToolCalls(events: { type: string; payload: unknown }[]): number {
  return events.filter((e) => e.type === EVENT_TOOL_RESULT && asRecord(e.payload)['ok'] === false)
    .length
}

/** Main 侧闸口的结论。没跑到判定就是 null，与"判定没通过"分开报 */
function collectVerification(events: { type: string; payload: unknown }[]): boolean | null {
  for (const event of events.toReversed()) {
    if (event.type === EVENT_VERIFICATION_PASSED) return true
    if (event.type === EVENT_VERIFICATION_FAILED) return false
  }
  return null
}

/**
 * 闸口拒绝的原因：verification_failed 事件的 payload.report.reason；兜底读
 * task_failed 的 message（同一结局在 UI 侧的那条）。没有就是 null——null 与
 * "拒了但没说为什么"在取证上要分开。
 */
function collectVerificationReason(events: { type: string; payload: unknown }[]): string | null {
  for (const event of events.toReversed()) {
    if (event.type !== EVENT_VERIFICATION_FAILED) continue
    const report = asRecord(asRecord(event.payload)['report'])
    const reason = report['reason']
    if (typeof reason === 'string' && reason !== '') return reason
  }
  const failed = events.filter((e) => e.type === EVENT_TASK_FAILED).at(-1)
  if (failed !== undefined) {
    const message = asRecord(failed.payload)['message']
    if (typeof message === 'string' && message !== '') return message
  }
  return null
}

function collectModelUsage(events: { type: string; payload: unknown }[]): ModelUsagePayload | null {
  const usageEvent = events.filter((e) => e.type === EVENT_MODEL_USAGE).at(-1)
  if (usageEvent === undefined) return null
  const parsed = ModelUsagePayload.safeParse(usageEvent.payload)
  if (!parsed.success) {
    // 形状不对就当没测到用量：宁可成本报成未知，也不要拿半个数字算钱。
    console.warn(`[eval] model_usage 事件的 payload 不符合契约: ${parsed.error.message}`)
    return null
  }
  return parsed.data
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

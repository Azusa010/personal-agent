import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { buildPdf } from '../capabilities/pdf-fixtures'
import {
  MEMORY_DB,
  migrate,
  openProductState,
  type SqliteDatabase
} from '../product-state/database'
import { SqliteEventRepository } from '../product-state/event-repository'
import { SqliteTaskRepository } from '../product-state/task-repository'
import { ModelUsagePayload, collectObservation, type ObservationDeps } from './observation'
import { repoRoot } from './paths'
import { DOWNLOADS_ENV, LIVE_MODEL_ENV, SCRIPT_ENV } from './run-eval'

/**
 * 取证的验收（TASK-027）。
 *
 * 真内存库 + 真 PDF：这里断言的是"把哪条事实认成了什么"，不是 pdfjs 的行为
 * （那由 e2e 覆盖）。文件的最后一条用例是跨语言契约：model_usage 的字段名
 * 是 Python 写、TS 读，两边没有共享常量表，只能拉真 Python 读一遍钉住。
 */

const AT = '2026-09-15T09:00:00.000Z'
const TASK_ID = 'eval-case-task'
const TARGET = 'D:/eval/invoice.pdf'

const VENV_PYTHON = join(repoRoot(), 'services', 'agent-runtime', '.venv', 'Scripts', 'python.exe')
const RUNTIME_CWD = join(repoRoot(), 'services', 'agent-runtime')

let db: SqliteDatabase | null = null
let dir = ''

afterEach(() => {
  db?.close()
  db = null
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function openHarness(): { deps: ObservationDeps; events: SqliteEventRepository } {
  const store = openProductState(MEMORY_DB)
  db = store
  migrate(store)
  const tasks = new SqliteTaskRepository(store)
  const events = new SqliteEventRepository(store)
  return { deps: { tasks, events }, events }
}

function seedTask(deps: ObservationDeps, status: 'completed' | 'failed' = 'completed'): void {
  deps.tasks.insert({
    id: TASK_ID,
    goal: '总结这份 PDF',
    status: 'running',
    createdAt: AT,
    updatedAt: AT
  })
  if (status === 'failed') deps.tasks.updateStatus(TASK_ID, 'failed', AT)
  else deps.tasks.updateStatus(TASK_ID, 'completed', AT)
}

function makePdf(pages: string[]): string {
  dir = mkdtempSync(join(tmpdir(), 'pa-eval-obs-'))
  const path = join(dir, 'invoice.pdf')
  writeFileSync(path, buildPdf(pages))
  return path
}

describe('collectObservation：从库里取事实', () => {
  it('摘要取自 task_completed，工具调用与失败次数取自 tool_* 事件', async () => {
    const { deps, events } = openHarness()
    seedTask(deps)
    events.append({
      taskId: TASK_ID,
      type: 'tool_called',
      payload: {
        callId: 'call-1',
        capability: 'filesystem_list',
        arguments: { rootId: 'downloads' }
      },
      occurredAt: AT
    })
    events.append({
      taskId: TASK_ID,
      type: 'tool_result',
      payload: { callId: 'call-1', capability: 'filesystem_list', ok: true },
      occurredAt: AT
    })
    events.append({
      taskId: TASK_ID,
      type: 'tool_called',
      payload: {
        callId: 'call-2',
        capability: 'document_extract_pdf',
        arguments: { path: TARGET }
      },
      occurredAt: AT
    })
    events.append({
      taskId: TASK_ID,
      type: 'tool_result',
      payload: { callId: 'call-2', capability: 'document_extract_pdf', ok: false },
      occurredAt: AT
    })
    events.append({
      taskId: TASK_ID,
      type: 'task_completed',
      payload: { factCount: 1, facts: [{ text: '总额 4800', pageRefs: [1] }] },
      occurredAt: AT
    })
    events.append({
      taskId: TASK_ID,
      type: 'verification_passed',
      payload: { report: { ok: true }, evidence: null },
      occurredAt: AT
    })
    const pdfPath = makePdf(['total 4800 USD', 'due 2026-04-15'])

    const collected = await collectObservation(deps, {
      caseId: 'c-1',
      taskId: TASK_ID,
      targetPath: pdfPath
    })

    expect(collected.observation.status).toBe('completed')
    expect(collected.observation.facts).toEqual([{ text: '总额 4800', pageRefs: [1] }])
    expect(collected.observation.toolCalls.map((c) => c.capability)).toEqual([
      'filesystem_list',
      'document_extract_pdf'
    ])
    expect(collected.observation.extractedPaths).toEqual([TARGET])
    expect(collected.observation.failedToolCalls).toBe(1)
    expect(collected.observation.verificationOk).toBe(true)
    expect(collected.observation.budgetExhausted).toBe(false)
    // 页集合是重新读真实 PDF 得到的，不是抄回包的 factCount。
    expect(collected.observation.realPageNumbers).toEqual([1, 2])
    expect(collected.modelUsage).toBeNull()
  })

  it('任务没落库 → status unknown（跑挂在计划阶段的那种）', async () => {
    const { deps } = openHarness()

    const collected = await collectObservation(deps, {
      caseId: 'c-2',
      taskId: 'never-inserted',
      targetPath: makePdf(['x'])
    })

    expect(collected.observation.status).toBe('unknown')
    expect(collected.observation.facts).toEqual([])
  })

  it('目标 PDF 读不出来 → realPageNumbers 为 null（判定侧按 fail-closed 处理）', async () => {
    const { deps } = openHarness()
    seedTask(deps)

    const collected = await collectObservation(deps, {
      caseId: 'c-3',
      taskId: TASK_ID,
      targetPath: 'D:/eval/not-there.pdf'
    })

    expect(collected.observation.realPageNumbers).toBeNull()
  })

  it('verification_failed 事件 → verificationOk 为 false；两条都没跑到 → null', async () => {
    const { deps, events } = openHarness()
    seedTask(deps)
    events.append({
      taskId: TASK_ID,
      type: 'verification_failed',
      payload: { report: { ok: false, reason: '缺页码' }, evidence: null },
      occurredAt: AT
    })

    const failed = await collectObservation(deps, {
      caseId: 'c-4',
      taskId: TASK_ID,
      targetPath: makePdf(['x'])
    })
    expect(failed.observation.verificationOk).toBe(false)

    const { deps: deps2 } = openHarness()
    seedTask(deps2)
    const notRun = await collectObservation(deps2, {
      caseId: 'c-5',
      taskId: TASK_ID,
      targetPath: makePdf(['x'])
    })
    expect(notRun.observation.verificationOk).toBeNull()
  })

  it('budget_exhausted 事件与畸形摘要 payload 都不许让取证崩', async () => {
    const { deps, events } = openHarness()
    seedTask(deps)
    events.append({ taskId: TASK_ID, type: 'budget_exhausted', payload: {}, occurredAt: AT })
    events.append({
      taskId: TASK_ID,
      type: 'task_completed',
      payload: { facts: [{ text: '', pageRefs: ['一'] }] },
      occurredAt: AT
    })

    const collected = await collectObservation(deps, {
      caseId: 'c-6',
      taskId: TASK_ID,
      targetPath: makePdf(['x'])
    })

    expect(collected.observation.budgetExhausted).toBe(true)
    // 形状不对的 fact 一条都不认：宁可判成"没有事实"，也不要拿半条事实去算页码准确率。
    expect(collected.observation.facts).toEqual([])
  })

  it('model_usage 事件 → 提取用量；形状不对记 null', async () => {
    const { deps, events } = openHarness()
    seedTask(deps)
    events.append({
      taskId: TASK_ID,
      type: 'model_usage',
      payload: { model: 'gpt-test', inputTokens: 120, outputTokens: 40, calls: 3 },
      occurredAt: AT
    })

    const ok = await collectObservation(deps, {
      caseId: 'c-7',
      taskId: TASK_ID,
      targetPath: makePdf(['x'])
    })
    expect(ok.modelUsage).toEqual({
      model: 'gpt-test',
      inputTokens: 120,
      outputTokens: 40,
      calls: 3
    })

    const { deps: deps2, events: events2 } = openHarness()
    seedTask(deps2)
    events2.append({
      taskId: TASK_ID,
      type: 'model_usage',
      payload: { model: 'gpt-test', inputTokens: -1 },
      occurredAt: AT
    })
    const broken = await collectObservation(deps2, {
      caseId: 'c-8',
      taskId: TASK_ID,
      targetPath: makePdf(['x'])
    })
    // 宁可成本报成未知，也不要拿半个数字算钱。
    expect(broken.modelUsage).toBeNull()
  })
})

describe('model_usage payload 的 schema', () => {
  it('四个字段都必填、都为非负整数', () => {
    const good = { model: 'gpt-test', inputTokens: 0, outputTokens: 0, calls: 0 }
    expect(ModelUsagePayload.safeParse(good).success).toBe(true)
    expect(ModelUsagePayload.safeParse({ ...good, inputTokens: -1 }).success).toBe(false)
    expect(ModelUsagePayload.safeParse({ ...good, calls: 1.5 }).success).toBe(false)
    expect(ModelUsagePayload.safeParse({ model: 'gpt-test' }).success).toBe(false)
  })
})

describe.skipIf(!existsSync(VENV_PYTHON))('跨语言契约：与 Python 侧对齐', () => {
  it('Python 的 ModelUsage 能被 TS 的 ModelUsagePayload 解析，环境变量名也一致', () => {
    const probe = [
      'import json',
      'from personal_agent.model_gateway import ModelUsage',
      'from personal_agent.runtime import SCRIPT_ENV',
      'from personal_agent.live_model import LIVE_MODEL_ENV',
      'print(json.dumps({',
      '  "usage": json.loads(ModelUsage(model="gpt-test", inputTokens=12, outputTokens=3, calls=2).model_dump_json()),',
      '  "env": {"script": SCRIPT_ENV, "live": LIVE_MODEL_ENV}',
      '}))'
    ].join('\n')
    const out = execFileSync(VENV_PYTHON, ['-c', probe], {
      cwd: RUNTIME_CWD,
      encoding: 'utf8'
    })
    const probeResult = JSON.parse(out) as {
      usage: unknown
      env: { script: string; live: string }
    }

    // 字段名漂了不会报错，只会让成本统计静默变成 0 —— 所以在这儿钉死。
    const parsed = ModelUsagePayload.safeParse(probeResult.usage)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    expect(probeResult.env.script).toBe(SCRIPT_ENV)
    expect(probeResult.env.live).toBe(LIVE_MODEL_ENV)
    // downloads 根的变量名只在 TS 侧定义（roots.ts 的 ROOT_ENV）。
    expect(DOWNLOADS_ENV).toBe('PERSONAL_AGENT_DOWNLOADS_DIR')
  })
})

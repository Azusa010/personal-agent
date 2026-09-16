import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { executeHostTool, listVisibleCapabilities } from '../capabilities/host-executor'
import { ROOT_ENV } from '../capabilities/roots'
import { migrate, openProductState, type SqliteDatabase } from '../product-state/database'
import { SqliteEventRepository } from '../product-state/event-repository'
import { SqlitePermissionRepository } from '../product-state/permission-repository'
import { SqlitePlanRepository } from '../product-state/plan-repository'
import { SqliteReminderRepository } from '../product-state/reminder-repository'
import { SqliteTaskRepository } from '../product-state/task-repository'
import { SqliteToolExecutionRepository } from '../product-state/tool-execution-repository'
import { PythonSupervisor } from '../runtime/python-supervisor'
import { runTask, type RunTaskDeps } from '../tasks/run-task'
import { realVerificationPorts } from '../verification/ports'
import { verifyTaskCompletion } from '../verification/verify-task'
import type { EvalCase } from './case-manifest'
import { judgeCase, type CaseObservation } from './judge'
import { collectObservation } from './observation'
import type { EvalCaseResult, EvalPricing } from './metrics'
import { buildReport, type EvalReport } from './report'
import { materializeCase, type MaterializedCase } from './workspace'

/**
 * Live Eval 的编排。
 *
 * 一条 case = 一次完整的真实链路：真 spawn Python、真走 host.execute_tool 反向
 * RPC、真读生成的 PDF、真落 product-state 库、真过 TASK-026 的交付物闸口。
 * 唯一的差别在模型：scripted 模式用清单合出来的确定性剧本（CI 跑，CON-006），
 * live 模式用真模型（敞开跑，人手跑）。
 *
 * 每个 case 一个独立子进程与独立工作目录：一条 case 崩了不该污染下一条，
 * 而"重跑一次拿到的还是这个结果"是评测的基本要求。
 */

/** 与 runtime.py 的 SCRIPT_ENV / live_model.py 的 LIVE_MODEL_ENV 是同一批字面量。
 *  跨语言没有共享常量表，observation.test.ts 里用 python 真读一遍这两侧的值钉着。 */
export const SCRIPT_ENV = 'PERSONAL_AGENT_SCRIPT'
export const LIVE_MODEL_ENV = 'OPENAI_MODEL'
export const DOWNLOADS_ENV = ROOT_ENV['downloads'] ?? 'PERSONAL_AGENT_DOWNLOADS_DIR'

/** 目标 PDF 该被提取的那一步：与 Python planning.py 的三步计划前两步对齐 */
const LIST_CAPABILITY = 'filesystem.list'
const EXTRACT_CAPABILITY = 'document.extract_pdf'

export interface EvalRuntime {
  /** venv 里的 python.exe */
  command: string
  args: string[]
  cwd: string
}

export interface RunEvalOptions {
  mode: 'scripted' | 'live'
  cases: readonly EvalCase[]
  manifestPath: string
  /** 沙箱根：每个 case 一个子目录，库与剧本也落这里。由调用方决定留不留 */
  workDir: string
  runtime: EvalRuntime
  /** 单价，没配就是 null（报告里的 usd 也报 null） */
  pricing?: EvalPricing | null
  /** 每条 case 跑完的回调，用来打进度 */
  onCase?: (line: string) => void
}

export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const startedAt = new Date().toISOString()
  const dbPath = join(options.workDir, 'eval-product-state.db')
  const db = openProductState(dbPath)
  migrate(db)

  const results: EvalCaseResult[] = []
  const savedRoot = process.env[DOWNLOADS_ENV]
  try {
    for (const evalCase of options.cases) {
      const result = await runOneCase(db, evalCase, options)
      results.push(result)
      options.onCase?.(describeResult(result))
    }
  } finally {
    db.close()
    if (savedRoot === undefined) delete process.env[DOWNLOADS_ENV]
    else process.env[DOWNLOADS_ENV] = savedRoot
  }

  return buildReport({
    mode: options.mode,
    model: options.mode === 'live' ? (process.env[LIVE_MODEL_ENV] ?? null) : null,
    manifestPath: options.manifestPath,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
    pricing: options.pricing ?? null
  })
}

/** 一次跑完的临时沙箱：调用方用完删掉即可 */
export function makeEvalWorkDir(prefix = 'pa-eval-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function removeEvalWorkDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

async function runOneCase(
  db: SqliteDatabase,
  evalCase: EvalCase,
  options: RunEvalOptions
): Promise<EvalCaseResult> {
  // 收集失败也要出结果：crash 掉的那条记成不通过（reasons 里带原因），
  // 不是从报告里消失——报告少一条比报告里有一条失败更难发现。
  const materialized = materializeCase(join(options.workDir, evalCase.id), evalCase)
  const scriptPath =
    options.mode === 'scripted'
      ? writeScriptedDecisions(options.workDir, evalCase, materialized)
      : null
  const taskId = `${evalCase.id}-task`
  let observation = emptyObservation(evalCase.id)
  let modelUsage: EvalCaseResult['modelUsage'] = null
  let runError: string | null = null
  let latencyMs = 0

  const savedRoot = process.env[DOWNLOADS_ENV]
  process.env[DOWNLOADS_ENV] = materialized.dir
  const supervisor = new PythonSupervisor({
    command: options.runtime.command,
    args: options.runtime.args,
    cwd: options.runtime.cwd,
    env: childEnv(options.mode, scriptPath),
    capabilities: listVisibleCapabilities(),
    hostHandler: executeHostTool
  })
  try {
    supervisor.start()
    await supervisor.initialize()
    const ids = [taskId, `${evalCase.id}-plan`]
    // 只量任务本身：进程启动与工作区物化是每条 case 都一样的常量开销，
    // 计进去会淹没 scripted 模式的读数（那边一条只有几十毫秒）。
    const started = performance.now()
    const result = await runTask(evalCase.goal, makeDeps(db, supervisor, ids))
    latencyMs = Math.round((performance.now() - started) * 10) / 10
    const collected = await collectObservation(
      { tasks: new SqliteTaskRepository(db), events: new SqliteEventRepository(db) },
      {
        caseId: evalCase.id,
        taskId: result.ok ? result.taskId : taskId,
        targetPath: materialized.targetPath
      }
    )
    observation = collected.observation
    modelUsage = collected.modelUsage
  } catch (e) {
    runError = e instanceof Error ? e.message : String(e)
  } finally {
    await supervisor.stop().catch(() => {})
    if (savedRoot === undefined) delete process.env[DOWNLOADS_ENV]
    else process.env[DOWNLOADS_ENV] = savedRoot
  }

  const verdict = judgeCase(evalCase, observation)
  if (runError !== null) verdict.reasons = [...verdict.reasons, `运行失败: ${runError}`]

  return {
    id: evalCase.id,
    goal: evalCase.goal,
    status: observation.status,
    latencyMs,
    verdict,
    toolCalls: observation.toolCalls.map((call) => call.capability),
    failedToolCalls: observation.failedToolCalls,
    budgetExhausted: observation.budgetExhausted,
    verificationOk: observation.verificationOk,
    modelUsage
  }
}

function makeDeps(db: SqliteDatabase, supervisor: PythonSupervisor, ids: string[]): RunTaskDeps {
  const tasks = new SqliteTaskRepository(db)
  const plans = new SqlitePlanRepository(db)
  const events = new SqliteEventRepository(db)
  const queue = [...ids]
  return {
    db,
    tasks,
    plans,
    events,
    send: (method, params, opts) => supervisor.request(method, params, opts),
    // 真判定器 + 真端口，与 Golden Path E2E 同一套：评测跑的就是生产的那条闸口。
    verify: (input) =>
      verifyTaskCompletion(
        {
          tasks,
          plans,
          events,
          permissions: new SqlitePermissionRepository(db),
          executions: new SqliteToolExecutionRepository(db),
          reminders: new SqliteReminderRepository(db),
          ...realVerificationPorts
        },
        input
      ),
    // 可读的 id：报告与库里的行对得上，排查时少一步翻译。
    // runTask 先要 taskId 再要 planId，队列按这个顺序发。
    newId: () => queue.shift() ?? `${ids[0]}-extra`
  }
}

/**
 * scripted 模式的剧本：从清单合出来，不是另写一份。
 *
 * 三步与 planning.py 的固定计划逐步对应（list → extract → summary），
 * 摘要的 fact 正文与页码直接取自 keyPoints —— 于是"清单里写了什么要总结"
 * 与"剧本演出来的摘要"是同一份事实，不会各自漂移。
 */
export function writeScriptedDecisions(
  workDir: string,
  evalCase: EvalCase,
  materialized: MaterializedCase
): string {
  const decisions = [
    {
      kind: 'tool_call',
      callId: 'call-1',
      capability: LIST_CAPABILITY,
      arguments: { rootId: 'downloads' }
    },
    {
      kind: 'tool_call',
      callId: 'call-2',
      capability: EXTRACT_CAPABILITY,
      arguments: { path: materialized.targetPath }
    },
    {
      kind: 'summary',
      facts: evalCase.keyPoints.map((keyPoint) => ({
        text: keyPoint.text,
        pageRefs: keyPoint.pages
      }))
    }
  ]
  const path = join(workDir, `${evalCase.id}.script.json`)
  writeFileSync(path, `${JSON.stringify(decisions, null, 2)}\n`, 'utf8')
  return path
}

/**
 * 子进程的环境变量。
 *
 * scripted 模式把真模型那套配置从子进程里摘掉：父 shell 里留着的 OPENAI_MODEL
 * 会让 runtime 选中 LiveModel（优先级在那边），那样"确定性"就没了。
 */
function childEnv(mode: 'scripted' | 'live', scriptPath: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (mode === 'scripted' && scriptPath !== null) {
    env[SCRIPT_ENV] = scriptPath
    delete env[LIVE_MODEL_ENV]
    delete env['OPENAI_API_KEY']
  }
  return env
}

function emptyObservation(caseId: string): CaseObservation {
  return {
    caseId,
    taskId: '',
    status: 'unknown',
    facts: [],
    realPageNumbers: null,
    toolCalls: [],
    extractedPaths: [],
    budgetExhausted: false,
    verificationOk: null,
    failedToolCalls: 0
  }
}

function describeResult(result: EvalCaseResult): string {
  const mark = result.verdict.fullSuccess ? 'PASS' : 'FAIL'
  const reason = result.verdict.reasons[0] ?? ''
  return `[${mark}] ${result.id} ${result.status} ${result.latencyMs}ms ${reason}`.trim()
}

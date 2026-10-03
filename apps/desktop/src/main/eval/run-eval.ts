import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  configureHostExecutor,
  executeHostTool,
  listReadOnlyCapabilities,
  listVisibleCapabilities
} from '../capabilities/host-executor'
import { ROOT_ENV } from '../capabilities/roots'
import { migrate, openProductState, type SqliteDatabase } from '../product-state/database'
import { SqliteEventRepository } from '../product-state/event-repository'
import { SqlitePermissionRepository } from '../product-state/permission-repository'
import { SqlitePlanRepository } from '../product-state/plan-repository'
import { SqliteReminderRepository } from '../product-state/reminder-repository'
import { SqliteTaskRepository } from '../product-state/task-repository'
import { SqliteToolExecutionRepository } from '../product-state/tool-execution-repository'
import { createPermissionBroker, type PermissionBroker } from '../permission/permission-broker'
import type { CapabilityDescriptor } from '@personal-agent/protocol'
import { PythonSupervisor } from '../runtime/python-supervisor'
import { runTask, type RunTaskDeps } from '../tasks/run-task'
import { realVerificationPorts } from '../verification/ports'
import { verifyTaskCompletion } from '../verification/verify-task'
import { targetPdf, type EvalCase } from './case-manifest'
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
const LIST_CAPABILITY = 'filesystem_list'
const EXTRACT_CAPABILITY = 'document_extract_pdf'

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
  /**
   * 每条 case 聚合完成后的回调（带**当前全部**结果）。调用方用来落部分报告：
   * live 一场跑几十分钟，被中断时不该颗粒无收。
   */
  onCaseResult?: (results: readonly EvalCaseResult[]) => void
  /**
   * 每条 case 重复跑几次。runs>1 时报告的 fullSuccess 是 pass^k 口径（每次都过
   * 才算过），passAtK 是「至少一次过」。默认 1；真模型选型建议 3。
   */
  runs?: number
  /** 失败 case 的轨迹落盘目录（文件名 trace-<case>-r<run>.json）。不给就不落 */
  traceDir?: string | null
}

export async function runEval(options: RunEvalOptions): Promise<EvalReport> {
  const startedAt = new Date().toISOString()
  const dbPath = join(options.workDir, 'eval-product-state.db')
  const db = openProductState(dbPath)
  migrate(db)
  const broker = wireWritePath(db)

  const results: EvalCaseResult[] = []
  const runs = Math.max(1, options.runs ?? 1)
  const savedRoot = process.env[DOWNLOADS_ENV]
  try {
    for (const evalCase of options.cases) {
      const attempts: EvalCaseResult[] = []
      for (let run = 1; run <= runs; run += 1) {
        const attempt = await runOneCase(db, evalCase, options, run)
        attempts.push(attempt)
        options.onCase?.(describeResult(attempt))
        if (options.traceDir && !attempt.verdict.fullSuccess) {
          writeTrace(options.traceDir, evalCase, attempt, run)
        }
      }
      results.push(aggregateRuns(attempts))
      options.onCaseResult?.(results)
    }
  } finally {
    db.close()
    broker.dispose()
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

/**
 * WRITE 能力的批准、幂等与 Reminder 接线。eval 的「用户」是 fixture：权限一挂起
 * 就自动批准（与 golden-path E2E 的假用户同一手法）。只读 case 的 risk 是 NONE，
 * 走不到这一层，所以统一接上对读链路没有副作用。
 */
function wireWritePath(db: SqliteDatabase): PermissionBroker {
  const permissions = new SqlitePermissionRepository(db)
  const events = new SqliteEventRepository(db)
  const broker = createPermissionBroker({
    permissions,
    events,
    notify: (notice) => {
      if (notice.kind !== 'requested') return
      // broker 是「先 notify 再登记挂起项」，同步 respond 会撞上「批准窗口已关闭」
      // （golden-path 的同款注释：真实用户也是过一会儿才点）。
      queueMicrotask(() => {
        broker.respond(notice.permission.id, 'approved')
      })
    }
  })
  configureHostExecutor({
    permission: { gate: broker, tasks: new SqliteTaskRepository(db) },
    idempotency: { executions: new SqliteToolExecutionRepository(db) },
    scheduler: {
      db,
      reminders: new SqliteReminderRepository(db),
      events
    }
  })
  return broker
}

/** runs>1 时的口径聚合：verdict 取第一次失败的跑（reasons 说清败在哪一次），
 *  全过才 fullSuccess（pass^k），passAtK 是「至少一次过」（pass@k）。 */
function aggregateRuns(attempts: EvalCaseResult[]): EvalCaseResult {
  const first = attempts[0]
  if (attempts.length === 1) {
    return {
      ...first,
      runs: 1,
      runResults: [first.verdict.fullSuccess],
      passAtK: first.verdict.fullSuccess
    }
  }
  const firstFail = attempts.find((a) => !a.verdict.fullSuccess) ?? attempts[attempts.length - 1]
  return {
    ...firstFail,
    runs: attempts.length,
    runResults: attempts.map((a) => a.verdict.fullSuccess),
    passAtK: attempts.some((a) => a.verdict.fullSuccess)
  }
}

/** 失败 case 的轨迹：判定明细 + 观察快照，回看「败在哪一步」不用重跑。 */
function writeTrace(
  traceDir: string,
  evalCase: EvalCase,
  result: EvalCaseResult,
  run: number
): void {
  const path = join(traceDir, `trace-${evalCase.id}-r${run}.json`)
  mkdirSync(traceDir, { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({ caseId: evalCase.id, run, goal: evalCase.goal, result }, null, 2)}\n`,
    'utf8'
  )
}

/** 一次跑完的临时沙箱：调用方用完删掉即可 */
export function makeEvalWorkDir(prefix = 'pa-eval-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function removeEvalWorkDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** 第 run 次跑的工作区子目录。第 1 次保持原名（报告与工作区对得上），后续加后缀 */
function caseWorkDir(caseId: string, run: number): string {
  return run === 1 ? caseId : `${caseId}-r${run}`
}

const STATEFUL_WRITE_CAPABILITIES = ['filesystem_create_dir', 'filesystem_move', 'scheduler_create']

/** stderr 末尾几行（去空行，截 2000 字符）：失败 case 的死因通常就在最后几行 */
function stderrTail(chunks: readonly string[]): string {
  const lines = chunks
    .join('')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  const tail = lines.slice(-15).join(' ⏎ ')
  return tail.length > 2000 ? `${tail.slice(0, 2000)}…` : tail
}

/** 页集合取证用的目标 PDF 路径：写链路按期望终态（已移进 stateful.dir），读链路原位 */
function expectedTargetPath(evalCase: EvalCase, materialized: MaterializedCase): string {
  if (evalCase.type === 'stateful_ops' && evalCase.stateful !== undefined) {
    return `${materialized.dir}/${evalCase.stateful.dir}/${targetPdf(evalCase).name}`
  }
  return materialized.targetPath
}

/** 握手下发的能力清单，按维度分派。描述符全部取自 registry，不手写 */
function capabilitiesFor(evalCase: EvalCase): readonly CapabilityDescriptor[] {
  if (evalCase.type !== 'stateful_ops') return listReadOnlyCapabilities()
  const writes = listVisibleCapabilities().filter((c) =>
    STATEFUL_WRITE_CAPABILITIES.includes(c.name)
  )
  return [...listReadOnlyCapabilities(), ...writes]
}

async function runOneCase(
  db: SqliteDatabase,
  evalCase: EvalCase,
  options: RunEvalOptions,
  run: number
): Promise<EvalCaseResult> {
  // 收集失败也要出结果：crash 掉的那条记成不通过（reasons 里带原因），
  // 不是从报告里消失——报告少一条比报告里有一条失败更难发现。
  const materialized = materializeCase(
    join(options.workDir, caseWorkDir(evalCase.id, run)),
    evalCase
  )
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
    // 按维度分派：读链路只给 READ 清单（计划三步）；写链路加上 planning.py
    // WRITE_STEPS 认识的三个 WRITE（计划变六步，闸口自动开始要求移动与 Reminder
    // ——交付物判定按计划推导，三处口径由架构对齐）。不 给全量 agent 清单：
    // terminal/code-interpreter 与评测任务无关，暴露给 live 模型只会添计划外噪声。
    capabilities: capabilitiesFor(evalCase),
    hostHandler: executeHostTool
  })
  const stderrChunks: string[] = []
  const onStderr = (chunk: string): void => {
    stderrChunks.push(chunk)
    // live 模式人眼在盯：stderr 现场流出，case 卡住时能看到 Python 的最后一句
    // （CI 的 scripted 模式不刷屏，stderr 只进失败 case 的 reasons）。
    if (options.mode === 'live') {
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim()
        if (trimmed !== '') console.log(`[py] ${trimmed}`)
      }
    }
  }
  supervisor.on('stderr', onStderr)
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
        // 写链路按期望终态取证：目标 PDF 已被（期望）移进 Reading/，还在物化时的
        // 老路径重读页集合会读不到，fail-closed 会把成功的 run 误判成读不出来。
        targetPath: expectedTargetPath(evalCase, materialized),
        // 写链路要终态文件清单当证据；读链路工作区不动，不采
        rootDir: evalCase.type === 'stateful_ops' ? materialized.dir : null
      }
    )
    observation = collected.observation
    modelUsage = collected.modelUsage
  } catch (e) {
    runError = e instanceof Error ? e.message : String(e)
  } finally {
    supervisor.off('stderr', onStderr)
    await supervisor.stop().catch(() => {})
    if (savedRoot === undefined) delete process.env[DOWNLOADS_ENV]
    else process.env[DOWNLOADS_ENV] = savedRoot
  }

  const verdict = judgeCase(evalCase, observation)
  if (runError !== null) verdict.reasons = [...verdict.reasons, `运行失败: ${runError}`]
  // 失败 case 带上两类现场：闸口为什么拒（报告里的 report.reason）与 Python 的
  // 临终遗言（stderr 末尾）。报告与 trace 都读 reasons，死因不用重跑就能看见。
  if (!verdict.fullSuccess) {
    if (observation.verificationReason !== null) {
      verdict.reasons = [...verdict.reasons, `闸口拒绝: ${observation.verificationReason}`]
    }
    const tail = stderrTail(stderrChunks)
    if (tail !== '') verdict.reasons = [...verdict.reasons, `Python stderr 末尾: ${tail}`]
  }

  return {
    id: evalCase.id,
    goal: evalCase.goal,
    type: evalCase.type,
    status: observation.status,
    latencyMs,
    verdict,
    toolCalls: observation.toolCalls.map((call) => call.capability),
    failedToolCalls: observation.failedToolCalls,
    budgetExhausted: observation.budgetExhausted,
    verificationOk: observation.verificationOk,
    modelUsage,
    // 单次跑的口径；runs>1 时由 aggregateRuns 覆盖成 pass^k / pass@k 聚合
    runs: 1,
    runResults: [verdict.fullSuccess],
    passAtK: verdict.fullSuccess
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
  const decisions: Array<Record<string, unknown>> = [
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
    }
  ]

  // 写链路：三个 WRITE 按 planning.py WRITE_STEPS 的顺序插在 extract 之后、摘要
  // 之前（ActionAlignment 严格模式下第 i 次调用必须等于第 i 个带 capability 的
  // 计划步骤，顺序错一步就被拒）。remindAt 取运行时刻 +1 小时：binder 拒收过去
  // 的时间，而剧本是每次跑现场合成的，不需要跨运行可比。
  if (evalCase.type === 'stateful_ops' && evalCase.stateful !== undefined) {
    const { dir, reminderMessage } = evalCase.stateful
    const targetName = targetPdf(evalCase).name
    decisions.push(
      {
        kind: 'tool_call',
        callId: 'call-3',
        capability: 'filesystem_create_dir',
        arguments: { path: `${materialized.dir}/${dir}` }
      },
      {
        kind: 'tool_call',
        callId: 'call-4',
        capability: 'filesystem_move',
        arguments: {
          source: materialized.targetPath,
          target: `${materialized.dir}/${dir}/${targetName}`
        }
      },
      {
        kind: 'tool_call',
        callId: 'call-5',
        capability: 'scheduler_create',
        arguments: {
          remindAt: new Date(Date.now() + 3_600_000).toISOString(),
          message: reminderMessage
        }
      }
    )
  }

  decisions.push({
    kind: 'summary',
    // reply 是 TASK-031 起的必填字段：eval 的判定只读 facts，reply 只是让
    // 剧本与真模型的输出形状一致（缺了它 Python 侧的契约校验会拒）。
    reply: `已根据 ${materialized.targetPath} 的页面内容给出带页码引用的摘要`,
    facts: evalCase.keyPoints.map((keyPoint) => ({
      text: keyPoint.text,
      pageRefs: keyPoint.pages
    }))
  })

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
    verificationReason: null,
    failedToolCalls: 0,
    finalFiles: null
  }
}

function describeResult(result: EvalCaseResult): string {
  const mark = result.verdict.fullSuccess ? 'PASS' : 'FAIL'
  const reason = result.verdict.reasons[0] ?? ''
  return `[${mark}] ${result.id} ${result.status} ${result.latencyMs}ms ${reason}`.trim()
}

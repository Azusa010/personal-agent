import { failures, infrastructureFailure, type Check } from './html-judge'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { Turn } from '@personal-agent/protocol'
import {
  configureHostExecutor,
  executeHostTool,
  listVisibleCapabilities,
  resetHostExecutorWiring
} from '../../../src/main/capabilities/host-executor'
import { ROOT_ENV } from '../../../src/main/capabilities/roots'
import { createPermissionBroker } from '../../../src/main/permission/permission-broker'
import { migrate, openProductState } from '../../../src/main/product-state/database'
import { SqliteConversationRepository } from '../../../src/main/product-state/conversation-repository'
import { SqliteMessageRepository } from '../../../src/main/product-state/message-repository'
import { SqliteEventRepository } from '../../../src/main/product-state/event-repository'
import { SqlitePermissionRepository } from '../../../src/main/product-state/permission-repository'
import { SqlitePlanRepository } from '../../../src/main/product-state/plan-repository'
import { SqliteReminderRepository } from '../../../src/main/product-state/reminder-repository'
import { SqliteTaskRepository } from '../../../src/main/product-state/task-repository'
import { SqliteToolExecutionRepository } from '../../../src/main/product-state/tool-execution-repository'
import { PythonSupervisor } from '../../../src/main/runtime/python-supervisor'
import { buildHistory } from '../../../src/main/tasks/history'
import { sendMessage } from '../../../src/main/tasks/send-message'
import { runTask } from '../../../src/main/tasks/run-task'
import { realVerificationPorts } from '../../../src/main/verification/ports'
import { verifyTaskCompletion } from '../../../src/main/verification/verify-task'
import { repoRoot } from '../../../src/main/eval/paths'

interface Scenario {
  id: string
  goal: string
  file: string
  inputFile?: { name: string; content: string }
}
const root = repoRoot()
const manifest = JSON.parse(
  readFileSync(join(root, 'tests/evals/html-interaction-cases.json'), 'utf8')
) as { cases: Scenario[]; runsPerCase: number; maxRepairs: number }
const electron = join(root, 'node_modules/electron/dist/electron.exe')
const checker = join(root, 'tests/evals/html-page-check.cjs')
const python = join(root, 'services/agent-runtime/.venv/Scripts/python.exe')
const exec = promisify(execFile)

async function checkPage(file: string, id: string, screenshot: string): Promise<Check> {
  if (!existsSync(file)) return { error: '未生成 HTML 文件' }
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const resultPath = `${screenshot}.json`
    await exec(electron, [checker, file, id, screenshot, resultPath], {
      env,
      timeout: 20000,
      maxBuffer: 1024 * 1024
    })
    return JSON.parse(readFileSync(resultPath, 'utf8')) as Check
  } catch (error) {
    return { error: `检查进程失败或超时: ${String(error)}` }
  }
}

describe.skipIf(process.env.HTML_EVAL_LIVE !== '1')('HTML generation live evaluation', () => {
  it(
    'records all 15 independent attempts and at most one repair',
    async () => {
      expect(manifest.cases).toHaveLength(3)
      expect(manifest.runsPerCase).toBe(5)
      expect(manifest.maxRepairs).toBe(1)
      const reportDir = join(
        root,
        'tests/evals/reports',
        `html-${new Date().toISOString().replace(/[:.]/g, '-')}`
      )
      mkdirSync(reportDir, { recursive: true })
      const results: unknown[] = []
      let interrupted = false
      const savedWorkspace = process.env[ROOT_ENV.workspace]
      try {
        const smoke = process.env.HTML_EVAL_SMOKE === '1'
        const only = new Set(
          (process.env.HTML_EVAL_ONLY ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        )
        const allowedRuns = new Set(
          manifest.cases.flatMap((c) =>
            Array.from({ length: manifest.runsPerCase }, (_, i) => `${c.id}:${i + 1}`)
          )
        )
        for (const key of only)
          if (!allowedRuns.has(key)) throw new Error(`Unknown evaluation run: ${key}`)
        if (smoke && only.size) throw new Error('Smoke mode and selective runs cannot be combined')
        cases: for (const scenario of smoke ? manifest.cases.slice(0, 1) : manifest.cases)
          for (let n = 1; n <= (smoke ? 1 : manifest.runsPerCase); n++) {
            if (only.size && !only.has(`${scenario.id}:${n}`)) continue
            const dir = join(reportDir, `${scenario.id}-${n}`)
            mkdirSync(dir, { recursive: true })
            if (scenario.inputFile)
              writeFileSync(join(dir, scenario.inputFile.name), scenario.inputFile.content)
            process.env[ROOT_ENV.workspace] = dir
            const db = openProductState(join(dir, 'state.db'))
            migrate(db)
            const tasks = new SqliteTaskRepository(db),
              plans = new SqlitePlanRepository(db),
              events = new SqliteEventRepository(db)
            const permissions = new SqlitePermissionRepository(db),
              executions = new SqliteToolExecutionRepository(db)
            const reminders = new SqliteReminderRepository(db)
            const target = resolve(dir, scenario.file).toLowerCase()
            const broker = createPermissionBroker({
              permissions,
              events,
              notify: (notice) => {
                if (notice.kind !== 'requested') return
                const p = notice.permission
                const allowed =
                  ['file_write', 'file_edit'].includes(p.capability) &&
                  p.targetPath !== null &&
                  resolve(p.targetPath).toLowerCase() === target
                queueMicrotask(() => broker.respond(p.id, allowed ? 'approved' : 'denied'))
              }
            })
            configureHostExecutor({
              permission: { gate: broker, tasks },
              idempotency: { executions },
              scheduler: { db, reminders, events }
            })
            const caps = listVisibleCapabilities().filter((c) =>
              ['file_read', 'file_write', 'file_edit'].includes(c.name)
            )
            const toolCalls: { capability: string; ok: boolean }[] = []
            const supervisor = new PythonSupervisor({
              command: python,
              args: ['-m', 'personal_agent'],
              cwd: join(root, 'services/agent-runtime'),
              env: { ...process.env },
              capabilities: caps,
              hostHandler: async (params) => {
                if (params.capability === 'file_read') {
                  const rawPath = params.arguments.path
                  const allowed = [
                    target,
                    ...(scenario.inputFile
                      ? [resolve(dir, scenario.inputFile.name).toLowerCase()]
                      : [])
                  ]
                  if (
                    typeof rawPath !== 'string' ||
                    !allowed.includes(resolve(dir, rawPath).toLowerCase())
                  ) {
                    return {
                      ok: false,
                      code: 'EVAL_PATH_DENIED',
                      reason: 'Only evaluation files may be read'
                    }
                  }
                }
                const result = await executeHostTool(params)
                toolCalls.push({ capability: params.capability, ok: result.ok === true })
                return result
              }
            })
            const stderr: string[] = []
            supervisor.on('stderr', (chunk: string) => stderr.push(chunk))
            const conversations = new SqliteConversationRepository(db),
              messages = new SqliteMessageRepository(db)
            const deps = {
              conversations,
              messages,
              buildHistory,
              runTask: (goal: unknown, history: Turn[]) =>
                runTask(
                  goal,
                  {
                    db,
                    tasks,
                    plans,
                    events,
                    send: (method, params, opts) =>
                      supervisor.request(method, params, {
                        ...opts,
                        timeoutMs: opts?.timeoutMs ?? 180_000
                      }),
                    verify: (input) =>
                      verifyTaskCompletion(
                        {
                          tasks,
                          plans,
                          events,
                          permissions,
                          executions,
                          reminders,
                          ...realVerificationPorts
                        },
                        input
                      )
                  },
                  history
                )
            }
            const started = Date.now()
            let first: unknown = null,
              repair: unknown = null,
              initialErrors: string[] = [],
              finalErrors: string[] = [],
              runError: string | null = null,
              firstElapsedMs: number | null = null,
              infrastructureError = false,
              firstInfrastructureError = false
            try {
              supervisor.start()
              await supervisor.initialize()
              const response = await sendMessage(
                {
                  conversationId: null,
                  text: `${scenario.goal}\n请使用 file_write 写入工作区内的文件，工作区路径为 ${dir}。`
                },
                deps
              )
              first = response
              infrastructureError = infrastructureFailure(response)
              firstInfrastructureError = infrastructureError
              const file = join(dir, scenario.file)
              if (existsSync(file)) copyFileSync(file, join(dir, 'first.html'))
              const check = await checkPage(file, scenario.id, join(dir, 'first.png'))
              initialErrors = failures(scenario.id, check)
              if (!response.ok || response.status !== 'completed')
                initialErrors.push('Agent 任务未成功完成')
              if (!toolCalls.some((call) => call.capability === 'file_write' && call.ok))
                initialErrors.push('未成功调用 file_write')
              firstElapsedMs = Date.now() - started
              finalErrors = initialErrors
              writeFileSync(join(dir, 'first-check.json'), JSON.stringify(check, null, 2))
              if (initialErrors.length && response.conversationId && !infrastructureError) {
                const repairResponse = await sendMessage(
                  {
                    conversationId: response.conversationId,
                    text: `页面检查发现：${initialErrors.join('；')}。请修复 ${file} 并保留原有功能；若文件不存在，请使用 file_write 创建，否则使用 file_edit 修改。`
                  },
                  deps
                )
                repair = repairResponse
                infrastructureError = infrastructureFailure(repairResponse)
                const second = await checkPage(file, scenario.id, join(dir, 'repair.png'))
                finalErrors = failures(scenario.id, second)
                if (!repairResponse.ok || repairResponse.status !== 'completed')
                  finalErrors.push('修复任务未成功完成')
                writeFileSync(join(dir, 'repair-check.json'), JSON.stringify(second, null, 2))
                if (existsSync(file)) copyFileSync(file, join(dir, 'repair.html'))
              }
            } catch (error) {
              runError = String(error)
              initialErrors.push(runError)
              finalErrors = initialErrors
            } finally {
              await supervisor.stop().catch(() => {})
              broker.dispose()
              resetHostExecutorWiring()
              db.close()
            }
            const result = {
              scenario: scenario.id,
              run: n,
              firstElapsedMs,
              elapsedMs: Date.now() - started,
              firstSuccess: firstInfrastructureError ? null : initialErrors.length === 0,
              repairedSuccess: infrastructureError ? null : finalErrors.length === 0,
              repairCount: repair ? 1 : 0,
              firstErrors: initialErrors,
              finalErrors,
              toolCalls,
              first,
              repair,
              runError,
              infrastructureError
            }
            results.push(result)
            writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2))
            writeFileSync(join(dir, 'runtime.log'), stderr.join('').slice(-10000))
            writeFileSync(join(reportDir, 'partial.json'), JSON.stringify(results, null, 2))
            console.log(
              `${scenario.id} ${n}/5 first=${result.firstSuccess} repaired=${result.repairedSuccess}`
            )
            if (infrastructureError) {
              interrupted = true
              break cases
            }
          }
      } finally {
        if (savedWorkspace === undefined) delete process.env[ROOT_ENV.workspace]
        else process.env[ROOT_ENV.workspace] = savedWorkspace
      }
      writeFileSync(
        join(reportDir, 'report.json'),
        JSON.stringify({ model: process.env.OPENAI_MODEL, interrupted, results }, null, 2)
      )
      console.log(`HTML evaluation report: ${reportDir}`)
      if (interrupted)
        throw new Error(
          'Provider request failed; evaluation stopped without counting the interrupted sample'
        )
      const requested = (process.env.HTML_EVAL_ONLY ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      expect(results).toHaveLength(
        requested.length ? new Set(requested).size : process.env.HTML_EVAL_SMOKE === '1' ? 1 : 15
      )
    },
    4 * 60 * 60 * 1000
  )
})

/**
 * 会话 E2E（TASK-032）：两轮对话在同一个会话里完成。
 *
 * 真 spawn venv 的 `python -m personal_agent`（剧本模式）、真库、真闸口。
 * 验证「多轮」本身的三件事：
 *   1. 两轮回包共享同一个 conversationId，各自的 assistant 消息挂上各自的任务；
 *   2. 第二轮 run_task 的入参真的带着第一轮的对话历史——历史流到 Python 的
 *      活证据（单元测试里 planner/引擎收到的是替身递的，这里走真链路）；
 *   3. 消息按轮落库、顺序稳定，getConversation 的投影（assistant 内嵌 timeline）可用。
 *
 * 用只读能力握手（两个 READ → 确定性计划是三步 list→extract→summary），
 * 剧本按同一顺序回放两轮。不用完整 Golden Path 的理由：写操作在第二轮会因
 * 「文件已移动 / Reminder 已存在」翻车，那是幂等与闸口的职责（golden-path 与
 * failure-regression 已覆盖），本测试聚焦对话层。
 *
 * 注：tasks.conversation_id 列当前不写——任务与会话的关联以 messages.task_id
 * 为准（getConversation 即按它投影），该列留给诊断类查询。
 *
 * venv 不在就整块跳过，与 golden-path 同一条规矩。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Turn } from '@personal-agent/protocol'

import { executeHostTool, listReadOnlyCapabilities } from '../capabilities/host-executor'
import { ROOT_ENV, toPosix } from '../capabilities/roots'
import { migrate, openProductState, type SqliteDatabase } from '../product-state/database'
import { SqliteConversationRepository } from '../product-state/conversation-repository'
import { SqliteEventRepository } from '../product-state/event-repository'
import { SqliteMessageRepository } from '../product-state/message-repository'
import { SqlitePermissionRepository } from '../product-state/permission-repository'
import { SqlitePlanRepository } from '../product-state/plan-repository'
import { SqliteReminderRepository } from '../product-state/reminder-repository'
import { SqliteTaskRepository } from '../product-state/task-repository'
import { SqliteToolExecutionRepository } from '../product-state/tool-execution-repository'
import { PythonSupervisor } from '../runtime/python-supervisor'
import { getConversation } from '../tasks/get-conversation'
import { sendMessage } from '../tasks/send-message'
import { buildHistory } from '../tasks/history'
import { runTask, type RunTaskDeps } from '../tasks/run-task'
import { realVerificationPorts } from '../verification/ports'
import { verifyTaskCompletion } from '../verification/verify-task'
import { repoRoot } from '../eval/paths'

const ROOT = repoRoot()
const VENV_PYTHON = join(ROOT, 'services', 'agent-runtime', '.venv', 'Scripts', 'python.exe')
const RUNTIME_CWD = join(ROOT, 'services', 'agent-runtime')
const FIXTURE_PDF = join(ROOT, 'tests', 'fixtures', 'pdfs', 'three-page-text.pdf')
const PDF_NAME = 'three-page-text.pdf'
const SCRIPT_ENV = 'PERSONAL_AGENT_SCRIPT'
const DOWNLOADS_ENV = ROOT_ENV['downloads'] ?? 'PERSONAL_AGENT_DOWNLOADS_DIR'

const QUESTION_1 = '第一问：把这份 PDF 摘要一下'
const QUESTION_2 = '第二问：再摘要一遍'
const REPLY_1 = '第一轮完成：第一页正文是 PersonalAgent fixture page one。'

let tempDir = ''
let downloadsRoot = ''
let db: SqliteDatabase | null = null
let supervisor: PythonSupervisor | null = null
let savedDownloadsEnv: string | undefined

interface RpcCall {
  method: string
  params: unknown
}
const rpcLog: RpcCall[] = []

function repos(store: SqliteDatabase): {
  conversations: SqliteConversationRepository
  messages: SqliteMessageRepository
  tasks: SqliteTaskRepository
  plans: SqlitePlanRepository
  events: SqliteEventRepository
  permissions: SqlitePermissionRepository
  executions: SqliteToolExecutionRepository
  reminders: SqliteReminderRepository
} {
  return {
    conversations: new SqliteConversationRepository(store),
    messages: new SqliteMessageRepository(store),
    tasks: new SqliteTaskRepository(store),
    plans: new SqlitePlanRepository(store),
    events: new SqliteEventRepository(store),
    permissions: new SqlitePermissionRepository(store),
    executions: new SqliteToolExecutionRepository(store),
    reminders: new SqliteReminderRepository(store)
  }
}

/** 只读一轮的剧本：list → extract → summary。ScriptedModel 每个任务领一个
 *  新实例（游标归零），第二轮会重放同一份剧本——两轮的差别体现在 history
 *  入参与各自的任务行上，不在回复文本（确定性模式如此，REQ-010 的设计）。 */
function buildScript(downloadsRootPath: string): string {
  const list = {
    kind: 'tool_call',
    callId: 'c-1',
    capability: 'filesystem.list',
    arguments: { rootId: 'downloads' }
  }
  const extract = {
    kind: 'tool_call',
    callId: 'c-2',
    capability: 'document.extract_pdf',
    arguments: { path: `${toPosix(downloadsRootPath)}/${PDF_NAME}` }
  }
  const decisions = [
    list,
    extract,
    {
      kind: 'summary',
      reply: REPLY_1,
      facts: [{ text: '第一页的正文是 PersonalAgent fixture page one', pageRefs: [1] }]
    }
  ]
  const path = join(tempDir, 'conversation.script.json')
  writeFileSync(path, JSON.stringify(decisions, null, 2), 'utf8')
  return path
}

describe.skipIf(!existsSync(VENV_PYTHON))('会话 E2E：两轮对话同一个会话（TASK-032）', () => {
  beforeEach(async () => {
    if (!existsSync(FIXTURE_PDF)) throw new Error(`缺固定 PDF: ${FIXTURE_PDF}`)

    tempDir = mkdtempSync(join(tmpdir(), 'pa-conversation-'))
    downloadsRoot = join(tempDir, 'Downloads')
    mkdirSync(downloadsRoot, { recursive: true })
    copyFileSync(FIXTURE_PDF, join(downloadsRoot, PDF_NAME))

    savedDownloadsEnv = process.env[DOWNLOADS_ENV]
    process.env[DOWNLOADS_ENV] = downloadsRoot

    db = openProductState(join(tempDir, 'product-state.db'))
    migrate(db)

    rpcLog.length = 0

    supervisor = new PythonSupervisor({
      command: VENV_PYTHON,
      args: ['-m', 'personal_agent'],
      cwd: RUNTIME_CWD,
      env: { ...process.env, [SCRIPT_ENV]: buildScript(downloadsRoot) },
      // 只读握手：确定性计划随之缩成三步，与剧本逐轮对齐（eval 同一条路）。
      capabilities: listReadOnlyCapabilities(),
      hostHandler: executeHostTool
    })
    supervisor.on('stderr', () => {})
    supervisor.start()
    await supervisor.initialize()
  })

  afterEach(async () => {
    await supervisor?.stop().catch(() => {})
    supervisor = null
    db?.close()
    db = null
    if (savedDownloadsEnv === undefined) delete process.env[DOWNLOADS_ENV]
    else process.env[DOWNLOADS_ENV] = savedDownloadsEnv
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('两轮同会话：第二轮带第一轮的历史，消息与任务都落在同一个会话里', async () => {
    const store = db
    const sup = supervisor
    if (store === null || sup === null) throw new Error('E2E 环境没起来')
    const { conversations, messages, tasks, plans, events } = repos(store)

    const runTaskDeps = (store: SqliteDatabase): RunTaskDeps => ({
      db: store,
      tasks: new SqliteTaskRepository(store),
      plans: new SqlitePlanRepository(store),
      events: new SqliteEventRepository(store),
      send: (method, params, opts) => {
        rpcLog.push({ method, params })
        return sup.request(method, params, opts)
      },
      verify: (input) =>
        verifyTaskCompletion(
          {
            tasks: new SqliteTaskRepository(store),
            plans: new SqlitePlanRepository(store),
            events: new SqliteEventRepository(store),
            permissions: new SqlitePermissionRepository(store),
            executions: new SqliteToolExecutionRepository(store),
            reminders: new SqliteReminderRepository(store),
            ...realVerificationPorts
          },
          input
        )
    })

    const sendDeps = {
      conversations,
      messages,
      buildHistory,
      runTask: (goal: unknown, history: Turn[]) => runTask(goal, runTaskDeps(store), history)
    }

    const turn1 = await sendMessage({ conversationId: null, text: QUESTION_1 }, sendDeps)
    expect(turn1.ok, JSON.stringify(turn1)).toBe(true)
    if (!turn1.ok) return
    expect(turn1.status).toBe('completed')

    const turn2 = await sendMessage(
      { conversationId: turn1.conversationId, text: QUESTION_2 },
      sendDeps
    )
    expect(turn2.ok, JSON.stringify(turn2)).toBe(true)
    if (!turn2.ok) return
    expect(turn2.status).toBe('completed')

    // 1. 两轮同一个会话；两个任务是不同的任务行。
    expect(turn2.conversationId).toBe(turn1.conversationId)
    expect(turn1.taskId).not.toBe(turn2.taskId)

    // 2. 第二轮 run_task 的入参带着第一轮的历史（第一轮是空历史）。
    const runTaskCalls = rpcLog
      .filter((call) => call.method === 'agent.run_task')
      .map((call) => call.params as { history?: Array<{ role: string; text: string }> })
    expect(runTaskCalls).toHaveLength(2)
    expect(runTaskCalls[0]?.history ?? []).toEqual([])
    expect(runTaskCalls[1]?.history).toEqual([
      { role: 'user', text: QUESTION_1 },
      { role: 'assistant', text: REPLY_1 }
    ])

    // 3. 消息按轮落库、顺序稳定；assistant 挂各自的任务。剧本模式两轮重放
    //    同一份剧本，回复文本相同——差别在 history 入参与任务行。
    const rows = messages.listByConversation(turn1.conversationId)
    expect(rows.map((m) => `${m.role}:${m.text}`)).toEqual([
      `user:${QUESTION_1}`,
      `assistant:${REPLY_1}`,
      `user:${QUESTION_2}`,
      `assistant:${REPLY_1}`
    ])
    expect(rows[1]?.taskId).toBe(turn1.taskId)
    expect(rows[3]?.taskId).toBe(turn2.taskId)

    // 4. getConversation 投影：assistant 内嵌 timeline，闸口结论可直接读。
    const view = await getConversation(turn1.conversationId, { messages, tasks, plans, events })
    expect(view.ok).toBe(true)
    if (!view.ok) return
    expect(view.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    const assistantView = view.messages[1]
    expect(assistantView?.timeline?.task.status).toBe('completed')
    expect(assistantView?.timeline?.events.some((e) => e.type === 'verification_passed')).toBe(true)
  }, 60_000)
})

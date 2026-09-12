/**
 * Phase 1 Deterministic E2E（TASK-016 / TEST-012 / REQ-010）。
 *
 * 真 spawn venv 里的 `python -m personal_agent`，真走 host.execute_tool 反向 RPC，
 * 真读 tests/fixtures/pdfs/three-page-text.pdf，真落一份 product-state.db。
 * 唯一的假成分是模型：PERSONAL_AGENT_SCRIPT 指着一份剧本，ScriptedModel 按剧本
 * 吐三步决策（filesystem.list → document.extract_pdf → summary）。
 *
 * 与 python-supervisor.test.ts 里那两条真实往返同一条规矩：venv 不在就整块跳过。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { executeHostTool, listVisibleCapabilities } from '../capabilities/host-executor'
import { ROOT_ENV, toPosix } from '../capabilities/roots'
import { migrate, openProductState, type SqliteDatabase } from '../product-state/database'
import { SqliteEventRepository } from '../product-state/event-repository'
import { SqlitePlanRepository } from '../product-state/plan-repository'
import { SqliteTaskRepository } from '../product-state/task-repository'
import { projectTimeline } from '../product-state/timeline-projection'
import { PythonSupervisor } from '../runtime/python-supervisor'
import { runTask, type RunTaskDeps } from '../tasks/run-task'
import type { RunTaskIpcResult, SummaryFact } from '../../shared/ipc-contract'

// 不写死 '../../../../../'：层级被人挪动时会静默指错地方，
// 而找特征文件失败会直接抛错，看得见。
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('找不到仓库根（pnpm-workspace.yaml）')
    dir = parent
  }
}

const ROOT = repoRoot()
const VENV_PYTHON = join(ROOT, 'services', 'agent-runtime', '.venv', 'Scripts', 'python.exe')
const RUNTIME_CWD = join(ROOT, 'services', 'agent-runtime')
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'pdfs')
const SCRIPT_TEMPLATE = join(ROOT, 'tests', 'fixtures', 'scripts', 'golden-path.json')

const ROUNDS = 20
const GOAL = '整理 Downloads 里的 PDF，给出带页码引用的摘要'
// 与 runtime.py 的 SCRIPT_ENV 是同一个字面量，跨语言没有共享常量表。
// 名字漂了这里会红成 RUNTIME_MODEL_NOT_CONFIGURED，diagnostic() 会把 stderr 带出来。
const SCRIPT_ENV = 'PERSONAL_AGENT_SCRIPT'
const DOWNLOADS_ENV = ROOT_ENV['downloads'] ?? 'PERSONAL_AGENT_DOWNLOADS_DIR'
const PLACEHOLDER = '{{DOWNLOADS_ROOT}}'
const GOLDEN_EVENT_TYPES = [
  'task_started',
  'tool_called',
  'tool_result',
  'tool_called',
  'tool_result',
  'task_completed'
]

let tempDir = ''
let dbPath = ''
let db: SqliteDatabase | null = null
let supervisor: PythonSupervisor | null = null
const stderrChunks: string[] = []
let expectedFacts: SummaryFact[] = []
const rounds: RunTaskIpcResult[] = []
let rootBefore: string[] = []
let savedDownloadsEnv: string | undefined

/** 剧本里 summary 那一项就是期望摘要。不另抄一份，抄了就会漂。 */
function readExpectedFacts(scriptPath: string): SummaryFact[] {
  const items = JSON.parse(readFileSync(scriptPath, 'utf8')) as Array<Record<string, unknown>>
  const summary = items.find((item) => item['kind'] === 'summary')
  if (summary === undefined) throw new Error(`剧本里没有 summary 项: ${scriptPath}`)
  return summary['facts'] as SummaryFact[]
}

function snapshotRoot(dir: string): string[] {
  return readdirSync(dir)
    .map((name) => {
      const s = statSync(join(dir, name))
      return `${name}:${s.size}:${s.mtimeMs}`
    })
    .sort()
}

function diagnostic(): string {
  const tail = stderrChunks
    .join('')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-20)
    .join('\n')
  return `python stderr 末尾:\n${tail === '' ? '（空）' : tail}`
}

function makeDeps(): RunTaskDeps {
  const store = db
  const sup = supervisor
  if (store === null || sup === null) throw new Error('E2E 环境没起来')
  return {
    db: store,
    tasks: new SqliteTaskRepository(store),
    plans: new SqlitePlanRepository(store),
    events: new SqliteEventRepository(store),
    send: (method, params, opts) => sup.request(method, params, opts)
  }
}

function taskIds(): string[] {
  return rounds.map((r) => (r.ok ? r.taskId : ''))
}

describe.skipIf(!existsSync(VENV_PYTHON))(
  '只读 Golden Path E2E：真 Python + 真 PDF + 真 SQLite',
  () => {
    beforeAll(async () => {
      if (!existsSync(join(FIXTURE_DIR, 'three-page-text.pdf'))) {
        throw new Error(`缺固定 PDF: ${FIXTURE_DIR}`)
      }
      const template = readFileSync(SCRIPT_TEMPLATE, 'utf8')
      if (!template.includes(PLACEHOLDER)) {
        throw new Error(`剧本模板里没有 ${PLACEHOLDER}，替换逻辑要跟着改: ${SCRIPT_TEMPLATE}`)
      }

      tempDir = mkdtempSync(join(tmpdir(), 'pa-e2e-'))
      dbPath = join(tempDir, 'product-state.db')
      const scriptPath = join(tempDir, 'golden-path.json')
      writeFileSync(scriptPath, template.replaceAll(PLACEHOLDER, toPosix(FIXTURE_DIR)), 'utf8')
      expectedFacts = readExpectedFacts(scriptPath)

      // 授权根是 host 侧（也就是本进程）读的，不在子进程 env 里。
      savedDownloadsEnv = process.env[DOWNLOADS_ENV]
      process.env[DOWNLOADS_ENV] = FIXTURE_DIR
      rootBefore = snapshotRoot(FIXTURE_DIR)

      db = openProductState(dbPath)
      migrate(db)

      const sup = new PythonSupervisor({
        command: VENV_PYTHON,
        args: ['-m', 'personal_agent'],
        cwd: RUNTIME_CWD,
        env: { ...process.env, [SCRIPT_ENV]: scriptPath },
        capabilities: listVisibleCapabilities(),
        hostHandler: executeHostTool
      })
      sup.on('stderr', (chunk: string) => stderrChunks.push(chunk))
      supervisor = sup
      sup.start()
      try {
        await sup.initialize()
      } catch (e) {
        throw new Error(`握手失败: ${e instanceof Error ? e.message : String(e)}\n${diagnostic()}`)
      }
    }, 60_000)

    afterAll(async () => {
      await supervisor?.stop().catch(() => {})
      supervisor = null
      db?.close()
      db = null
      if (savedDownloadsEnv === undefined) delete process.env[DOWNLOADS_ENV]
      else process.env[DOWNLOADS_ENV] = savedDownloadsEnv
      if (tempDir !== '') rmSync(tempDir, { recursive: true, force: true })
    }, 30_000)

    it('握手时下发给 Python 的能力清单就是两个 READ', () => {
      const visible = listVisibleCapabilities()

      expect(visible.map((c) => c.name)).toEqual(['filesystem.list', 'document.extract_pdf'])
      expect(visible.every((c) => c.kind === 'READ')).toBe(true)
    })

    it(`连跑 ${ROUNDS} 次全部 completed，且每轮摘要逐字相同`, async () => {
      for (let i = 0; i < ROUNDS; i++) {
        rounds.push(await runTask(GOAL, makeDeps()))
      }

      expect(rounds, diagnostic()).toHaveLength(ROUNDS)
      // 逐个报出问题轮次，而不是只给一句 toBe(false)：20 轮里哪一轮坏了得看得见。
      const broken = rounds
        .map((r, i) => {
          if (!r.ok) return `#${i + 1} ${r.code}: ${r.message}`
          if (r.status !== 'completed') return `#${i + 1} failed: ${r.reason ?? '（无 reason）'}`
          return null
        })
        .filter((line): line is string => line !== null)
      expect(broken, diagnostic()).toEqual([])

      // completed 本身就说明 SummaryVerifier 放行了页码：引用不存在的页会 failed。
      for (const r of rounds) {
        expect(r.ok && r.facts).toEqual(expectedFacts)
      }
      expect(new Set(taskIds()).size).toBe(ROUNDS)
      // 单轮卡住时由 supervisor 自己超时并转成 failed，这里只是一个够宽的观察窗口。
    }, 300_000)

    it('每轮事件流形状一致：三步模板跑出六条事件', () => {
      const deps = makeDeps()

      for (const [i, taskId] of taskIds().entries()) {
        const timeline = projectTimeline(deps.tasks, deps.events, deps.plans, taskId)
        const seqs = timeline?.events.map((e) => e.seq) ?? []
        const first = seqs[0] ?? -1

        expect(timeline?.task.status).toBe('completed')
        expect(timeline?.events.map((e) => e.type)).toEqual(GOLDEN_EVENT_TYPES)
        // seq 是整表自增、跨任务接着走的，所以只能钉「一轮占六条且连续」。
        expect(first).toBe(i * GOLDEN_EVENT_TYPES.length + 1)
        expect(seqs).toEqual(Array.from({ length: GOLDEN_EVENT_TYPES.length }, (_, j) => first + j))
      }
    })

    it('每轮都落一份 v1 计划，内容是钉死的三步', () => {
      const deps = makeDeps()

      for (const taskId of taskIds()) {
        const plan = projectTimeline(deps.tasks, deps.events, deps.plans, taskId)?.plan

        expect(plan?.version).toBe(1)
        expect(plan?.steps.map((s) => s.capability)).toEqual([
          'filesystem.list',
          'document.extract_pdf',
          undefined
        ])
      }
    })

    it('重开数据库后，最后一轮的摘要正文与计划仍读得回来', () => {
      const lastTaskId = taskIds()[ROUNDS - 1]
      db?.close()
      db = openProductState(dbPath)
      const deps = makeDeps()

      const timeline = projectTimeline(deps.tasks, deps.events, deps.plans, lastTaskId)
      const completed = timeline?.events.filter((e) => e.type === 'task_completed')

      expect(completed).toHaveLength(1)
      expect(completed?.[0]?.payload).toEqual({
        factCount: expectedFacts.length,
        facts: expectedFacts
      })
      expect(timeline?.plan?.steps).toHaveLength(3)
      expect(timeline?.task.status).toBe('completed')
    })

    it('只读：授权根跑完前后一个字节都没变', () => {
      expect(snapshotRoot(FIXTURE_DIR)).toEqual(rootBefore)
    })
  }
)

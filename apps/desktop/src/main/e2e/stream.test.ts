/**
 * 实时通知 E2E（TASK-033 R2）：真 spawn venv 的 `python -m personal_agent`，
 * 真走 stdio NDJSON，真按剧本跑一轮只读任务。
 *
 * 本文件只验一条线：Python 把 agent.stream 通知写出来、supervisor 收得到、
 * 形状与顺序都对，而且**不碰回包**——通知是尽力而为的预览，agent.run_task
 * 的回包才是唯一事实来源。落库、交付物闸口、权限批准不在这里
 * （golden-path 与 conversation E2E 已覆盖）。
 *
 * 走 beginTask + 直接 request 而不是 runTask：策略层要求「有当前任务」才放行
 * 工具调用，而这条线不需要落库那一半。脚本与 fixture 都是真的，只有模型是剧本。
 *
 * venv 不在就整块跳过，与 golden-path 同一条规矩。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AGENT_RUN_TASK, RunTaskResult, type AgentStreamParams } from '@personal-agent/protocol'

import { executeHostTool, listReadOnlyCapabilities } from '../capabilities/host-executor'
import { ROOT_ENV, toPosix } from '../capabilities/roots'
import { beginTask, endTask } from '../policy/task-context'
import { PythonSupervisor } from '../runtime/python-supervisor'
import type { PlanStep } from '../../shared/domain'
import { repoRoot } from '../eval/paths'

const ROOT = repoRoot()
const VENV_PYTHON = join(ROOT, 'services', 'agent-runtime', '.venv', 'Scripts', 'python.exe')
const RUNTIME_CWD = join(ROOT, 'services', 'agent-runtime')
const FIXTURE_PDF = join(ROOT, 'tests', 'fixtures', 'pdfs', 'three-page-text.pdf')
const PDF_NAME = 'three-page-text.pdf'
const SCRIPT_ENV = 'PERSONAL_AGENT_SCRIPT'
const DOWNLOADS_ENV = ROOT_ENV['downloads'] ?? 'PERSONAL_AGENT_DOWNLOADS_DIR'

const TASK_ID = 't-stream-1'
const GOAL = '把这份 PDF 摘要一下'
const REPLY = '第一页正文是 PersonalAgent fixture page one。'

const THINKING_LIST = '先列出 Downloads 里有哪些 PDF，再决定整理哪一份。'
const THINKING_EXTRACT = '挑中这份，把每页文本提出来——后面写摘要要用真实页码。'
const THINKING_SUMMARY = '材料齐了：先说清做了什么，再放结论。'

// 只读三步计划：与握手下发的能力对得上（对齐闸口按它放行）。
const PLAN: PlanStep[] = [
  { description: '列出 Downloads 下的 PDF', capability: 'filesystem_list' },
  { description: '提取目标 PDF 的每页文本', capability: 'document_extract_pdf' },
  { description: '基于页面内容生成带页码引用的摘要' }
]

let tempDir = ''
let downloadsRoot = ''
let supervisor: PythonSupervisor | null = null
let savedDownloadsEnv: string | undefined

/** 把通知序列压成可读标签，专门用来钉顺序。 */
function labels(notices: AgentStreamParams[]): string[] {
  return notices.map((notice) =>
    notice.kind === 'thinking' ? 'thinking' : `event:${notice.event.type}`
  )
}

function buildScript(root: string): string {
  const decisions = [
    {
      kind: 'tool_call',
      callId: 'c-1',
      capability: 'filesystem_list',
      arguments: { rootId: 'downloads' },
      thinking: THINKING_LIST
    },
    {
      kind: 'tool_call',
      callId: 'c-2',
      capability: 'document_extract_pdf',
      arguments: { path: `${toPosix(root)}/${PDF_NAME}` },
      thinking: THINKING_EXTRACT
    },
    {
      kind: 'summary',
      reply: REPLY,
      facts: [{ text: '第一页的正文是 PersonalAgent fixture page one', pageRefs: [1] }],
      thinking: THINKING_SUMMARY
    }
  ]
  const path = join(tempDir, 'stream.script.json')
  writeFileSync(path, JSON.stringify(decisions, null, 2), 'utf8')
  return path
}

describe.skipIf(!existsSync(VENV_PYTHON))(
  '实时通知 E2E：Python → stdio → supervisor（TASK-033）',
  () => {
    beforeEach(async () => {
      if (!existsSync(FIXTURE_PDF)) throw new Error(`缺固定 PDF: ${FIXTURE_PDF}`)

      tempDir = mkdtempSync(join(tmpdir(), 'pa-stream-'))
      downloadsRoot = join(tempDir, 'Downloads')
      mkdirSync(downloadsRoot, { recursive: true })
      copyFileSync(FIXTURE_PDF, join(downloadsRoot, PDF_NAME))

      savedDownloadsEnv = process.env[DOWNLOADS_ENV]
      process.env[DOWNLOADS_ENV] = downloadsRoot

      supervisor = new PythonSupervisor({
        command: VENV_PYTHON,
        args: ['-m', 'personal_agent'],
        cwd: RUNTIME_CWD,
        env: { ...process.env, [SCRIPT_ENV]: buildScript(downloadsRoot) },
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
      if (savedDownloadsEnv === undefined) delete process.env[DOWNLOADS_ENV]
      else process.env[DOWNLOADS_ENV] = savedDownloadsEnv
      rmSync(tempDir, { recursive: true, force: true })
    })

    it('事件与思维链都实时到、顺序稳定，且回包仍是权威', async () => {
      const sup = supervisor
      if (sup === null) throw new Error('E2E 环境没起来')

      const notices: AgentStreamParams[] = []
      sup.on('agent.stream', (notice: AgentStreamParams) => notices.push(notice))

      beginTask(TASK_ID, GOAL, PLAN)
      let raw: unknown
      try {
        raw = await sup.request(AGENT_RUN_TASK, {
          taskId: TASK_ID,
          goal: GOAL,
          plan: PLAN,
          history: []
        })
      } finally {
        endTask()
      }

      const parsed = RunTaskResult.safeParse(raw)
      expect(parsed.success, JSON.stringify(parsed.error?.message ?? raw)).toBe(true)
      if (!parsed.success) return
      const result = parsed.data
      expect(result.status, JSON.stringify(result)).toBe('completed')
      if (result.status !== 'completed') return
      expect(result.reply).toBe(REPLY)

      // 1. 通知一律挂在本次任务上：渲染层靠它认领，不靠「现在跑的是谁」的时序假设。
      expect(new Set(notices.map((notice) => notice.taskId))).toEqual(new Set([TASK_ID]))

      // 2. 顺序：思考落在它所属的那个决策之前（ScriptedModel 在返回决策前分块吐完）。
      expect(labels(notices)).toEqual([
        'event:task_started',
        'thinking',
        'thinking',
        'event:tool_called',
        'event:tool_result',
        'thinking',
        'thinking',
        'event:tool_called',
        'event:tool_result',
        'thinking',
        'event:task_completed'
      ])

      // 3. 增量语义的活证据：把 delta 逐字拼回来，必须与剧本里的三段完全一致。
      const thinking = notices
        .filter((notice) => notice.kind === 'thinking')
        .map((notice) => (notice.kind === 'thinking' ? notice.delta : ''))
        .join('')
      expect(thinking).toBe(`${THINKING_LIST}${THINKING_EXTRACT}${THINKING_SUMMARY}`)

      // 4. event 通知与回包 events 是同一批：通知只是预览，回包才是唯一事实来源。
      //    scripted 不记账，所以这里没有 model_usage 要减（真模型下它会少一条——
      //    见 _settle_usage：那是结算，不是过程）。
      const streamedTypes = notices
        .filter((notice) => notice.kind === 'event')
        .map((notice) => (notice.kind === 'event' ? notice.event.type : ''))
      expect(streamedTypes).toEqual(result.events.map((event) => event.type))
    }, 60_000)
  }
)

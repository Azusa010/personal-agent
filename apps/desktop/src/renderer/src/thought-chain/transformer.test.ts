import { describe, expect, it } from 'vitest'
import type { TaskTimeline } from '../../../shared/ipc-contract'
import type { LiveStreamState } from '../view-model'
import {
  calculateTraceStats,
  eventsToSteps,
  streamStateToSteps,
  timelineToSteps
} from './transformer'
import type { ThoughtStepView, ToolStepView, VerificationStepView } from './types'

describe('transformer', () => {
  it('正确配对 tool_called 与 tool_result', () => {
    const events = [
      {
        type: 'tool_called',
        payload: {
          callId: 'call-1',
          capability: 'filesystem_list',
          arguments: { rootId: 'downloads' }
        },
        occurredAt: '2026-09-20T10:00:00.000Z'
      },
      {
        type: 'tool_result',
        payload: {
          callId: 'call-1',
          capability: 'filesystem_list',
          ok: true,
          result: [{ name: 'a.pdf' }]
        },
        occurredAt: '2026-09-20T10:00:00.500Z'
      }
    ]

    const steps = eventsToSteps(events)
    expect(steps).toHaveLength(1)
    const tool = steps[0] as ToolStepView
    expect(tool.type).toBe('tool')
    expect(tool.callId).toBe('call-1')
    expect(tool.capability).toBe('filesystem_list')
    expect(tool.status).toBe('success')
    expect(tool.durationMs).toBe(500)
    expect(tool.observation).toEqual([{ name: 'a.pdf' }])
  })

  it('工具报错时正确抓取错误码与提示', () => {
    const events = [
      {
        type: 'tool_called',
        payload: {
          callId: 'call-2',
          capability: 'document_extract_pdf',
          arguments: { path: 'corrupted.pdf' }
        },
        occurredAt: '2026-09-20T10:00:01.000Z'
      },
      {
        type: 'tool_result',
        payload: {
          callId: 'call-2',
          capability: 'document_extract_pdf',
          ok: false,
          error: {
            code: 'PDF_PARSE_ERROR',
            message: '文件已损坏'
          }
        },
        occurredAt: '2026-09-20T10:00:01.200Z'
      }
    ]

    const steps = eventsToSteps(events)
    expect(steps).toHaveLength(1)
    const tool = steps[0] as ToolStepView
    expect(tool.status).toBe('failed')
    expect(tool.error?.code).toBe('PDF_PARSE_ERROR')
    expect(tool.error?.message).toBe('文件已损坏')
  })

  it('转换交付物校验事件 (verification_passed)', () => {
    const events = [
      {
        type: 'verification_passed',
        payload: {
          factCount: 3,
          report: {
            reason: '全部校验通过',
            checks: [
              { name: '页码真实存在', ok: true },
              { name: '引文与正文一致', ok: true }
            ]
          }
        },
        occurredAt: '2026-09-20T10:00:02.000Z'
      }
    ]

    const steps = eventsToSteps(events)
    expect(steps).toHaveLength(1)
    const ver = steps[0] as VerificationStepView
    expect(ver.type).toBe('verification')
    expect(ver.status).toBe('success')
    expect(ver.passedCount).toBe(2)
    expect(ver.totalChecks).toBe(2)
    expect(ver.reason).toBe('全部校验通过')
  })

  it('历史 TaskTimeline 转换：包含计划 checklist 与事件', () => {
    const timeline: TaskTimeline = {
      task: {
        id: 'task-1',
        goal: '整理文档',
        status: 'completed',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:05.000Z'
      },
      plan: {
        id: 'plan-1',
        taskId: 'task-1',
        version: 1,
        steps: [
          { description: '扫描目录', capability: 'filesystem_list' },
          { description: '生成摘要' }
        ],
        createdAt: '2026-09-20T10:00:00.100Z'
      },
      events: [
        {
          seq: 1,
          taskId: 'task-1',
          type: 'tool_called',
          payload: { callId: 'c1', capability: 'filesystem_list', arguments: {} },
          occurredAt: '2026-09-20T10:00:01.000Z'
        },
        {
          seq: 2,
          taskId: 'task-1',
          type: 'tool_result',
          payload: { callId: 'c1', capability: 'filesystem_list', ok: true },
          occurredAt: '2026-09-20T10:00:01.300Z'
        }
      ]
    }

    const steps = timelineToSteps(timeline)
    expect(steps).toHaveLength(2)
    const thought = steps[0] as ThoughtStepView
    expect(thought.type).toBe('thought')
    expect(thought.planSteps).toHaveLength(2)
    expect(thought.planSteps?.[0].done).toBe(true)

    const tool = steps[1] as ToolStepView
    expect(tool.type).toBe('tool')
    expect(tool.status).toBe('success')
  })

  it('历史 TaskTimeline 带 cachedThinking：优先注入模型真实原始思维链', () => {
    const timeline: TaskTimeline = {
      task: {
        id: 'task-cot',
        goal: '整理文档',
        status: 'completed',
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:05.000Z'
      },
      plan: {
        id: 'plan-1',
        taskId: 'task-cot',
        version: 1,
        steps: [{ description: '扫描目录', capability: 'filesystem_list' }],
        createdAt: '2026-09-20T10:00:00.100Z'
      },
      events: []
    }

    const rawCot = '大模型内部思考：用户希望先查找 PDF 文件，然后提取第 1 页...'
    const steps = timelineToSteps(timeline, rawCot)
    expect(steps).toHaveLength(1)
    const thought = steps[0] as ThoughtStepView
    expect(thought.type).toBe('thought')
    expect(thought.title).toBe('推理过程与执行计划')
    expect(thought.thinkingText).toBe(rawCot)
    expect(thought.planSteps).toHaveLength(1)
  })

  it('流式状态转换：包含实时思考与进行中的工具', () => {
    const live: LiveStreamState = {
      taskId: 'task-live',
      thinking: '先分析当前用户目标...',
      events: [
        {
          type: 'tool_called',
          payload: { callId: 'c-live', capability: 'filesystem_list', arguments: {} },
          occurredAt: '2026-09-20T10:00:00.000Z'
        }
      ]
    }

    const steps = streamStateToSteps(live)
    expect(steps).toHaveLength(2)
    expect(steps[0].type).toBe('thought')
    expect(steps[0].status).toBe('running')
    expect((steps[0] as ThoughtStepView).thinkingText).toBe('先分析当前用户目标...')

    expect(steps[1].type).toBe('tool')
    expect(steps[1].status).toBe('running')
  })

  it('计算轨迹摘要指标', () => {
    const steps = [
      {
        id: '1',
        type: 'thought',
        title: '思考',
        status: 'success'
      },
      {
        id: '2',
        type: 'tool',
        title: '工具',
        status: 'success',
        durationMs: 300
      },
      {
        id: '3',
        type: 'tool',
        title: '工具2',
        status: 'failed',
        durationMs: 200
      }
    ] as ToolStepView[]

    const stats = calculateTraceStats(steps)
    expect(stats.totalSteps).toBe(3)
    expect(stats.toolCallsCount).toBe(2)
    expect(stats.totalDurationMs).toBe(500)
    expect(stats.hasErrors).toBe(true)
  })
})

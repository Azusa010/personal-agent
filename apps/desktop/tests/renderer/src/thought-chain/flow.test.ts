import { describe, expect, it } from 'vitest'
import { stepsToFlowLines } from '../../../../src/renderer/src/thought-chain/flow'
import type {
  NoticeStepView,
  ThoughtStepView,
  ToolStepView
} from '../../../../src/renderer/src/thought-chain/types'

function toolStep(id: string): ToolStepView {
  return {
    id,
    type: 'tool',
    title: '上网查了查',
    callId: id,
    capability: 'web_search',
    arguments: { query: '最新模型发布' },
    status: 'success',
    startedAt: '2026-10-24T10:00:00.000Z',
    durationMs: 800,
    observation: null
  }
}

function thoughtStep(id: string, overrides: Partial<ThoughtStepView> = {}): ThoughtStepView {
  return {
    id,
    type: 'thought',
    title: '正在深度思考与推理...',
    status: 'running',
    thinkingText: '',
    ...overrides
  }
}

function noticeStep(id: string, noticeKind: 'budget' | 'reminder'): NoticeStepView {
  return {
    id,
    type: 'notice',
    noticeKind,
    title: noticeKind === 'budget' ? '预算耗尽' : '已创建提醒',
    status: noticeKind === 'budget' ? 'failed' : 'success',
    startedAt: '2026-10-24T10:00:01.000Z',
    description: noticeKind === 'budget' ? '已用 3 步 / 8 次工具调用' : '提醒时间：明天 09:00',
    rawPayload: {}
  }
}

describe('stepsToFlowLines', () => {
  it('budget notice 不出叙述行：结论已由聊天正文（终态 reason）说明', () => {
    const lines = stepsToFlowLines([toolStep('t-1'), noticeStep('n-1', 'budget')])

    expect(lines.map((line) => line.id)).toEqual(['t-1'])
  })

  it('其他 notice（如提醒）与工具行照常成句', () => {
    const lines = stepsToFlowLines([toolStep('t-1'), noticeStep('n-1', 'reminder')])

    expect(lines.map((line) => line.id)).toEqual(['t-1', 'n-1'])
    expect(lines[1]?.text).toContain('提醒时间')
  })

  it('工具跑过之后正在进行的思考行保留（直播新一轮思考是唯一活动状态）', () => {
    const lines = stepsToFlowLines([
      thoughtStep('live-thinking-1', { thinkingText: '再看一遍清单。' }),
      toolStep('t-1')
    ])

    expect(lines.map((line) => line.id)).toEqual(['live-thinking-1', 't-1'])
    expect(lines[0]?.status).toBe('running')
  })

  it('工具跑过之后已落定的开场思考行吞掉（历史态不被独白拖长）', () => {
    const lines = stepsToFlowLines([
      thoughtStep('plan-1', { status: 'success', thinkingText: '先列目录再提取。' }),
      toolStep('t-1')
    ])

    expect(lines.map((line) => line.id)).toEqual(['t-1'])
  })

  it('没有工具时思考行照常保留（原语义）', () => {
    const lines = stepsToFlowLines([thoughtStep('live-thinking-1', { thinkingText: '先想一想。' })])

    expect(lines.map((line) => line.id)).toEqual(['live-thinking-1'])
  })

  it('recent 思考从累加串尾部取句：叙述跟新内容走，不是开场第一句', () => {
    const lines = stepsToFlowLines([
      thoughtStep('live-thinking-1', {
        recent: true,
        thinkingText: '第一轮：先列目录。第二轮：清单里挑最近改的那份，正在比时间戳。'
      }),
      toolStep('t-1')
    ])

    expect(lines[0]?.text).toBe('第二轮：清单里挑最近改的那份，正在比时间戳。')
  })

  it('非 recent 思考从开头取句（原语义）', () => {
    const lines = stepsToFlowLines([
      thoughtStep('live-thinking-1', {
        thinkingText: '第一句。第二句。'
      })
    ])

    expect(lines[0]?.text).toBe('第一句。')
  })
})

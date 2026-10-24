import { describe, expect, it } from 'vitest'
import { stepsToFlowLines } from '../../../../src/renderer/src/thought-chain/flow'
import type { NoticeStepView, ToolStepView } from '../../../../src/renderer/src/thought-chain/types'

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
})

import { describe, expect, it } from 'vitest'
import { failures, infrastructureFailure } from './html-judge'

describe('HTML evaluation verdict', () => {
  it('requires correct reminder values and a matching submission', () => {
    const check = {
      data: { text: '', missing: [], title: '提交周报', date: '2026-12-18' },
      submissions: [{ title: '提交周报', date: '2026-12-18', time: '09:30' }]
    }
    expect(failures('reminder-form', check)).toEqual([])
    expect(failures('reminder-form', { ...check, submissions: [{ time: '10:00' }] })).toContain(
      '提交值不正确'
    )
  })
  it('requires a chart, source, all values and a filtered total without other regions', () => {
    const check = {
      data: { text: 'sales.csv 120 75 95 130', filtered: '120 95 215', hasChart: true, missing: [] }
    }
    expect(failures('csv-chart', check)).toEqual([])
    expect(failures('csv-chart', { data: { ...check.data, filtered: '120 95 215 75' } })).toContain(
      '筛选包含其他地区'
    )
    expect(failures('csv-chart', { data: { ...check.data, hasChart: false } })).toContain(
      '未找到图表'
    )
  })
  it('requires every card and the selected value', () => {
    const check = {
      data: { text: '本地备份 10 云备份 25 混合备份 40', missing: [] },
      submissions: [{ choice: 'B' }]
    }
    expect(failures('choice-cards', check)).toEqual([])
    expect(failures('choice-cards', { ...check, submissions: [{ choice: 'A' }] })).toContain(
      '选择结果不正确'
    )
  })
  it('does not pass a failed page load', () => {
    expect(failures('reminder-form', { error: '超时' })).toContain('页面加载失败: 超时')
  })
  it('distinguishes an exhausted provider balance from a model failure', () => {
    expect(infrastructureFailure({ reason: 'Error code: 402 - Insufficient Balance' })).toBe(true)
    expect(infrastructureFailure({ reason: '模型输出不是合法 JSON' })).toBe(false)
  })
})

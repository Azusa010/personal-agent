import { describe, expect, it } from 'vitest'

import { groupRecords, type LogGroup } from '../../../src/main/observability/aggregator'
import { makeRecord } from './support'

const FP_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const FP_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('aggregator ~ 聚合', () => {
  it('空输入返回空数组', () => {
    expect(groupRecords([])).toEqual([])
  })

  it('同指纹合并成一组并累计次数', () => {
    const groups = groupRecords(
      [
        makeRecord({ id: '1', fingerprint: FP_A, ts: '2026-10-19T01:00:00.000Z' }),
        makeRecord({ id: '2', fingerprint: FP_A, ts: '2026-10-19T02:00:00.000Z' }),
        makeRecord({ id: '3', fingerprint: FP_A, ts: '2026-10-19T03:00:00.000Z' })
      ],
      { minLevel: 'debug' }
    )

    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(3)
    expect(groups[0].firstTs).toBe('2026-10-19T01:00:00.000Z')
    expect(groups[0].lastTs).toBe('2026-10-19T03:00:00.000Z')
  })

  it('不同指纹各自成组', () => {
    const groups = groupRecords(
      [
        makeRecord({ id: '1', fingerprint: FP_A }),
        makeRecord({ id: '2', fingerprint: FP_B })
      ],
      { minLevel: 'debug' }
    )

    expect(groups.map((g: LogGroup) => g.fingerprint).sort()).toEqual([FP_A, FP_B].sort())
  })

  it('代表消息与级别取最新一条', () => {
    const groups = groupRecords(
      [
        makeRecord({
          id: '1',
          fingerprint: FP_A,
          level: 'warn',
          message: '旧描述',
          ts: '2026-10-19T01:00:00.000Z'
        }),
        makeRecord({
          id: '2',
          fingerprint: FP_A,
          level: 'error',
          message: '新描述',
          ts: '2026-10-19T05:00:00.000Z'
        })
      ],
      { minLevel: 'debug' }
    )

    expect(groups[0].message).toBe('新描述')
    expect(groups[0].level).toBe('error')
    expect(groups[0].sampleId).toBe('2')
  })
})

describe('aggregator ~ 过滤与排序', () => {
  it('默认只保留 error 及以上', () => {
    const groups = groupRecords([
      makeRecord({ id: 'i', fingerprint: FP_A, level: 'info' }),
      makeRecord({ id: 'w', fingerprint: FP_B, level: 'warn' })
    ])

    expect(groups).toEqual([])
  })

  it('minLevel 可下调', () => {
    const groups = groupRecords(
      [
        makeRecord({ id: 'i', fingerprint: FP_A, level: 'info' }),
        makeRecord({ id: 'e', fingerprint: FP_B, level: 'error' })
      ],
      { minLevel: 'info' }
    )

    expect(groups).toHaveLength(2)
  })

  it('按 lastTs 倒序排列', () => {
    const groups = groupRecords(
      [
        makeRecord({ fingerprint: FP_A, ts: '2026-10-19T01:00:00.000Z' }),
        makeRecord({ fingerprint: FP_B, ts: '2026-10-19T09:00:00.000Z' })
      ],
      { minLevel: 'debug' }
    )

    expect(groups.map((g: LogGroup) => g.fingerprint)).toEqual([FP_B, FP_A])
  })

  it('lastTs 相同时次数多的在前', () => {
    const ts = '2026-10-19T09:00:00.000Z'
    const groups = groupRecords(
      [
        makeRecord({ id: 'a1', fingerprint: FP_A, ts }),
        makeRecord({ id: 'b1', fingerprint: FP_B, ts }),
        makeRecord({ id: 'b2', fingerprint: FP_B, ts })
      ],
      { minLevel: 'debug' }
    )

    expect(groups.map((g: LogGroup) => g.fingerprint)).toEqual([FP_B, FP_A])
    expect(groups[0].count).toBe(2)
  })
})

import { describe, expect, it } from 'vitest'
import { computeHybridScore } from './hybrid-score'

describe('computeHybridScore (RRF + Exponential Decay)', () => {
  const K = 60
  const BASE_NOW = new Date('2026-09-26T12:00:00Z').getTime()
  const ONE_DAY_MS = 24 * 60 * 60 * 1000

  it('验证仅稠密或仅稀疏单路召回时的基础 RRF 得分', () => {
    // 仅 denseRank = 1
    const denseOnly = computeHybridScore({
      denseRank: 1,
      nowMs: BASE_NOW
    })
    expect(denseOnly).toBeCloseTo(1 / (K + 1), 6)

    // 仅 sparseRank = 2
    const sparseOnly = computeHybridScore({
      sparseRank: 2,
      nowMs: BASE_NOW
    })
    expect(sparseOnly).toBeCloseTo(1 / (K + 2), 6)

    // 双空时返回 0
    expect(computeHybridScore({})).toBe(0)
    expect(computeHybridScore({ denseRank: 0, sparseRank: -1 })).toBe(0)
  })

  it('验证双路同时命中时的 RRF 加和打分', () => {
    // denseRank = 1, sparseRank = 1, 且无时间衰减
    const dualScore = computeHybridScore({
      denseRank: 1,
      sparseRank: 1,
      nowMs: BASE_NOW
    })
    const expected = 1 / (K + 1) + 1 / (K + 1)
    expect(dualScore).toBeCloseTo(expected, 6)
  })

  it('验证半衰期时间衰减：恰好经过一个半衰期时得分减半', () => {
    const halfLifeDays = 30
    const exactlyOneHalfLifeAgo = new Date(BASE_NOW - halfLifeDays * ONE_DAY_MS).toISOString()

    const rawScore = computeHybridScore({
      denseRank: 1,
      nowMs: BASE_NOW
    })
    const decayedScore = computeHybridScore({
      denseRank: 1,
      occurredAt: exactlyOneHalfLifeAgo,
      halfLifeDays: 30,
      nowMs: BASE_NOW
    })

    // 经过 1 个半衰期，得分应恰好衰减为原来的 50%
    expect(decayedScore).toBeCloseTo(rawScore * 0.5, 6)
  })

  it('验证多半衰期衰减与未来时间安全保护', () => {
    const halfLifeDays = 10
    // 经过 2 个半衰期 (20 天前) -> 衰减为 25% (0.5^2)
    const twoHalfLivesAgo = new Date(BASE_NOW - 20 * ONE_DAY_MS).toISOString()
    const score2 = computeHybridScore({
      denseRank: 1,
      occurredAt: twoHalfLivesAgo,
      halfLifeDays,
      nowMs: BASE_NOW
    })
    const baseScore = 1 / (K + 1)
    expect(score2).toBeCloseTo(baseScore * 0.25, 6)

    // 时间在未来 (nowMs < occurredAt) -> 不衰减，deltaDays=0，衰减系数为 1.0
    const futureDate = new Date(BASE_NOW + 5 * ONE_DAY_MS).toISOString()
    const futureScore = computeHybridScore({
      denseRank: 1,
      occurredAt: futureDate,
      halfLifeDays,
      nowMs: BASE_NOW
    })
    expect(futureScore).toBeCloseTo(baseScore, 6)
  })

  it('验证无效时间戳时的容错不衰减', () => {
    const score = computeHybridScore({
      denseRank: 2,
      sparseRank: 3,
      occurredAt: 'invalid-date-string',
      nowMs: BASE_NOW
    })
    const expected = 1 / (K + 2) + 1 / (K + 3)
    expect(score).toBeCloseTo(expected, 6)
  })
})

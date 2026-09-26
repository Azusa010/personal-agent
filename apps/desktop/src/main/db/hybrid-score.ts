/**
 * 多路召回 RRF (Reciprocal Rank Fusion) 倒数排名融合与时效半衰期衰减算子。
 *
 * 结合密集向量排名、稀疏文本检索排名与发生时间衰减因子，
 * 计算兼顾多维相关性与记忆新鲜度的综合评分。
 */

export interface HybridScoreOptions {
  denseRank?: number | null
  sparseRank?: number | null
  occurredAt?: string | Date | null
  halfLifeDays?: number
  nowMs?: number
  k?: number
}

/**
 * 计算多路召回 RRF 与指数时间衰减复合得分。
 *
 * 契约要求：
 * 1. 基础 RRF 倒数融合打分：
 *    - 稠密贡献分: denseRank > 0 时为 1 / (k + denseRank)，否则为 0；
 *    - 稀疏贡献分: sparseRank > 0 时为 1 / (k + sparseRank)，否则为 0；
 *    - 若稠密与稀疏排名均为空或 <= 0，直接返回 0；
 * 2. 时间半衰期指数衰减 (Exponential Half-life Decay)：
 *    - 当提供了有效的 `occurredAt` 时，计算距今流逝天数 deltaDays = max(0, (nowMs - occurredAtMs) / (1000 * 60 * 60 * 24))；
 *    - 衰减系数: decay = exp(-ln(2) * deltaDays / halfLifeDays)；
 *    - 当未提供 `occurredAt` 或解析无效时，衰减系数默认为 1.0（不衰减）；
 * 3. 复合得分计算：
 *    - Score = (denseScore + sparseScore) * decay
 *
 * @param options 打分参数对象
 * @returns 复合相关性得分
 */
export function computeHybridScore(options: HybridScoreOptions): number {
  const {
    denseRank,
    sparseRank,
    occurredAt,
    halfLifeDays = 30,
    nowMs = Date.now(),
    k = 60
  } = options

  const denseScore = denseRank && denseRank > 0 ? 1 / (k + denseRank) : 0
  const sparseScore = sparseRank && sparseRank > 0 ? 1 / (k + sparseRank) : 0
  const baseScore = denseScore + sparseScore
  if (baseScore === 0) {
    return 0
  }

  let decay = 1.0
  if (occurredAt) {
    const occurredMs =
      typeof occurredAt === 'string' ? new Date(occurredAt).getTime() : occurredAt.getTime()
    if (!isNaN(occurredMs)) {
      const deltaDays = Math.max(0, (nowMs - occurredMs) / (1000 * 60 * 60 * 24))
      decay = Math.exp((-Math.log(2) * deltaDays) / halfLifeDays)
    }
  }
  return baseScore * decay
}

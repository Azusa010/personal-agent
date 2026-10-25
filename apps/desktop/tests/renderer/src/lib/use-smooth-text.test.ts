import { describe, expect, it } from 'vitest'

import { nextShownLength } from '../../../../src/renderer/src/lib/use-smooth-text'

describe('nextShownLength（打字机节奏）', () => {
  it('追平后停在目标长度，不再推进', () => {
    expect(nextShownLength('你好', 2, 2, 12)).toBe(2)
    // shown 超过目标（异常防御）也钳回目标
    expect(nextShownLength('你好', 5, 2, 12)).toBe(2)
  })

  it('涓流时按 minCharsPerFrame 匀速走', () => {
    const target = '一二三四五六七八九十'
    // 积压 10 字 < min*catchUp，走下限 2/帧
    expect(nextShownLength(target, 0, 2, 12)).toBe(2)
    expect(nextShownLength(target, 2, 2, 12)).toBe(4)
  })

  it('大块积压按比例追帧：约 catchUpFrames 帧清完', () => {
    const target = 'x'.repeat(240)
    // 240/12 = 20 字/帧，快于下限
    expect(nextShownLength(target, 0, 2, 12)).toBe(20)
    // 积压收窄后逐步降速；尾巴积压 12 字走 min 下限 2/帧
    expect(nextShownLength(target, 228, 2, 12)).toBe(230)
  })

  it('积压不足一帧时一步到位', () => {
    expect(nextShownLength('abc', 2, 2, 12)).toBe(3)
  })

  it('切点落进代理对中间时多走一步，emoji 不被劈开', () => {
    // "好"占 1 个 UTF-16 码元，😀 占 2 个：索引 2 恰是代理对中间
    const target = '好😀好'
    const cut = nextShownLength(target, 1, 1, 12)
    expect(cut).toBe(3)
    // 切出的前缀不包含半个代理对
    expect(target.slice(0, cut)).toBe('好😀')
  })

  it('目标为空串时直接返回 0', () => {
    expect(nextShownLength('', 0, 2, 12)).toBe(0)
  })
})

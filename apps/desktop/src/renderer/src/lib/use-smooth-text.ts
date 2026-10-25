import { useEffect, useRef, useState } from 'react'

export interface SmoothTextOptions {
  /** 每帧最少推进的字符数：匀速下限，60fps 下约 120 字/秒 */
  minCharsPerFrame?: number
  /** 追帧除数：积压约 N 帧清完，大块到达时被摊开而不是一次性砸出来 */
  catchUpFrames?: number
}

/**
 * 打字机节奏的纯函数：这一帧该显示到第几个字符（UTF-16 索引）。
 *
 * 增量往往一次到一大口，直接渲染就是「欻一下」。这里把积压摊到帧上：
 * 慢涓流时按 minCharsPerFrame 匀速走，大块积压时按比例追帧，约
 * catchUpFrames 帧清完。切点落进代理对中间就多走一步，emoji 不闪半个字。
 */
export function nextShownLength(
  target: string,
  shownLength: number,
  minCharsPerFrame: number,
  catchUpFrames: number
): number {
  if (shownLength >= target.length) return target.length
  const backlog = target.length - shownLength
  let cut = shownLength + Math.max(minCharsPerFrame, Math.ceil(backlog / catchUpFrames))
  if (cut >= target.length) return target.length
  const code = target.charCodeAt(cut)
  if (code >= 0xdc00 && code <= 0xdfff) cut += 1
  return cut
}

/**
 * 平滑文本 hook：把「目标全文」喂进来，返回「当前应显示的前缀」。
 *
 * 目标串只增不减（流式 append 语义）；追平后停帧，新增量到达时自动续走。
 * 系统「减弱动态效果」开启时跳过动画直接显示全文。
 */
export function useSmoothText(target: string, options: SmoothTextOptions = {}): string {
  const { minCharsPerFrame = 2, catchUpFrames = 12 } = options
  // 减弱动态效果：渲染期就定死，不走动画路径，也不需要在 effect 里回写状态
  const [reducedMotion] = useState(
    () =>
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  const [shownLength, setShownLength] = useState(0)
  const shownRef = useRef(0)

  useEffect(() => {
    if (reducedMotion) return
    let raf = 0
    const tick = (): void => {
      const next = nextShownLength(target, shownRef.current, minCharsPerFrame, catchUpFrames)
      if (next === shownRef.current) return
      shownRef.current = next
      setShownLength(next)
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [target, minCharsPerFrame, catchUpFrames, reducedMotion])

  return reducedMotion ? target : target.slice(0, shownLength)
}

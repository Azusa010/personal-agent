import { useEffect, useState } from 'react'

export interface SmoothTextOptions {
  /** 每帧最少推进的字符数：匀速下限，60fps 下约 60 字/秒 */
  minCharsPerFrame?: number
  /** 追帧除数：积压约 N 帧清完大半，大块到达时被摊开而不是一次性砸出来 */
  catchUpFrames?: number
  /** 变化时打字进度归零（新一轮任务开始）。同任务的「流式块 → 正式消息」换场传同一个值，进度就接续不断。 */
  resetKey?: string | null
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
 * 进度是带 resetKey 的游标 state，只在 rAF 回调里经纯 updater 推进：
 * resetKey 变了游标按 0 算（新一轮从零打），没变就接着走——
 * 「流式块 → 正式消息」换场时组件不换、key 不换，曲线自然续上。
 * 追平后 effect 不再排帧；新目标到达（target 变化）时自动续跑。
 * 系统「减弱动态效果」开启时跳过动画直接显示全文。
 */
export function useSmoothText(target: string, options: SmoothTextOptions = {}): string {
  const { minCharsPerFrame = 1, catchUpFrames = 24, resetKey = null } = options
  const [reducedMotion] = useState(
    () =>
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  const [cursor, setCursor] = useState({ key: resetKey, at: 0 })
  const shownLength = cursor.key === resetKey ? cursor.at : 0

  useEffect(() => {
    if (reducedMotion) return
    const currentAt = cursor.key === resetKey ? cursor.at : 0
    if (currentAt >= target.length) return
    let raf = 0
    const tick = (): void => {
      setCursor((prev) => {
        const base = prev.key === resetKey ? prev.at : 0
        return { key: resetKey, at: nextShownLength(target, base, minCharsPerFrame, catchUpFrames) }
      })
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [target, resetKey, minCharsPerFrame, catchUpFrames, reducedMotion, cursor])

  return reducedMotion ? target : target.slice(0, shownLength)
}

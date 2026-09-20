import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseScrollAnchorReturn {
  containerRef: React.RefObject<HTMLDivElement | null>
  isAtBottom: boolean
  hasNewContentBelow: boolean
  scrollToBottom: (smooth?: boolean) => void
  notifyContentGrowth: () => void
}

/**
 * 智能防争抢滚动 Hook：
 * 1. 监控真实滚轮与触控，精准识别用户“主动上滑查看历史”的意图
 * 2. 当处于底部时，随流式内容自动平滑贴底
 * 3. 一旦用户主动上滑，立即冻结自动滚屏，并点亮未读新内容指示器
 * 4. 提供一键平滑回到底部的动作
 */
export function useScrollAnchor(): UseScrollAnchorReturn {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [hasNewContentBelow, setHasNewContentBelow] = useState(false)
  const userScrolledUpRef = useRef(false)

  const checkIsAtBottom = useCallback(() => {
    const el = containerRef.current
    if (!el) return true
    const threshold = 48
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
  }, [])

  const scrollToBottom = useCallback((smooth = true) => {
    const el = containerRef.current
    if (!el) return
    userScrolledUpRef.current = false
    setIsAtBottom(true)
    setHasNewContentBelow(false)
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto'
    })
  }, [])

  // 监听真实用户交互（wheel / touchmove），不依赖可被程序触发的 scroll 事件做判断
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const handleUserScroll = (): void => {
      const atBottom = checkIsAtBottom()
      setIsAtBottom(atBottom)
      if (!atBottom) {
        userScrolledUpRef.current = true
      } else {
        userScrolledUpRef.current = false
        setHasNewContentBelow(false)
      }
    }

    el.addEventListener('wheel', handleUserScroll, { passive: true })
    el.addEventListener('touchmove', handleUserScroll, { passive: true })
    return () => {
      el.removeEventListener('wheel', handleUserScroll)
      el.removeEventListener('touchmove', handleUserScroll)
    }
  }, [checkIsAtBottom])

  // 当外部流式内容发生增量变化时调用
  const notifyContentGrowth = useCallback(() => {
    if (!userScrolledUpRef.current) {
      const el = containerRef.current
      if (el) {
        el.scrollTop = el.scrollHeight
        setIsAtBottom(true)
      }
    } else {
      setHasNewContentBelow(true)
    }
  }, [])

  return {
    containerRef,
    isAtBottom,
    hasNewContentBelow,
    scrollToBottom,
    notifyContentGrowth
  }
}

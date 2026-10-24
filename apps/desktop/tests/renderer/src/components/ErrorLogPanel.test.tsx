import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorLogPanel } from '../../../../src/renderer/src/components/ErrorLogPanel'
import type { LogGroupView } from '../../../../src/shared/ipc-contract'

const RESET_REASON = '用户在错误日志面板人工确认恢复试探'

const GROUPS: LogGroupView[] = [
  {
    fingerprint: 'fp-old',
    level: 'error',
    source: 'python',
    event: 'agent.rejected',
    message: '较早任务的熔断错误',
    count: 3,
    firstTs: '2026-10-23T08:00:00.000Z',
    lastTs: '2026-10-23T09:00:00.000Z',
    sampleId: 'rec-old',
    taskId: 'task-old-aaaa'
  },
  {
    fingerprint: 'fp-new',
    level: 'error',
    source: 'python',
    event: 'agent.rejected',
    message: '最新任务的熔断错误',
    count: 5,
    firstTs: '2026-10-24T10:00:00.000Z',
    lastTs: '2026-10-24T12:00:00.000Z',
    sampleId: 'rec-new',
    taskId: 'task-new-cccc'
  },
  {
    fingerprint: 'fp-notask',
    level: 'warn',
    source: 'main',
    event: 'main.warning',
    message: '不带 taskId 的主进程错误',
    count: 1,
    firstTs: '2026-10-24T13:00:00.000Z',
    lastTs: '2026-10-24T13:30:00.000Z',
    sampleId: 'rec-notask'
  }
]

interface DispatcherControl {
  reset: () => void
  clear: () => void
}

/**
 * 与 SubagentStepCard.test.tsx 同款手写 hook 分发器：vitest 环境保持 node（无 jsdom），
 * 直接调用组件函数并持久化 useState，使「点击 → 反馈」链路可断言。
 */
function setupDispatcher(): DispatcherControl {
  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
        H: Record<string, unknown>
      }
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE

  const stateMap = new Map<number, unknown>()
  let hookIndex = 0

  internals.H = {
    useState: (initial: unknown): [unknown, (next: unknown) => void] => {
      const idx = hookIndex++
      if (!stateMap.has(idx)) {
        stateMap.set(idx, typeof initial === 'function' ? (initial as () => unknown)() : initial)
      }
      const setState = (next: unknown): void => {
        const current = stateMap.get(idx)
        stateMap.set(
          idx,
          typeof next === 'function' ? (next as (c: unknown) => unknown)(current) : next
        )
      }
      return [stateMap.get(idx), setState]
    },
    useCallback: (cb: () => unknown): unknown => cb,
    // 挂载加载 effect 不跑：分组数据统一经「刷新」按钮灌入，测试完全可控。
    useEffect: (): void => {}
  }

  return {
    reset: (): void => {
      hookIndex = 0
    },
    clear: (): void => {
      stateMap.clear()
      hookIndex = 0
    }
  }
}

/** React 19 的 ReactElement.props 默认 unknown：树遍历统一收窄到按钮关心的字段。 */
interface ButtonLikeProps {
  children?: React.ReactNode
  onClick: () => void
  disabled?: boolean
  title?: string
}

function collectElements(
  node: React.ReactNode,
  out: React.ReactElement<ButtonLikeProps>[] = []
): React.ReactElement<ButtonLikeProps>[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectElements(child as React.ReactNode, out)
    }
    return out
  }
  if (!React.isValidElement(node)) return out
  out.push(node as React.ReactElement<ButtonLikeProps>)
  const children = (node.props as { children?: unknown }).children
  if (children !== null && children !== undefined) {
    collectElements(children as React.ReactNode, out)
  }
  return out
}

function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    return node.map((child) => textOf(child as React.ReactNode)).join('')
  }
  if (React.isValidElement(node)) {
    const children = (node.props as { children?: unknown }).children
    return textOf((children ?? null) as React.ReactNode)
  }
  return ''
}

/** 在组件函数直调返回的树里按可见文案找函数组件按钮（操作区 Button 均为函数组件）。 */
function findButtonByText(
  tree: React.ReactElement,
  label: string
): React.ReactElement<ButtonLikeProps> | undefined {
  return collectElements(tree).find(
    (el) => typeof el.type === 'function' && textOf(el.props.children).includes(label)
  )
}

function renderPanel(dispatcher: DispatcherControl): React.ReactElement {
  dispatcher.reset()
  return ErrorLogPanel()
}

async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve()
  }
}

/** 经「刷新」按钮把分组数据灌入组件状态，返回灌入后的新树。 */
async function loadGroupsViaRefresh(dispatcher: DispatcherControl): Promise<React.ReactElement> {
  const tree = renderPanel(dispatcher)
  const refreshBtn = findButtonByText(tree, '刷新')
  if (!refreshBtn) throw new Error('找不到刷新按钮')
  refreshBtn.props.onClick()
  await flushMicrotasks()
  return renderPanel(dispatcher)
}

describe('ErrorLogPanel 重置熔断入口', () => {
  let groupLogsMock: ReturnType<typeof vi.fn>
  let listLogsMock: ReturnType<typeof vi.fn>
  let resetCircuitBreakerMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    groupLogsMock = vi.fn()
    listLogsMock = vi.fn()
    resetCircuitBreakerMock = vi.fn()
    vi.stubGlobal('window', {
      personalAgent: {
        groupLogs: groupLogsMock,
        listLogs: listLogsMock,
        resetCircuitBreaker: resetCircuitBreakerMock
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('操作区渲染「重置熔断」入口；初始无可重置任务时禁用并给出提示', () => {
    const html = renderToStaticMarkup(<ErrorLogPanel />)
    expect(html).toContain('重置熔断')
    // busy=false 时刷新/导出/清空均可用，初始只有「重置熔断」因缺 taskId 目标而禁用
    expect(html).toContain('disabled=""')
    expect(html).toContain('无法定位要重置的熔断任务')
  })

  it('点击后以最近带 taskId 的错误分组调用 resetCircuitBreaker，并渲染成功反馈', async () => {
    groupLogsMock.mockResolvedValue({ ok: true, groups: GROUPS })
    listLogsMock.mockResolvedValue({ ok: true, records: [] })
    resetCircuitBreakerMock.mockResolvedValue({
      ok: true,
      state: 'HALF_OPEN',
      message: '任务 task-new-cccc 的熔断器已复位为 HALF_OPEN 状态，允许下一次调用试探执行'
    })

    const dispatcher = setupDispatcher()
    dispatcher.clear()
    const tree = await loadGroupsViaRefresh(dispatcher)

    const resetBtn = findButtonByText(tree, '重置熔断')
    if (!resetBtn) throw new Error('找不到重置熔断按钮')
    expect(resetBtn.props.disabled).toBe(false)

    resetBtn.props.onClick()
    await flushMicrotasks()

    expect(resetCircuitBreakerMock).toHaveBeenCalledTimes(1)
    expect(resetCircuitBreakerMock).toHaveBeenCalledWith('task-new-cccc', RESET_REASON)

    // 状态断言走直调树文本（Fizz 渲染会换掉 hook 分发器，带不上测试态）
    const reloaded = renderPanel(dispatcher)
    expect(textOf(reloaded)).toContain(
      '已重置熔断：任务 task-new-cccc 的熔断器已复位为 HALF_OPEN 状态，允许下一次调用试探执行'
    )
  })

  it('熔断器返回 ok:false 时渲染失败反馈', async () => {
    groupLogsMock.mockResolvedValue({ ok: true, groups: GROUPS })
    listLogsMock.mockResolvedValue({ ok: true, records: [] })
    resetCircuitBreakerMock.mockResolvedValue({
      ok: false,
      state: 'OPEN',
      message: 'taskId 必须为非空字符串'
    })

    const dispatcher = setupDispatcher()
    dispatcher.clear()
    const tree = await loadGroupsViaRefresh(dispatcher)

    const resetBtn = findButtonByText(tree, '重置熔断')
    if (!resetBtn) throw new Error('找不到重置熔断按钮')
    resetBtn.props.onClick()
    await flushMicrotasks()

    expect(resetCircuitBreakerMock).toHaveBeenCalledTimes(1)
    expect(textOf(renderPanel(dispatcher))).toContain('重置失败：taskId 必须为非空字符串')
  })

  it('preload 调用抛异常时渲染失败反馈', async () => {
    groupLogsMock.mockResolvedValue({ ok: true, groups: GROUPS })
    listLogsMock.mockResolvedValue({ ok: true, records: [] })
    resetCircuitBreakerMock.mockRejectedValue(new Error('runtime 未运行'))

    const dispatcher = setupDispatcher()
    dispatcher.clear()
    const tree = await loadGroupsViaRefresh(dispatcher)

    const resetBtn = findButtonByText(tree, '重置熔断')
    if (!resetBtn) throw new Error('找不到重置熔断按钮')
    resetBtn.props.onClick()
    await flushMicrotasks()

    expect(textOf(renderPanel(dispatcher))).toContain('重置失败：runtime 未运行')
  })

  it('错误分组都不带 taskId 时按钮保持禁用且不发起调用', async () => {
    groupLogsMock.mockResolvedValue({ ok: true, groups: [GROUPS[2]] })
    listLogsMock.mockResolvedValue({ ok: true, records: [] })

    const dispatcher = setupDispatcher()
    dispatcher.clear()
    const tree = await loadGroupsViaRefresh(dispatcher)

    const resetBtn = findButtonByText(tree, '重置熔断')
    if (!resetBtn) throw new Error('找不到重置熔断按钮')
    expect(resetBtn.props.disabled).toBe(true)

    resetBtn.props.onClick()
    await flushMicrotasks()

    expect(resetCircuitBreakerMock).not.toHaveBeenCalled()
  })
})

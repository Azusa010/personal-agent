import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentStepCard } from '../../../../src/renderer/src/thought-chain/components/SubagentStepCard'
import type { ToolStepView } from '../../../../src/renderer/src/thought-chain/types'

// Mock clipboard
const mockWriteText = vi.fn().mockResolvedValue(undefined)
Object.assign(navigator, {
  clipboard: {
    writeText: mockWriteText
  }
})

interface DispatcherControl {
  reset: () => void
  clear: () => void
}

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
    useMemo: (cb: () => unknown): unknown => cb(),
    useCallback: (cb: () => unknown): unknown => cb(),
    useEffect: (): void => {},
    useRef: (init: unknown): { current: unknown } => ({ current: init })
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

function getCardHeader(tree: React.JSX.Element): React.JSX.Element {
  if (Array.isArray(tree.props.children)) {
    return tree.props.children[0]
  }
  const inner = tree.props.children as React.JSX.Element
  return Array.isArray(inner.props.children) ? inner.props.children[0] : inner.props.children
}

describe('SubagentStepCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('原型母体徽章映射 (Prototype Badges)', () => {
    it('正确解析 explore 原型并渲染蓝青色调指南针微徽章与静默内联无界行', () => {
      const step: ToolStepView = {
        id: 'step-1',
        type: 'tool',
        callId: 'call-1',
        capability: 'spawn_subagent',
        title: '调用工具: spawn_subagent',
        status: 'running',
        arguments: {
          role: 'CodeExplorer',
          goal: '检索核心依赖拓扑',
          prototype: 'explore'
        }
      }

      const html = renderToStaticMarkup(<SubagentStepCard step={step} />)
      expect(html).toContain('Explore')
      expect(html).toContain('text-blue-400')
      expect(html).toContain('border-blue-400/25')
      expect(html).toContain('shadow-[0_0_12px_rgba(59,130,246,0.15)]')
      // 验证无界去卡片化结构：不含厚重外壳托盘
      expect(html).not.toContain('rounded-xl ring-1')
      expect(html).not.toContain('bg-card')
      expect(html).toContain('tracking-[-0.015em]')
      expect(html).toContain('CodeExplorer')
      expect(html).toContain('检索核心依赖拓扑')
    })

    it('正确解析 plan 原型并渲染紫罗兰色调徽章', () => {
      const step: ToolStepView = {
        id: 'step-2',
        type: 'tool',
        callId: 'call-2',
        capability: 'spawn_subagent',
        title: '调用工具: spawn_subagent',
        status: 'success',
        arguments: {
          role: 'ArchitecturePlanner',
          goal: '制定分阶段重构蓝图',
          prototype: 'plan'
        }
      }

      const html = renderToStaticMarkup(<SubagentStepCard step={step} />)
      expect(html).toContain('Plan')
      expect(html).toContain('text-purple-400')
      expect(html).toContain('border-purple-400/25')
      expect(html).toContain('shadow-[0_0_12px_rgba(168,85,247,0.15)]')
      expect(html).toContain('ArchitecturePlanner')
    })

    it('缺省 prototype 时默认回退到 general 琥珀色调徽章', () => {
      const step: ToolStepView = {
        id: 'step-3',
        type: 'tool',
        callId: 'call-3',
        capability: 'spawn_subagent',
        title: '调用工具: spawn_subagent',
        status: 'success',
        arguments: {
          role: 'Worker',
          goal: '通用任务处理'
        }
      }

      const html = renderToStaticMarkup(<SubagentStepCard step={step} />)
      expect(html).toContain('General')
      expect(html).toContain('text-amber-400')
      expect(html).toContain('border-amber-400/25')
      expect(html).toContain('shadow-[0_0_12px_rgba(245,158,11,0.15)]')
      expect(html).toContain('Worker')
    })
  })

  describe('运行中状态 (Running State)', () => {
    it('呈现脉冲运行指示与步数，默认保持紧凑折叠', () => {
      const step: ToolStepView = {
        id: 'step-running',
        type: 'tool',
        callId: 'call-running',
        capability: 'spawn_subagent',
        title: '调用工具: spawn_subagent',
        status: 'running',
        arguments: {
          role: 'DependencyScanner',
          goal: '正在扫描项目包依赖结构',
          prototype: 'explore'
        },
        observation: {
          total_steps: 3
        }
      }

      const html = renderToStaticMarkup(<SubagentStepCard step={step} />)

      // 验证原型徽章
      expect(html).toContain('Explore')
      expect(html).toContain('text-blue-400')

      // 验证角色与目标
      expect(html).toContain('DependencyScanner')
      expect(html).toContain('正在扫描项目包依赖结构')

      // 验证运行中指示与步数
      expect(html).toContain('运行中')
      expect(html).toContain('3 步')

      // 验证默认紧凑折叠：aria-expanded="false"，且不展示展开区内容
      expect(html).toContain('aria-expanded="false"')
      expect(html).not.toContain('终局蒸馏结论')
    })
  })

  describe('执行完成状态 (Completed State)', () => {
    it('默认展开高亮终局蒸馏结论，渲染 Markdown 与耗时', () => {
      const step: ToolStepView = {
        id: 'step-completed',
        type: 'tool',
        callId: 'call-completed',
        capability: 'spawn_subagent',
        title: '调用工具: spawn_subagent',
        status: 'success',
        durationMs: 1800,
        arguments: {
          role: 'Architect',
          goal: '梳理模块架构',
          prototype: 'plan'
        },
        observation: {
          run_id: 'subagent-trace-101',
          summary: '### 架构审计结论\n\n1. **无循环依赖**\n2. 发现两处潜在内存泄漏',
          duration_ms: 1800
        }
      }

      const html = renderToStaticMarkup(<SubagentStepCard step={step} />)

      // 验证 Plan 原型与完成标签
      expect(html).toContain('Plan')
      expect(html).toContain('text-purple-400')
      expect(html).toContain('完成')

      // 验证耗时
      expect(html).toContain('1.8s')

      // 验证默认展开：aria-expanded="true"，且以微细淡线缩进展现（去卡片化）
      expect(html).toContain('aria-expanded="true"')
      expect(html).toContain('border-l border-border/50')
      expect(html).not.toContain('rounded-xl ring-1')
      expect(html).not.toContain('bg-card')

      // 验证蒸馏结论标题与 run_id
      expect(html).toContain('终局蒸馏结论')
      expect(html).toContain('subagent-trace-101')

      // 验证 MarkdownContent 渲染的富文本 (h3, strong 等)
      expect(html).toContain('架构审计结论')
      expect(html).toContain('无循环依赖')
      expect(html).toContain('潜在内存泄漏')
    })

    it('兼容 observation 为字符串的 JSON 解析', () => {
      const step: ToolStepView = {
        id: 'step-json-str',
        type: 'tool',
        callId: 'call-json-str',
        capability: 'spawn_subagent',
        title: '调用工具: spawn_subagent',
        status: 'success',
        arguments: { role: 'Auditor' },
        observation: JSON.stringify({
          run_id: 'subagent-str-888',
          summary: 'JSON 字符串反序列化结论',
          duration_ms: 450
        })
      }

      const html = renderToStaticMarkup(<SubagentStepCard step={step} />)
      expect(html).toContain('subagent-str-888')
      expect(html).toContain('JSON 字符串反序列化结论')
      expect(html).toContain('450ms')
    })
  })

  describe('执行失败状态 (Failed State)', () => {
    it('呈现失败状态与错误提示', () => {
      const step: ToolStepView = {
        id: 'step-failed',
        type: 'tool',
        callId: 'call-failed',
        capability: 'spawn_subagent',
        title: '调用工具: spawn_subagent',
        status: 'failed',
        durationMs: 320,
        arguments: {
          role: 'DockerBuilder',
          goal: '构建沙箱容器镜像',
          prototype: 'general'
        },
        error: {
          message: 'Docker daemon is not running'
        }
      }

      const html = renderToStaticMarkup(<SubagentStepCard step={step} />)

      expect(html).toContain('General')
      expect(html).toContain('text-amber-400')
      expect(html).toContain('失败')
      expect(html).toContain('320ms')
      expect(html).toContain('Docker daemon is not running')
      expect(html).toContain('aria-expanded="true"')
    })
  })

  describe('交互行为 (Interactions)', () => {
    it('点击卡片头部可自由折叠与展开', () => {
      const dispatcher = setupDispatcher()
      dispatcher.clear()

      const step: ToolStepView = {
        id: 'step-toggle',
        type: 'tool',
        callId: 'call-toggle',
        capability: 'spawn_subagent',
        title: '调用工具: spawn_subagent',
        status: 'success',
        arguments: { role: 'Tester', goal: '测试切换' },
        observation: { summary: '测试折叠内容' }
      }

      // 第 1 次渲染：success 默认展开 (isExpanded = true)
      dispatcher.reset()
      const tree1 = SubagentStepCard({ step }) as React.JSX.Element
      const header1 = getCardHeader(tree1)
      expect(header1.props['aria-expanded']).toBe(true)

      // 触发点击头部折叠
      header1.props.onClick()

      // 第 2 次渲染：应该已被折叠 (isExpanded = false)
      dispatcher.reset()
      const tree2 = SubagentStepCard({ step }) as React.JSX.Element
      const header2 = getCardHeader(tree2)
      expect(header2.props['aria-expanded']).toBe(false)

      // 再次点击头部展开
      header2.props.onClick()

      // 第 3 次渲染：应该恢复展开 (isExpanded = true)
      dispatcher.reset()
      const tree3 = SubagentStepCard({ step }) as React.JSX.Element
      const header3 = getCardHeader(tree3)
      expect(header3.props['aria-expanded']).toBe(true)
    })

    it('点击查看原始日志按钮触发 onInspectRaw 回调', () => {
      const dispatcher = setupDispatcher()
      dispatcher.clear()

      const step: ToolStepView = {
        id: 'step-inspect',
        type: 'tool',
        callId: 'call-inspect',
        capability: 'spawn_subagent',
        title: '调用工具: spawn_subagent',
        status: 'success',
        arguments: { role: 'Inspector', goal: '排查链路' }
      }

      const onInspectRawSpy = vi.fn()
      dispatcher.reset()
      const tree = SubagentStepCard({
        step,
        onInspectRaw: onInspectRawSpy
      }) as React.JSX.Element

      const header = getCardHeader(tree)
      const actionsDiv = header.props.children[4]
      const buttons = actionsDiv.props.children.filter(
        (c: unknown) =>
          c && typeof c === 'object' && 'type' in c && (c as { type: string }).type === 'button'
      )

      // 找到查看原始日志按钮
      const inspectBtn = buttons.find(
        (b: { props: { 'aria-label': string } }) => b.props['aria-label'] === '查看原始日志'
      )
      expect(inspectBtn).toBeDefined()

      const stopPropagation = vi.fn()
      inspectBtn.props.onClick({ stopPropagation })

      expect(stopPropagation).toHaveBeenCalled()
      expect(onInspectRawSpy).toHaveBeenCalledWith(step)
    })

    it('一键复制蒸馏结论并触发剪贴板写入与图标切换', async () => {
      const dispatcher = setupDispatcher()
      dispatcher.clear()

      const step: ToolStepView = {
        id: 'step-copy',
        type: 'tool',
        callId: 'call-copy',
        capability: 'spawn_subagent',
        title: '调用工具: spawn_subagent',
        status: 'success',
        arguments: { role: 'Reporter' },
        observation: { summary: '重要分析结论文本' }
      }

      dispatcher.reset()
      const tree = SubagentStepCard({ step }) as React.JSX.Element
      const header = getCardHeader(tree)
      const actionsDiv = header.props.children[4]
      const buttons = actionsDiv.props.children.filter(
        (c: unknown) =>
          c && typeof c === 'object' && 'type' in c && (c as { type: string }).type === 'button'
      )

      const copyBtn = buttons.find(
        (b: { props: { 'aria-label': string } }) => b.props['aria-label'] === '复制蒸馏结论'
      )
      expect(copyBtn).toBeDefined()

      const stopPropagation = vi.fn()
      await copyBtn.props.onClick({ stopPropagation })

      expect(stopPropagation).toHaveBeenCalled()
      expect(mockWriteText).toHaveBeenCalledWith('重要分析结论文本')
    })
  })
})

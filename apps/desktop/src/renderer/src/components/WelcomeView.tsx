import React, { useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import {
  Code,
  FileSearch,
  MessageSquare,
  Sparkles,
  Columns2,
  Bug,
  Edit2
} from 'lucide-react'
import type { BotView } from '../../../shared/ipc-contract'

export interface WelcomeViewProps {
  activeBot?: BotView | null
  onAction: (text: string) => void
  onEditBot?: (bot: BotView) => void
}

interface SuggestionItem {
  icon: React.JSX.Element
  text: string
  prompt: string
}

function getSuggestionsForBot(bot?: BotView | null): SuggestionItem[] {
  if (!bot) {
    return [
      {
        icon: <Sparkles size={18} />,
        text: '规划项目开发路线',
        prompt: '帮助我分步骤规划新项目的核心功能与开发路线。'
      },
      {
        icon: <Code size={18} />,
        text: '编写高内聚组件',
        prompt: '编写一个遵循规范的高内聚 TypeScript 组件与完备单元测试。'
      },
      {
        icon: <FileSearch size={18} />,
        text: '本地知识库检索与研读',
        prompt: '请对当前索引里的 PDF 文档做深入研读与关键信息提取。'
      },
      {
        icon: <MessageSquare size={18} />,
        text: '方案构思与头脑风暴',
        prompt: '针对当前业务需求开展头脑风暴并输出可落地的架构建议。'
      }
    ]
  }

  const identity = `${bot.name} ${bot.description} ${bot.persona}`.toLowerCase()

  if (
    identity.includes('代码') ||
    identity.includes('code') ||
    identity.includes('极客') ||
    identity.includes('编程') ||
    identity.includes('开发')
  ) {
    return [
      {
        icon: <Code size={18} />,
        text: '代码审计与重构建议',
        prompt: '请审查我的一段核心代码，指出潜在性能陷阱并给出优雅重构方案。'
      },
      {
        icon: <Bug size={18} />,
        text: '异常报错诊断排查',
        prompt: '分析最近一次的异常报错堆栈，指出根本原因并提供最小修复补丁。'
      },
      {
        icon: <Sparkles size={18} />,
        text: '架构设计与契约规划',
        prompt: '为新功能设计模块划分、接口契约与单向数据流转图。'
      },
      {
        icon: <MessageSquare size={18} />,
        text: '算法实现与复杂度优化',
        prompt: '针对特定业务逻辑设计纯函数算法，降低时空复杂度并保证测试覆盖。'
      }
    ]
  }

  if (
    identity.includes('分析') ||
    identity.includes('analyst') ||
    identity.includes('研') ||
    identity.includes('数据') ||
    identity.includes('文档')
  ) {
    return [
      {
        icon: <FileSearch size={18} />,
        text: '关键条款与商业风险提取',
        prompt: '请提取当前索引合同或技术文档中的关键条款、责任边界与潜在风险点。'
      },
      {
        icon: <Columns2 size={18} />,
        text: '多份文档横向差异对比',
        prompt: '对比索引中多份 PDF 文件的核心指标、约定与条款差异。'
      },
      {
        icon: <Sparkles size={18} />,
        text: '全库深度研读摘要报告',
        prompt: '对当前索引的全部业务与技术文档生成结构化深度研读报告。'
      },
      {
        icon: <MessageSquare size={18} />,
        text: '业务决策与可行性评估',
        prompt: '评估当前方案的权衡利弊与潜在瓶颈，给出清晰的决策参考。'
      }
    ]
  }

  // 通用自定义智能体
  return [
    {
      icon: <Sparkles size={18} />,
      text: '规划任务实施步骤',
      prompt: `作为${bot.name}，请帮助我分步骤规划新任务的实施细节。`
    },
    {
      icon: <FileSearch size={18} />,
      text: '本地知识库查阅与分析',
      prompt: '请查阅当前本地索引中的知识库，并回答相关专业问题。'
    },
    {
      icon: <MessageSquare size={18} />,
      text: '专业探讨与建议',
      prompt: `结合你的专业人设，为我当前的场景提供建议。`
    },
    {
      icon: <Code size={18} />,
      text: '撰写专业产出',
      prompt: '协助我撰写高质量的方案、文档或执行清单。'
    }
  ]
}

export function WelcomeView({
  activeBot,
  onAction,
  onEditBot
}: WelcomeViewProps): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      const tl = gsap.timeline()

      // 1. Entrance animation for the hero greeting
      tl.fromTo(
        '.hero-greeting',
        {
          opacity: 0,
          y: 24,
          scale: 0.96,
          filter: 'blur(8px)'
        },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          filter: 'blur(0px)',
          duration: 0.8,
          ease: 'power3.out'
        }
      )

      // 2. Staggered entrance for the suggestion chips
      tl.fromTo(
        '.suggestion-chip',
        {
          opacity: 0,
          y: 16
        },
        {
          opacity: 1,
          y: 0,
          duration: 0.5,
          stagger: 0.08,
          ease: 'back.out(1.2)'
        },
        '-=0.4'
      )
    },
    { scope: container, dependencies: [activeBot?.id] }
  )

  const handleMagnetic = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    const x = e.clientX - rect.left - rect.width / 2
    const y = e.clientY - rect.top - rect.height / 2

    gsap.to(el, {
      x: x * 0.1,
      y: y * 0.1,
      scale: 1.02,
      duration: 0.3,
      ease: 'power2.out'
    })
  }

  const handleMouseLeave = (e: React.MouseEvent<HTMLButtonElement>): void => {
    gsap.to(e.currentTarget, {
      x: 0,
      y: 0,
      scale: 1,
      duration: 0.5,
      ease: 'elastic.out(1, 0.3)'
    })
  }

  const suggestions = getSuggestionsForBot(activeBot)

  const greetingTitle = activeBot ? `你好，我是 ${activeBot.name}` : 'How can I help you today?'
  const greetingSubtitle = activeBot
    ? activeBot.description || activeBot.persona.slice(0, 100) || '你的专属智能体伴侣'
    : 'Your local, private AI agent is ready.'

  return (
    <div
      ref={container}
      className="relative flex min-h-0 w-full flex-1 flex-col items-center justify-center overflow-y-auto bg-background px-6 py-6 text-foreground"
    >
      {/* Centered Hero Greeting */}
      <div className="hero-greeting mb-8 max-w-2xl text-center">
        {activeBot && (
          <div className="mb-4 inline-flex items-center gap-2">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-secondary text-3xl shadow-xs">
              {activeBot.avatar || '🤖'}
            </span>
          </div>
        )}
        <div className="flex items-center justify-center gap-2">
          <h1 className="mb-2 text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            {greetingTitle}
          </h1>
          {activeBot && onEditBot && (
            <button
              type="button"
              title="修改人设"
              onClick={() => onEditBot(activeBot)}
              className="mb-2 rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
            >
              <Edit2 size={16} />
            </button>
          )}
        </div>
        <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
          {greetingSubtitle}
        </p>
      </div>

      {/* Suggestion Chips Grid */}
      <div className="grid w-full max-w-2xl grid-cols-1 gap-3 md:grid-cols-2">
        {suggestions.map((item, idx) => (
          <button
            key={idx}
            className="suggestion-chip flex items-center gap-3 rounded-2xl border border-border bg-card p-4 text-left transition-colors duration-200 hover:bg-secondary"
            onMouseMove={handleMagnetic}
            onMouseLeave={handleMouseLeave}
            onClick={() => onAction(item.prompt)}
          >
            <div className="flex-shrink-0 text-muted-foreground">{item.icon}</div>
            <span className="text-sm font-medium text-card-foreground">{item.text}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

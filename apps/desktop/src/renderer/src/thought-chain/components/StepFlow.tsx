import { useState } from 'react'
import { Check, Clock, LoaderCircle, X } from 'lucide-react'
import type { FlowLine } from '../flow'
import { cn } from '@renderer/lib/utils'
import { RawSpanDialog } from './RawSpanDialog'

const ICONS = {
  success: Check,
  running: LoaderCircle,
  pending: Clock,
  failed: X
} as const

const ICON_TONE: Record<FlowLine['status'], string> = {
  success: 'text-[#c9c9ce]',
  running: 'text-[#4f46e5]',
  pending: 'text-[#b45309]',
  failed: 'text-[#be123c]'
}

export interface StepFlowProps {
  lines: FlowLine[]
  className?: string
}

/**
 * 执行叙述：一行一件事，没有容器、没有竖线。
 * 状态只用行首那颗 11px 图标和行尾工具的深浅来表达——
 * 成功是浅灰对勾、进行中是靛蓝转圈、待批准是琥珀时钟、失败是红叉。
 */
export function StepFlow({ lines, className }: StepFlowProps): React.JSX.Element | null {
  const [inspect, setInspect] = useState<FlowLine | null>(null)

  if (lines.length === 0) return null

  return (
    <div className={cn('mb-2.5 flex flex-col', className)}>
      {lines.map((line) => {
        const Icon = ICONS[line.status]
        const clickable = line.step.rawPayload !== undefined
        return (
          <div
            key={line.id}
            role={clickable ? 'button' : undefined}
            title={clickable ? '查看这一步的原始参数' : undefined}
            onClick={clickable ? () => setInspect(line) : undefined}
            className={cn(
              'flex items-start gap-2.5 text-[13.5px] leading-[1.78] text-[#27272a]',
              line.status === 'running' &&
                '-mx-2 rounded-[7px] bg-linear-to-r from-[#eef2ff]/80 to-transparent px-2',
              clickable && 'cursor-pointer'
            )}
          >
            <span className={cn('mt-[7px] shrink-0', ICON_TONE[line.status])}>
              <Icon
                size={11}
                strokeWidth={2.4}
                className={line.status === 'running' ? 'animate-spin' : undefined}
              />
            </span>
            <span className={cn('min-w-0', line.status === 'failed' && 'text-[#3f3f46]')}>
              {line.text}
            </span>
            {line.cap !== undefined && (
              <code className="ml-auto shrink-0 self-center pl-2.5 font-mono text-[9.5px] leading-none text-[#d4d4da]">
                {line.cap}
              </code>
            )}
          </div>
        )
      })}
      <RawSpanDialog
        step={inspect?.step ?? null}
        open={inspect !== null}
        onOpenChange={(open) => {
          if (!open) setInspect(null)
        }}
      />
    </div>
  )
}

import React, { useState } from 'react'
import { CheckCircle2, ShieldCheck, Wand2 } from 'lucide-react'
import type { A2UICardView } from '../../a2ui/derive-cards'
import { A2UIRenderer } from './A2UIRenderer'

export interface A2UIInlineCardProps {
  card: A2UICardView
  onSubmit: (renderId: string, actionId: string, formData: Record<string, unknown>) => Promise<void>
  onClose?: () => void
}

/**
 * A2UI 卡片：直接长在对话流里，不弹窗。
 *
 * 嵌在所属位置（活卡在当前流式块后，历史卡在其 assistant 消息后）。
 * 交互边界 = status：rendered 的卡永远可填（含任务已结束的「稍后补填」，
 * 提交仍会触发 sendMessage 续跑）；submitted 后转只读快照，展示当时所填。
 */
export function A2UIInlineCard({
  card,
  onSubmit,
  onClose
}: A2UIInlineCardProps): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false)

  const submitted = card.status === 'submitted'
  const readOnly = submitted || submitting

  const handleAction = async (
    actionId: string,
    formData: Record<string, unknown>
  ): Promise<void> => {
    setSubmitting(true)
    try {
      await onSubmit(card.renderId, actionId, formData)
    } finally {
      setSubmitting(false)
    }
  }

  const componentCount = card.document.components.length
  const title = card.document.title ?? '智能体卡片'

  return (
    <div className="overflow-hidden rounded-[12px] border border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
        <Wand2 size={13} className="shrink-0 text-info" />
        <span className="text-[12px] font-medium text-foreground">{title}</span>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          {componentCount} 个受信组件
        </span>
        {card.version > 0 && (
          <span className="rounded-full border border-border bg-muted px-2 py-[1px] font-mono text-[10px] text-muted-foreground">
            v{card.version}
          </span>
        )}
        {submitted ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-[1px] text-[10px] font-medium text-muted-foreground">
            <CheckCircle2 size={10} />
            已提交
          </span>
        ) : (
          <>
            <span className="ml-auto rounded-full border border-info/25 bg-info/10 px-2 py-[1px] text-[10px] font-medium text-info">
              待填写
            </span>
            {onClose !== undefined && (
              <button
                type="button"
                aria-label="关闭卡片"
                onClick={onClose}
                className="grid size-[18px] place-items-center rounded text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
              >
                <span aria-hidden="true" className="text-[13px] leading-none">
                  ×
                </span>
              </button>
            )}
          </>
        )}
      </div>

      <div className="px-3 pb-1 pt-3">
        <A2UIRenderer
          document={card.document}
          initialValues={card.submittedFormData}
          onAction={(actionId, values) => void handleAction(actionId, values)}
          readOnly={readOnly}
          hideTitle
          bare
          className="text-[12.5px]"
        />
      </div>

      <div className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-[10.5px] text-muted-foreground">
        <ShieldCheck size={10} />
        字段由受信组件渲染 · 不执行脚本
      </div>
    </div>
  )
}

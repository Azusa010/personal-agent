import React, { useState } from 'react'
import { ShieldCheck, Wand2 } from 'lucide-react'
import type { A2UIRenderNotice } from '../../../../shared/ipc-contract'
import { A2UIRenderer } from './A2UIRenderer'

export interface A2UIInlineCardProps {
  render: A2UIRenderNotice | null
  onSubmit: (renderId: string, actionId: string, formData: Record<string, unknown>) => Promise<void>
  onClose?: () => void
}

/**
 * A2UI 表单：直接长在对话流里，不弹窗。
 *
 * 旧稿是 max-w-2xl 的模态对话框——缺三个字段就把整个界面盖住，
 * 用户既看不到上文也读不到自己刚说的话。新稿把它当成一条 assistant 内容：
 * 一条浅灰标题栏写清这是什么、由几个受信组件拼成，
 * 表单本身占正文宽度，提交后由 App 清掉通知、这里自然收起。
 */
export function A2UIInlineCard({
  render,
  onSubmit,
  onClose
}: A2UIInlineCardProps): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false)

  if (!render) {
    return <></>
  }

  const handleAction = async (
    actionId: string,
    formData: Record<string, unknown>
  ): Promise<void> => {
    setSubmitting(true)
    try {
      await onSubmit(render.renderId, actionId, formData)
    } finally {
      setSubmitting(false)
      onClose?.()
    }
  }

  const componentCount = render.document.components.length
  const title = render.document.title ?? '需要你补充几项'

  return (
    <div className="overflow-hidden rounded-[12px] border border-[#e8e8ea] bg-background">
      <div className="flex items-center gap-2 border-b border-[#f0f0f1] bg-[#fafafa] px-3 py-2">
        <Wand2 size={13} className="shrink-0 text-[#4f46e5]" />
        <span className="text-[12px] font-medium text-foreground">{title}</span>
        <span className="font-mono text-[10px] text-[#b3b3b8]">{componentCount} 个受信组件</span>
        <span className="ml-auto rounded-full border border-[#e0e7ff] bg-[#eef2ff] px-2 py-[1px] text-[10px] font-medium text-[#4338ca]">
          待填写
        </span>
      </div>

      <div className="px-3 pb-1 pt-3">
        <A2UIRenderer
          document={render.document}
          onAction={(actionId, values) => void handleAction(actionId, values)}
          readOnly={submitting}
          hideTitle
          bare
          className="text-[12.5px]"
        />
      </div>

      <div className="flex items-center gap-1.5 border-t border-[#f4f4f5] px-3 py-2 text-[10.5px] text-[#a1a1aa]">
        <ShieldCheck size={10} />
        字段由受信组件渲染 · 不执行脚本
      </div>
    </div>
  )
}

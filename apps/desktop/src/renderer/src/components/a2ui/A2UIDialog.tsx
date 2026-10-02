import React, { useState } from 'react'
import type { A2UIRenderNotice } from '../../../../shared/ipc-contract'
import { A2UIRenderer } from './A2UIRenderer'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

export interface A2UIDialogProps {
  render: A2UIRenderNotice | null
  onSubmit: (renderId: string, actionId: string, formData: Record<string, unknown>) => Promise<void>
  onClose?: () => void
}

export function A2UIDialog({ render, onSubmit, onClose }: A2UIDialogProps): React.JSX.Element {
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

  return (
    <Dialog
      open={render !== null}
      onOpenChange={(open) => {
        if (!open && !submitting) onClose?.()
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{render.document.title ?? '交互确认'}</DialogTitle>
          <DialogDescription>智能助理请求您确认或填写以下表单信息以继续任务。</DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <A2UIRenderer
            document={render.document}
            onAction={(actionId, values) => void handleAction(actionId, values)}
            readOnly={submitting}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

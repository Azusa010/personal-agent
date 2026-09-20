import React, { useState } from 'react'
import { Check, Copy, Download } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@renderer/components/ui/dialog'
import type { ThoughtChainStep } from '../types'

export interface RawSpanDialogProps {
  step: ThoughtChainStep | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export const RawSpanDialog: React.FC<RawSpanDialogProps> = ({ step, open, onOpenChange }) => {
  const [copied, setCopied] = useState(false)

  if (!step) return null

  const payloadString = JSON.stringify(step.rawPayload ?? step, null, 2)

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(payloadString)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  const handleDownload = (): void => {
    const blob = new Blob([payloadString], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `step-${step.id}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold flex items-center justify-between">
            <span>原始事件检视 · {step.title}</span>
            <div className="flex items-center gap-2 font-normal mr-6">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={handleCopy}
              >
                {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                <span>{copied ? '已复制' : '复制 JSON'}</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={handleDownload}
              >
                <Download size={12} />
                <span>导出</span>
              </Button>
            </div>
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            ID: {step.id} · 类型: {step.type} · 状态: {step.status}
            {step.durationMs !== undefined ? ` · 耗时: ${step.durationMs}ms` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 max-h-[60vh] overflow-y-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-[11px] text-foreground">
          <pre className="whitespace-pre-wrap break-all">{payloadString}</pre>
        </div>
      </DialogContent>
    </Dialog>
  )
}

import React from 'react'
import { ArrowDown } from 'lucide-react'

export interface ScrollPinButtonProps {
  visible: boolean
  onClick: () => void
}

export const ScrollPinButton: React.FC<ScrollPinButtonProps> = ({ visible, onClick }) => {
  if (!visible) return null

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="回到底部查看最新动态"
      className="absolute bottom-4 right-8 z-30 flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground shadow-md transition-all duration-150 hover:bg-primary/90 hover:scale-105 active:scale-95 animate-in fade-in slide-in-from-bottom-2"
    >
      <ArrowDown size={14} className="animate-bounce" />
      <span>有新动态</span>
    </button>
  )
}

import React, { useState } from 'react'
import type { A2UIComponent } from './types'

export function TabsLayout({
  childrenList,
  defaultIndex,
  renderChildren
}: {
  childrenList: A2UIComponent[]
  defaultIndex: number
  renderChildren: (children?: A2UIComponent[]) => React.ReactNode
}): React.JSX.Element {
  const [active, setActive] = useState(Math.min(defaultIndex, Math.max(0, childrenList.length - 1)))

  return (
    <div className="space-y-2">
      <div className="flex border-b border-border gap-1">
        {childrenList.map((c, idx) => {
          const tabTitle = (c.props?.['title'] as string) ?? c.id
          const isActive = idx === active
          return (
            <button
              type="button"
              key={c.id}
              onClick={() => setActive(idx)}
              className={`px-3 py-1.5 text-[12px] font-medium transition-colors border-b-2 -mb-px ${
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {tabTitle}
            </button>
          )
        })}
      </div>
      <div>{childrenList[active] ? renderChildren([childrenList[active]]) : null}</div>
    </div>
  )
}

export function AccordionLayout({
  title,
  items,
  renderChildren
}: {
  title: string
  items?: A2UIComponent[]
  renderChildren: (children?: A2UIComponent[]) => React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div className="rounded border border-border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between p-2.5 text-[12px] font-medium text-foreground hover:bg-muted/40"
      >
        <span>{title}</span>
        <span className="font-mono text-muted-foreground">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="border-t border-border p-3 space-y-2.5">{renderChildren(items)}</div>
      )}
    </div>
  )
}

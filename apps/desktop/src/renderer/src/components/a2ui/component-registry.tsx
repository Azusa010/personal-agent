import React from 'react'
import type { A2UIComponent, A2UIComponentRenderContext, A2UIComponentType } from './types'
import { isAllowedComponentType, sanitizeImageSrc, sanitizeProps } from './sanitize'
import { AccordionLayout, TabsLayout } from './containers'

export type ComponentRenderer = (
  comp: A2UIComponent,
  context: A2UIComponentRenderContext,
  renderChildren: (children?: A2UIComponent[]) => React.ReactNode
) => React.JSX.Element | null

export const COMPONENT_REGISTRY: Record<A2UIComponentType, ComponentRenderer> = {
  // --- 输入组件 (10) ---
  text_input: (comp, ctx) => {
    const props = sanitizeProps(comp.props ?? {})
    const label = (props['label'] as string) ?? ''
    const placeholder = (props['placeholder'] as string) ?? ''
    const val = (ctx.getValue(comp.id) as string) ?? ''

    return (
      <div key={comp.id} className="space-y-1.5 text-left">
        {label && <label className="text-[12px] font-medium text-foreground">{label}</label>}
        <input
          type="text"
          value={val}
          placeholder={placeholder}
          disabled={ctx.readOnly}
          onChange={(e) => ctx.setValue(comp.id, e.target.value)}
          className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-[13px] shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
    )
  },

  textarea: (comp, ctx) => {
    const props = sanitizeProps(comp.props ?? {})
    const label = (props['label'] as string) ?? ''
    const placeholder = (props['placeholder'] as string) ?? ''
    const rows = (props['rows'] as number) ?? 3
    const val = (ctx.getValue(comp.id) as string) ?? ''

    return (
      <div key={comp.id} className="space-y-1.5 text-left">
        {label && <label className="text-[12px] font-medium text-foreground">{label}</label>}
        <textarea
          rows={rows}
          value={val}
          placeholder={placeholder}
          disabled={ctx.readOnly}
          onChange={(e) => ctx.setValue(comp.id, e.target.value)}
          className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-[13px] shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
    )
  },

  number_input: (comp, ctx) => {
    const props = sanitizeProps(comp.props ?? {})
    const label = (props['label'] as string) ?? ''
    const min = props['min'] as number | undefined
    const max = props['max'] as number | undefined
    const step = props['step'] as number | undefined
    const val = (ctx.getValue(comp.id) as number) ?? min ?? 0

    return (
      <div key={comp.id} className="space-y-1.5 text-left">
        {label && <label className="text-[12px] font-medium text-foreground">{label}</label>}
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={val}
          disabled={ctx.readOnly}
          onChange={(e) => ctx.setValue(comp.id, Number(e.target.value))}
          className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-[13px] shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
    )
  },

  select: (comp, ctx) => {
    const props = sanitizeProps(comp.props ?? {})
    const label = (props['label'] as string) ?? ''
    const options = (props['options'] as Array<string | { label: string; value: string }>) ?? []
    const val = (ctx.getValue(comp.id) as string) ?? ''

    return (
      <div key={comp.id} className="space-y-1.5 text-left">
        {label && <label className="text-[12px] font-medium text-foreground">{label}</label>}
        <select
          value={val}
          disabled={ctx.readOnly}
          onChange={(e) => ctx.setValue(comp.id, e.target.value)}
          className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-[13px] shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {options.map((opt, i) => {
            const optVal = typeof opt === 'string' ? opt : opt.value
            const optLabel = typeof opt === 'string' ? opt : opt.label
            return (
              <option key={i} value={optVal}>
                {optLabel}
              </option>
            )
          })}
        </select>
      </div>
    )
  },

  multi_select: (comp, ctx) => {
    const props = sanitizeProps(comp.props ?? {})
    const label = (props['label'] as string) ?? ''
    const options = (props['options'] as Array<string | { label: string; value: string }>) ?? []
    const selected = (ctx.getValue(comp.id) as string[]) ?? []

    const toggle = (targetVal: string): void => {
      if (ctx.readOnly) return
      const next = selected.includes(targetVal)
        ? selected.filter((v) => v !== targetVal)
        : [...selected, targetVal]
      ctx.setValue(comp.id, next)
    }

    return (
      <div key={comp.id} className="space-y-1.5 text-left">
        {label && <label className="text-[12px] font-medium text-foreground">{label}</label>}
        <div className="flex flex-wrap gap-2 pt-1">
          {options.map((opt, i) => {
            const optVal = typeof opt === 'string' ? opt : opt.value
            const optLabel = typeof opt === 'string' ? opt : opt.label
            const isChecked = selected.includes(optVal)

            return (
              <button
                type="button"
                key={i}
                disabled={ctx.readOnly}
                onClick={() => toggle(optVal)}
                className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-[12px] transition-colors ${
                  isChecked
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'border-border bg-background text-muted-foreground hover:bg-muted/50'
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <span>{isChecked ? '✓' : '+'}</span>
                <span>{optLabel}</span>
              </button>
            )
          })}
        </div>
      </div>
    )
  },

  checkbox: (comp, ctx) => {
    const props = sanitizeProps(comp.props ?? {})
    const label = (props['label'] as string) ?? ''
    const checked = Boolean(ctx.getValue(comp.id))

    return (
      <div key={comp.id} className="flex items-center gap-2 pt-1">
        <input
          type="checkbox"
          id={comp.id}
          checked={checked}
          disabled={ctx.readOnly}
          onChange={(e) => ctx.setValue(comp.id, e.target.checked)}
          className="h-4 w-4 rounded border-border text-primary focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
        {label && (
          <label
            htmlFor={comp.id}
            className="text-[12px] font-medium text-foreground select-none cursor-pointer"
          >
            {label}
          </label>
        )}
      </div>
    )
  },

  radio_group: (comp, ctx) => {
    const props = sanitizeProps(comp.props ?? {})
    const label = (props['label'] as string) ?? ''
    const options = (props['options'] as Array<string | { label: string; value: string }>) ?? []
    const val = (ctx.getValue(comp.id) as string) ?? ''

    return (
      <div key={comp.id} className="space-y-1.5 text-left">
        {label && <label className="text-[12px] font-medium text-foreground">{label}</label>}
        <div className="flex flex-wrap gap-3 pt-1">
          {options.map((opt, i) => {
            const optVal = typeof opt === 'string' ? opt : opt.value
            const optLabel = typeof opt === 'string' ? opt : opt.label
            const isChecked = val === optVal

            return (
              <label
                key={i}
                className="flex items-center gap-1.5 text-[12px] cursor-pointer select-none"
              >
                <input
                  type="radio"
                  name={comp.id}
                  value={optVal}
                  checked={isChecked}
                  disabled={ctx.readOnly}
                  onChange={() => ctx.setValue(comp.id, optVal)}
                  className="h-3.5 w-3.5 border-border text-primary focus:ring-primary"
                />
                <span
                  className={isChecked ? 'text-foreground font-medium' : 'text-muted-foreground'}
                >
                  {optLabel}
                </span>
              </label>
            )
          })}
        </div>
      </div>
    )
  },

  date_picker: (comp, ctx) => {
    const props = sanitizeProps(comp.props ?? {})
    const label = (props['label'] as string) ?? ''
    const val = (ctx.getValue(comp.id) as string) ?? ''

    return (
      <div key={comp.id} className="space-y-1.5 text-left">
        {label && <label className="text-[12px] font-medium text-foreground">{label}</label>}
        <input
          type="date"
          value={val}
          disabled={ctx.readOnly}
          onChange={(e) => ctx.setValue(comp.id, e.target.value)}
          className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-[13px] shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
    )
  },

  file_picker: (comp, ctx) => {
    const props = sanitizeProps(comp.props ?? {})
    const label = (props['label'] as string) ?? ''
    const placeholder = (props['placeholder'] as string) ?? '选择或输入文件路径...'
    const val = (ctx.getValue(comp.id) as string) ?? ''

    return (
      <div key={comp.id} className="space-y-1.5 text-left">
        {label && <label className="text-[12px] font-medium text-foreground">{label}</label>}
        <div className="flex gap-2">
          <input
            type="text"
            value={val}
            placeholder={placeholder}
            disabled={ctx.readOnly}
            onChange={(e) => ctx.setValue(comp.id, e.target.value)}
            className="flex h-8 flex-1 rounded-md border border-input bg-background px-3 py-1 text-[13px] shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
      </div>
    )
  },

  slider: (comp, ctx) => {
    const props = sanitizeProps(comp.props ?? {})
    const label = (props['label'] as string) ?? ''
    const min = (props['min'] as number) ?? 0
    const max = (props['max'] as number) ?? 100
    const step = (props['step'] as number) ?? 1
    const val = (ctx.getValue(comp.id) as number) ?? min

    return (
      <div key={comp.id} className="space-y-1.5 text-left">
        <div className="flex justify-between items-center">
          {label && <label className="text-[12px] font-medium text-foreground">{label}</label>}
          <span className="font-mono text-[11px] text-muted-foreground">{val}</span>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={val}
          disabled={ctx.readOnly}
          onChange={(e) => ctx.setValue(comp.id, Number(e.target.value))}
          className="h-1.5 w-full cursor-pointer rounded-lg bg-secondary accent-primary"
        />
      </div>
    )
  },

  // --- 展示组件 (8) ---
  heading: (comp) => {
    const props = sanitizeProps(comp.props ?? {})
    const text = (props['text'] as string) ?? ''
    const level = (props['level'] as number) ?? 2

    if (level === 1)
      return (
        <h1 key={comp.id} className="text-lg font-bold tracking-tight text-foreground">
          {text}
        </h1>
      )
    if (level === 2)
      return (
        <h2 key={comp.id} className="text-base font-semibold tracking-tight text-foreground">
          {text}
        </h2>
      )
    if (level === 3)
      return (
        <h3 key={comp.id} className="text-sm font-medium tracking-tight text-foreground">
          {text}
        </h3>
      )
    return (
      <h4 key={comp.id} className="text-xs font-medium tracking-tight text-foreground">
        {text}
      </h4>
    )
  },

  paragraph: (comp) => {
    const props = sanitizeProps(comp.props ?? {})
    const text = (props['text'] as string) ?? ''
    return (
      <p key={comp.id} className="text-[13px] leading-relaxed text-muted-foreground">
        {text}
      </p>
    )
  },

  code_block: (comp) => {
    const props = sanitizeProps(comp.props ?? {})
    const code = (props['code'] as string) ?? ''
    const language = (props['language'] as string) ?? ''

    return (
      <div key={comp.id} className="rounded-md border border-border/60 bg-muted/40 p-2.5 text-left">
        {language && (
          <div className="mb-1 text-[10px] font-mono uppercase text-muted-foreground/70">
            {language}
          </div>
        )}
        <pre className="overflow-x-auto font-mono text-[12px] leading-5 text-foreground">
          <code>{code}</code>
        </pre>
      </div>
    )
  },

  table: (comp) => {
    const props = sanitizeProps(comp.props ?? {})
    const columns = (props['columns'] as string[]) ?? []
    const rows = (props['rows'] as Array<Array<string | number>>) ?? []

    return (
      <div key={comp.id} className="overflow-x-auto rounded border border-border text-left">
        <table className="w-full caption-bottom text-[12px]">
          <thead className="bg-muted/50 border-b border-border">
            <tr>
              {columns.map((col, idx) => (
                <th key={idx} className="h-8 px-3 text-left font-medium text-muted-foreground">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rIdx) => (
              <tr key={rIdx} className="border-b border-border/50 hover:bg-muted/30">
                {row.map((cell, cIdx) => (
                  <td key={cIdx} className="px-3 py-1.5 text-foreground">
                    {String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  },

  chart: (comp) => {
    const props = sanitizeProps(comp.props ?? {})
    const title = (props['title'] as string) ?? ''
    const data = (props['data'] as Array<{ time?: string; label?: string; value: number }>) ?? []
    const maxVal = Math.max(...data.map((d) => d.value), 1)

    return (
      <div
        key={comp.id}
        className="space-y-2 rounded-md border border-border bg-card p-3 text-left"
      >
        {title && <div className="text-[12px] font-medium text-foreground">{title}</div>}
        <div className="flex h-24 items-end gap-2 pt-2">
          {data.map((item, idx) => {
            const pct = Math.round((item.value / maxVal) * 100)
            const label = item.time ?? item.label ?? `${idx + 1}`
            return (
              <div key={idx} className="flex-1 flex flex-col items-center gap-1 h-full justify-end">
                <div
                  className="w-full bg-primary/70 rounded-t transition-all hover:bg-primary"
                  style={{ height: `${pct}%` }}
                  title={`${label}: ${item.value}`}
                />
                <span className="text-[9px] font-mono text-muted-foreground truncate w-full text-center">
                  {label}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    )
  },

  image: (comp) => {
    const props = sanitizeProps(comp.props ?? {})
    const safeSrc = sanitizeImageSrc(props['src'])
    const alt = (props['alt'] as string) ?? 'A2UI Image'

    if (!safeSrc) {
      return (
        <div
          key={comp.id}
          className="rounded border border-dashed border-border p-3 text-center text-[12px] text-muted-foreground"
        >
          [不可用或受限的图片资源]
        </div>
      )
    }

    return (
      <div key={comp.id} className="overflow-hidden rounded-md border border-border">
        <img src={safeSrc} alt={alt} className="max-h-64 max-w-full object-contain mx-auto" />
      </div>
    )
  },

  divider: (comp) => {
    return <hr key={comp.id} className="border-t border-border my-2" />
  },

  alert: (comp) => {
    const props = sanitizeProps(comp.props ?? {})
    const title = (props['title'] as string) ?? ''
    const message = (props['message'] as string) ?? ''
    const status = (props['status'] as string) ?? 'info'

    const colorClasses =
      status === 'success'
        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        : status === 'warning'
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
          : status === 'error'
            ? 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300'
            : 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300'

    return (
      <div key={comp.id} className={`rounded-md border p-3 text-left ${colorClasses}`}>
        {title && <div className="text-[12px] font-semibold">{title}</div>}
        {message && <div className="text-[11px] leading-relaxed mt-0.5 opacity-90">{message}</div>}
      </div>
    )
  },

  // --- 布局组件 (5) ---
  form: (comp, _, renderChildren) => {
    return (
      <form key={comp.id} onSubmit={(e) => e.preventDefault()} className="space-y-3">
        {renderChildren(comp.children)}
      </form>
    )
  },

  card: (comp, _, renderChildren) => {
    const props = sanitizeProps(comp.props ?? {})
    const title = (props['title'] as string) ?? ''
    const description = (props['description'] as string) ?? ''

    return (
      <div
        key={comp.id}
        className="rounded-lg border border-border bg-card p-4 space-y-3 text-left shadow-xs"
      >
        {(title || description) && (
          <div className="border-b border-border/60 pb-2.5">
            {title && <h3 className="text-sm font-semibold text-foreground">{title}</h3>}
            {description && (
              <p className="text-[12px] text-muted-foreground mt-0.5">{description}</p>
            )}
          </div>
        )}
        <div className="space-y-3">{renderChildren(comp.children)}</div>
      </div>
    )
  },

  tabs: (comp, _, renderChildren) => {
    const props = sanitizeProps(comp.props ?? {})
    const children = comp.children ?? []
    const defaultIndex = (props['defaultIndex'] as number) ?? 0

    return (
      <TabsLayout
        key={comp.id}
        childrenList={children}
        defaultIndex={defaultIndex}
        renderChildren={renderChildren}
      />
    )
  },

  grid: (comp, _, renderChildren) => {
    const props = sanitizeProps(comp.props ?? {})
    const cols = (props['cols'] as number) ?? 2
    const colsClass = cols === 3 ? 'grid-cols-3' : cols === 4 ? 'grid-cols-4' : 'grid-cols-2'

    return (
      <div key={comp.id} className={`grid gap-3 ${colsClass}`}>
        {renderChildren(comp.children)}
      </div>
    )
  },

  accordion: (comp, _, renderChildren) => {
    const props = sanitizeProps(comp.props ?? {})
    const title = (props['title'] as string) ?? '折叠面板'

    return (
      <AccordionLayout
        key={comp.id}
        title={title}
        items={comp.children}
        renderChildren={renderChildren}
      />
    )
  }
}

/**
 * 安全渲染单个 A2UI 组件
 */
export function renderA2UIComponent(
  comp: A2UIComponent,
  ctx: A2UIComponentRenderContext,
  renderChildren: (children?: A2UIComponent[]) => React.ReactNode
): React.JSX.Element | null {
  if (!isAllowedComponentType(comp.type)) {
    return null
  }

  const renderer = COMPONENT_REGISTRY[comp.type]
  if (!renderer) {
    return null
  }

  return renderer(comp, ctx, renderChildren)
}

import React, { useMemo, useState } from 'react'
import type {
  A2UIAction,
  A2UIComponent,
  A2UIComponentRenderContext,
  A2UIRendererProps
} from './types'
import { extractInitialFormValues, mergeFormValues } from './form-state'
import { renderA2UIComponent } from './component-registry'

export function A2UIRenderer({
  document,
  onAction,
  initialValues,
  readOnly = false,
  hideTitle = false,
  bare = false,
  className = ''
}: A2UIRendererProps): React.JSX.Element {
  const defaultValues = useMemo(() => {
    return initialValues ?? extractInitialFormValues(document.components)
  }, [initialValues, document.components])

  const [formValues, setFormValues] = useState<Record<string, unknown>>(() => ({
    ...defaultValues
  }))

  // 活卡更新：document 替换后，仅为新增组件 id 补初始值；存活 id 不动，保住用户已填内容。
  // React 官方「props 变化时在渲染期调整 state」模式（替代 effect 内 setState）。
  const [prevDefaults, setPrevDefaults] = useState(defaultValues)
  if (prevDefaults !== defaultValues) {
    setPrevDefaults(defaultValues)
    setFormValues((prev) => mergeFormValues(prev, defaultValues))
  }

  const renderContext: A2UIComponentRenderContext = useMemo(
    () => ({
      getValue: (id: string) => formValues[id],
      setValue: (id: string, value: unknown) => {
        setFormValues((prev) => ({ ...prev, [id]: value }))
      },
      readOnly
    }),
    [formValues, readOnly]
  )

  const renderChildren = (children?: A2UIComponent[]): React.ReactNode => {
    if (!children || children.length === 0) return null
    return children.map((child) => renderA2UIComponent(child, renderContext, renderChildren))
  }

  const handleAction = (action: A2UIAction): void => {
    onAction?.(action.id, formValues)
  }

  return (
    <div
      className={
        bare
          ? `space-y-3 text-card-foreground ${className}`
          : `space-y-4 rounded-[12px] border border-border bg-card p-4 text-card-foreground ${className}`
      }
    >
      {document.title && !hideTitle && (
        <div className="border-b border-border pb-3">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            {document.title}
          </h2>
        </div>
      )}

      <div className="space-y-3">
        {document.components.map((comp) =>
          renderA2UIComponent(comp, renderContext, renderChildren)
        )}
      </div>

      {document.actions && document.actions.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
          {document.actions.map((act) => {
            const isSubmit = act.type === 'submit'
            const isCancel = act.type === 'cancel'
            return (
              <button
                key={act.id}
                type="button"
                disabled={readOnly && isSubmit}
                onClick={() => handleAction(act)}
                className={`inline-flex items-center justify-center rounded-md px-3.5 py-1.5 text-[13px] font-medium shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 ${
                  isSubmit
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : isCancel
                      ? 'border border-input bg-background text-muted-foreground hover:bg-muted'
                      : 'border border-border bg-secondary text-secondary-foreground hover:bg-secondary/80'
                }`}
              >
                {act.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default A2UIRenderer

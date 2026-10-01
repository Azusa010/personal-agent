import {
  A2UI_INPUT_COMPONENT_TYPES,
  type A2UIAction,
  type A2UIActionType,
  type A2UIComponent,
  type A2UIComponentType,
  type A2UIDocument
} from '@personal-agent/protocol'

export type { A2UIAction, A2UIActionType, A2UIComponent, A2UIComponentType, A2UIDocument }

export const INPUT_COMPONENT_TYPES = A2UI_INPUT_COMPONENT_TYPES

export interface A2UIRendererProps {
  document: A2UIDocument
  onAction?: (actionId: string, formData: Record<string, unknown>) => void
  initialValues?: Record<string, unknown>
  readOnly?: boolean
  className?: string
}

export interface A2UIComponentRenderContext {
  getValue: (id: string) => unknown
  setValue: (id: string, value: unknown) => void
  readOnly: boolean
}

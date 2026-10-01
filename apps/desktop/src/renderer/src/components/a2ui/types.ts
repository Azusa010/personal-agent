import type {
  A2UIAction,
  A2UIActionType,
  A2UIComponent,
  A2UIComponentType,
  A2UIDocument
} from '@personal-agent/protocol'

export type { A2UIAction, A2UIActionType, A2UIComponent, A2UIComponentType, A2UIDocument }

export const INPUT_COMPONENT_TYPES = new Set<A2UIComponentType>([
  'text_input',
  'textarea',
  'number_input',
  'select',
  'multi_select',
  'checkbox',
  'radio_group',
  'date_picker',
  'file_picker',
  'slider'
])

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

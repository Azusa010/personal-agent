import { type A2UIComponent, INPUT_COMPONENT_TYPES } from './types'

export class FormStateManager {
  private values: Record<string, unknown>

  constructor(initialValues?: Record<string, unknown>) {
    this.values = { ...(initialValues ?? {}) }
  }

  getValue(id: string): unknown {
    return this.values[id]
  }

  setValue(id: string, value: unknown): void {
    this.values[id] = value
  }

  getAllValues(): Record<string, unknown> {
    return { ...this.values }
  }

  reset(initialValues?: Record<string, unknown>): void {
    this.values = { ...(initialValues ?? {}) }
  }
}

/**
 * 递归遍历 A2UI 组件树，提取所有输入型组件的初始表单值。
 *
 * 契约要求：
 * 1. 遍历 components 及其嵌套的 children。
 * 2. 当遇到 INPUT_COMPONENT_TYPES 集合中的输入型组件时：
 *    - 优先读取 component.props 中的 value、defaultValue 或 default 字段；
 *    - 若均未提供，则根据组件类型赋予安全默认值：
 *      - 'checkbox': false
 *      - 'multi_select': []
 *      - 'number_input' 或 'slider': (props?.min as number) ?? 0
 *      - 其他输入组件 ('text_input', 'textarea', 'select', 'radio_group', 'date_picker', 'file_picker'): ''
 *    - 记录到返回字典中：values[component.id] = initialValue。
 * 3. 遇到非输入型组件时，不记录其 id，但若含有 children，必须继续递归收集。
 * 4. 返回包含所有输入组件初始键值对的 Record<string, unknown>。
 *
 * 对应验收测试：tests/renderer/src/a2ui/form-state.test.ts
 */
export function extractInitialFormValues(components: A2UIComponent[]): Record<string, unknown> {
  let values: Record<string, unknown> = {}
  for (const component of components) {
    if (INPUT_COMPONENT_TYPES.has(component.type)) {
      const props = component.props ?? {}
      let initialValue: unknown

      if ('value' in props) {
        initialValue = props.value
      } else if ('defaultValue' in props) {
        initialValue = props.defaultValue
      } else if ('default' in props) {
        initialValue = props.default
      } else {
        // 根据组件类型赋予安全默认值
        switch (component.type) {
          case 'checkbox':
            initialValue = false
            break
          case 'multi_select':
            initialValue = []
            break
          case 'number_input':
          case 'slider':
            initialValue = (props.min as number) ?? 0
            break
          default:
            initialValue = ''
        }
      }
      values[component.id] = initialValue
    }
    if (component.children && component.children.length > 0) {
      const childValues = extractInitialFormValues(component.children)
      values = { ...values, ...childValues }
    }
  }
  return values
}

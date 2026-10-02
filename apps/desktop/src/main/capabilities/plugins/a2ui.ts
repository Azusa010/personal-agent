import { randomUUID } from 'node:crypto'
import {
  A2UI_INPUT_COMPONENT_TYPES,
  A2UIComponent,
  A2UIComponentType,
  A2UIDocument,
  A2UIRenderParams,
  ERROR_CODE,
  normalizeA2UIRenderParams
} from '@personal-agent/protocol'
import type { CapabilityPlugin } from '../plugin'
import type { A2UIRenderNotice } from '../../../shared/ipc-contract'
import { invalid } from './helpers'

export const A2UI_RENDERED_EVENT = 'a2ui_rendered'
export const A2UI_SUBMITTED_EVENT = 'a2ui_submitted'

export interface ActiveA2UIRender {
  renderId: string
  taskId: string
  callId: string
  document: A2UIDocument
  status: 'rendered' | 'submitted' | 'cancelled'
  createdAt: string
  submittedAt?: string
  actionId?: string
  formData?: Record<string, unknown>
}

export type { A2UIRenderNotice }

export type A2UIRenderListener = (notice: A2UIRenderNotice) => void
const renderListeners: Set<A2UIRenderListener> = new Set()

export function onA2UIRender(listener: A2UIRenderListener): () => void {
  renderListeners.add(listener)
  return () => {
    renderListeners.delete(listener)
  }
}

export function clearA2UIRenderListeners(): void {
  renderListeners.clear()
}

const activeRenders = new Map<string, ActiveA2UIRender>()

export function recordA2UIRender(render: ActiveA2UIRender): void {
  activeRenders.set(render.renderId, render)
}

export function getA2UIRender(renderId: string): ActiveA2UIRender | undefined {
  return activeRenders.get(renderId)
}

export function listA2UIRenders(taskId?: string): ActiveA2UIRender[] {
  const list = Array.from(activeRenders.values())
  if (taskId) {
    return list.filter((r) => r.taskId === taskId)
  }
  return list
}

export function submitA2UIForm(
  renderId: string,
  actionId: string,
  formData: Record<string, unknown>,
  events?: {
    append: (ev: { taskId: string; type: string; payload: unknown; occurredAt: string }) => void
  },
  now?: () => string
): boolean {
  const render = activeRenders.get(renderId)
  if (!render) return false
  render.status = 'submitted'
  render.actionId = actionId
  render.formData = { ...formData }
  const stamp = now?.() ?? new Date().toISOString()
  render.submittedAt = stamp
  if (events) {
    events.append({
      taskId: render.taskId,
      type: A2UI_SUBMITTED_EVENT,
      payload: {
        renderId,
        actionId,
        formData
      },
      occurredAt: stamp
    })
  }
  return true
}

export function clearA2UIRenders(): void {
  activeRenders.clear()
}

/**
 * 将 A2UI 表单文档与用户提交的表单数据转换为结构化的自然语言/Markdown 摘要。
 *
 * 契约要求：
 * 1. 若 actionId 为 'cancel' 或包含取消类动作，返回：
 *    `【用户取消了表单交互】(action: ${actionId})`
 * 2. 若为正常提交：
 *    - 首行输出：`【表单提交结果】${document.title ? `: ${document.title}` : ''}`
 *    - 递归遍历 document.components 中的所有输入型组件（A2UI_INPUT_COMPONENT_TYPES）：
 *      - 读取组件显示标签：优先取 `component.props?.label as string`，若无或为空串则回退为 `component.id`；
 *      - 从 formData 中读取对应 `component.id` 的用户输入值 `val = formData[component.id]`；
 *      - 值格式化规则：
 *        - 若 `val` 为 boolean：`true` 格式化为 `'是'`，`false` 格式化为 `'否'`；
 *        - 若 `val` 为数组（如 multi_select）：若数组为空输出 `'(无)'`，否则用 `', '` 拼接；
 *        - 若 `val === undefined || val === null || val === ''`：输出 `'(空)'`；
 *        - 其余类型输出 `String(val)`；
 *      - 每一项格式化为一行：`- ${label}: ${formattedValue}`。
 * 3. 行与行之间使用 `\n` 换行拼接。
 *
 * 对应验收测试：tests/main/e2e/a2ui-form-clarification.test.ts
 */
export function isCancelAction(actionId: string): boolean {
  const norm = actionId.trim().toLowerCase()
  return (
    norm === 'cancel' ||
    norm.startsWith('cancel') ||
    norm.endsWith('cancel') ||
    norm.includes('cancel') ||
    norm.includes('abort') ||
    norm.includes('dismiss')
  )
}

export function formatA2UIFormSubmission(
  document: A2UIDocument,
  formData: Record<string, unknown>,
  actionId: string
): string {
  if (isCancelAction(actionId)) {
    return `【用户取消了表单交互】(action: ${actionId})`
  }
  let summary = `【表单提交结果】${document.title ? `: ${document.title}` : ''}`
  const lines: string[] = []
  function traverse(components: A2UIComponent[]): void {
    for (const component of components) {
      if (A2UI_INPUT_COMPONENT_TYPES.has(component.type)) {
        const label = (component.props?.label as string) || component.id
        const val = formData[component.id]
        let formattedValue: string
        if (typeof val === 'boolean') {
          formattedValue = val ? '是' : '否'
        } else if (Array.isArray(val)) {
          formattedValue = val.length === 0 ? '(无)' : val.join(', ')
        } else if (val === undefined || val === null || val === '') {
          formattedValue = '(空)'
        } else {
          formattedValue = String(val)
        }
        lines.push(`- ${label}: ${formattedValue}`)
      }
      if (component.children && component.children.length > 0) {
        traverse(component.children)
      }
    }
  }
  traverse(document.components)
  if (lines.length > 0) {
    summary += '\n' + lines.join('\n')
  }
  return summary
}

/**
 * 递归深度优先遍历组件树，校验组件类型合法性、组件 ID 唯一性，并统计组件总数。
 *
 * 契约要求：
 * 1. 递归遍历传入的 components 及其嵌套的 children。
 * 2. 检查每个 component.type 是否在 A2UIComponentType 白名单中：
 *    - 若发现不在白名单中，返回 { ok: false, reason: `组件 ${component.id} 包含未受支持的组件类型: ${component.type}` }。
 * 3. 检查 component.id 在整棵树内是否全局唯一：
 *    - 维护已见 ID 集合；若遇到重复 ID，返回 { ok: false, reason: `检测到重复的组件 ID: ${component.id}` }。
 * 4. 统计包含所有层级子组件在内的总节点数量 totalCount。
 * 5. 全部合法时返回 { ok: true, count: totalCount }。
 *
 * 对应验收测试：tests/main/capabilities/a2ui.test.ts
 */
export function validateAndCountComponents(
  components: A2UIComponent[]
): { ok: true; count: number } | { ok: false; reason: string } {
  const seenIds = new Set<string>()
  function traverse(
    components: A2UIComponent[]
  ): { ok: true; count: number } | { ok: false; reason: string } {
    let totalCount = 0
    for (const component of components) {
      if (!A2UIComponentType.options.includes(component.type)) {
        return {
          ok: false,
          reason: `组件 ${component.id} 包含未受支持的组件类型: ${component.type}`
        }
      }
      if (seenIds.has(component.id)) {
        return {
          ok: false,
          reason: `检测到重复的组件 ID: ${component.id}`
        }
      }
      seenIds.add(component.id)
      totalCount++

      if (component.children && component.children.length > 0) {
        const childValidation = traverse(component.children)
        if (!childValidation.ok) {
          return childValidation
        }
        totalCount += childValidation.count
      }
    }
    return { ok: true, count: totalCount }
  }
  return traverse(components)
}

export const a2uiRenderPlugin: CapabilityPlugin = {
  name: 'a2ui_render',
  descriptor: {
    name: 'a2ui_render',
    kind: 'WRITE',
    description: '向桌面客户端推送受信任的 A2UI 声明式组件树进行安全渲染与交互'
  },
  async bindArguments(args) {
    const parsed = A2UIRenderParams.safeParse(args)
    if (!parsed.success) {
      return invalid('a2ui_render', parsed.error.message)
    }

    const document = normalizeA2UIRenderParams(parsed.data)
    const validation = validateAndCountComponents(document.components)
    if (!validation.ok) {
      return {
        ok: false,
        code: ERROR_CODE.INVALID_ARGUMENT,
        reason: validation.reason
      }
    }

    return {
      ok: true,
      bound: {
        args: {
          document,
          componentCount: validation.count
        },
        paths: {}
      }
    }
  },
  extractPermissionPaths() {
    return { sourcePaths: [], targetPath: null }
  },
  idempotency: {
    isWrite: true
  },
  async execute(call, context) {
    const document = call.bound.args['document'] as A2UIDocument
    const componentCount = (call.bound.args['componentCount'] as number) ?? 0
    const renderId = `render-${randomUUID()}`
    const stamp = context.scheduler?.now?.() ?? new Date().toISOString()

    if (context.scheduler?.events) {
      context.scheduler.events.append({
        taskId: call.taskId,
        type: A2UI_RENDERED_EVENT,
        payload: {
          renderId,
          callId: call.callId,
          title: document.title,
          componentCount,
          hasActions: Boolean(document.actions && document.actions.length > 0)
        },
        occurredAt: stamp
      })
    }

    recordA2UIRender({
      renderId,
      taskId: call.taskId,
      callId: call.callId,
      document,
      status: 'rendered',
      createdAt: stamp
    })

    const notice: A2UIRenderNotice = {
      renderId,
      taskId: call.taskId,
      callId: call.callId,
      document,
      createdAt: stamp
    }
    for (const listener of renderListeners) {
      try {
        listener(notice)
      } catch (err) {
        console.error('[A2UI_RENDER_LISTENER_ERROR]', err)
      }
    }

    return {
      ok: true,
      renderId,
      componentCount
    }
  }
}

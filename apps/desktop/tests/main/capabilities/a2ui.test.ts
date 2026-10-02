import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  A2UIComponent,
  A2UIDocument,
  CapabilityDescriptor,
  ERROR_CODE
} from '@personal-agent/protocol'
import {
  A2UI_RENDERED_EVENT,
  a2uiRenderPlugin,
  clearA2UIRenderListeners,
  clearA2UIRenders,
  formatA2UIFormSubmission,
  getA2UIRender,
  isCancelAction,
  listA2UIRenders,
  onA2UIRender,
  submitA2UIForm,
  validateAndCountComponents
} from '../../../src/main/capabilities/plugins/a2ui'
import type { AuthorizedCall, CapabilityPluginContext } from '../../../src/main/capabilities/plugin'
import type { EventRepository } from '../../../src/main/product-state/event-repository'
import type { ReminderRepository } from '../../../src/main/product-state/reminder-repository'
import type { SqliteDatabase } from '../../../src/main/product-state/database'

describe('a2ui capability plugin', () => {
  beforeEach(() => {
    clearA2UIRenders()
    clearA2UIRenderListeners()
  })

  describe('validateAndCountComponents', () => {
    it('空组件列表返回 ok: true 且 count 为 0', () => {
      const result = validateAndCountComponents([])
      expect(result).toEqual({ ok: true, count: 0 })
    })

    it('单层扁平合法组件列表统计节点数量', () => {
      const components: A2UIComponent[] = [
        { type: 'heading', id: 'h1', props: { text: '标题' } },
        { type: 'text_input', id: 'inp1', props: { label: '姓名' } },
        { type: 'divider', id: 'div1', props: {} }
      ]
      const result = validateAndCountComponents(components)
      expect(result).toEqual({ ok: true, count: 3 })
    })

    it('多层深度嵌套组件树完整统计所有层级的节点总数', () => {
      const components: A2UIComponent[] = [
        {
          type: 'form',
          id: 'form1',
          props: {},
          children: [
            {
              type: 'card',
              id: 'card1',
              props: {},
              children: [
                {
                  type: 'grid',
                  id: 'grid1',
                  props: {},
                  children: [
                    { type: 'text_input', id: 'f_name', props: {} },
                    { type: 'text_input', id: 'l_name', props: {} }
                  ]
                }
              ]
            },
            {
              type: 'accordion',
              id: 'acc1',
              props: {},
              children: [{ type: 'checkbox', id: 'opt_in', props: {} }]
            }
          ]
        }
      ]
      // 节点层级：form1 (1) + card1 (1) + grid1 (1) + f_name (1) + l_name (1) + acc1 (1) + opt_in (1) = 7
      const result = validateAndCountComponents(components)
      expect(result).toEqual({ ok: true, count: 7 })
    })

    it('遇到未在白名单中的组件类型时返回 ok: false 与明确错误原因', () => {
      const components: A2UIComponent[] = [
        { type: 'heading', id: 'h1', props: { text: '正常' } },
        {
          type: 'malicious_script' as unknown as A2UIComponent['type'],
          id: 'bad1',
          props: {}
        }
      ]
      const result = validateAndCountComponents(components)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toContain('bad1')
        expect(result.reason).toContain('malicious_script')
      }
    })

    it('嵌套在 children 深处的不受支持类型也能被及时拦截', () => {
      const components: A2UIComponent[] = [
        {
          type: 'card',
          id: 'card1',
          props: {},
          children: [
            {
              type: 'iframe' as unknown as A2UIComponent['type'],
              id: 'nested_bad',
              props: {}
            }
          ]
        }
      ]
      const result = validateAndCountComponents(components)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toContain('nested_bad')
      }
    })

    it('检测到重复的组件 ID 时返回 ok: false 与冲突组件 ID', () => {
      const components: A2UIComponent[] = [
        { type: 'text_input', id: 'user_email', props: {} },
        {
          type: 'card',
          id: 'card1',
          props: {},
          children: [{ type: 'text_input', id: 'user_email', props: {} }]
        }
      ]
      const result = validateAndCountComponents(components)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toContain('重复')
        expect(result.reason).toContain('user_email')
      }
    })
  })

  describe('a2uiRenderPlugin.bindArguments', () => {
    it('参数包含标准 document 且组件合法时绑定成功', async () => {
      const validDoc: A2UIDocument = {
        version: '1.0',
        title: '配置向导',
        components: [
          { type: 'heading', id: 'h1', props: { text: '步骤一' } },
          { type: 'text_input', id: 'name', props: { label: '名称' } }
        ],
        actions: [{ id: 'submit', label: '确定', type: 'submit' }]
      }

      const res = await a2uiRenderPlugin.bindArguments({ document: validDoc })
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.bound.args['componentCount']).toBe(2)
        expect(res.bound.args['document']).toEqual(validDoc)
        expect(res.bound.paths).toEqual({})
      }
    })

    it('平铺传入 title, components, actions 时自动归一化为完整 document', async () => {
      const res = await a2uiRenderPlugin.bindArguments({
        title: '平铺表单',
        components: [{ type: 'paragraph', id: 'p1', props: { text: '说明' } }]
      })
      expect(res.ok).toBe(true)
      if (res.ok) {
        const doc = res.bound.args['document'] as A2UIDocument
        expect(doc.title).toBe('平铺表单')
        expect(doc.version).toBe('1.0')
        expect(doc.components).toHaveLength(1)
        expect(res.bound.args['componentCount']).toBe(1)
      }
    })

    it('既无 document 又无 components 时校验失败', async () => {
      const res = await a2uiRenderPlugin.bindArguments({ title: '仅有标题' })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODE.INVALID_ARGUMENT)
      }
    })

    it('组件树包含非法类型或重复 ID 时绑定失败', async () => {
      const res = await a2uiRenderPlugin.bindArguments({
        components: [
          { type: 'text_input', id: 'dup_id', props: {} },
          { type: 'number_input', id: 'dup_id', props: {} }
        ]
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.code).toBe(ERROR_CODE.INVALID_ARGUMENT)
        expect(res.reason).toContain('dup_id')
      }
    })
  })

  describe('a2uiRenderPlugin.extractPermissionPaths', () => {
    it('不产生文件系统读写路径副作用', () => {
      const paths = a2uiRenderPlugin.extractPermissionPaths?.({ args: {}, paths: {} })
      expect(paths).toEqual({ sourcePaths: [], targetPath: null })
    })
  })

  describe('a2uiRenderPlugin.execute & lifecycle', () => {
    it('执行成功：生成唯一 renderId，记录事件与渲染状态', async () => {
      const appendEventMock = vi.fn()
      const mockEvents = {
        append: appendEventMock
      } as unknown as EventRepository

      const mockContext: CapabilityPluginContext = {
        scheduler: {
          db: {} as unknown as SqliteDatabase,
          reminders: {} as unknown as ReminderRepository,
          events: mockEvents,
          now: () => '2026-10-01T12:00:00.000Z'
        }
      }

      const doc: A2UIDocument = {
        version: '1.0',
        title: '测试文档',
        components: [
          { type: 'heading', id: 'h1', props: { text: '测试' } },
          { type: 'text_input', id: 'input1', props: {} }
        ],
        actions: [{ id: 'submit', label: '确认', type: 'submit' }]
      }

      const call: AuthorizedCall = {
        taskId: 'task-101',
        callId: 'call-202',
        capability: a2uiRenderPlugin.descriptor as CapabilityDescriptor,
        bound: {
          args: {
            document: doc,
            componentCount: 2
          },
          paths: {}
        }
      }

      const outcome = await a2uiRenderPlugin.execute(call, mockContext)
      expect(outcome.ok).toBe(true)
      expect(outcome['componentCount']).toBe(2)
      const renderId = outcome['renderId'] as string
      expect(renderId).toMatch(/^render-/)

      // 验证事件上报
      expect(appendEventMock).toHaveBeenCalledTimes(1)
      expect(appendEventMock).toHaveBeenCalledWith({
        taskId: 'task-101',
        type: A2UI_RENDERED_EVENT,
        payload: {
          renderId,
          callId: 'call-202',
          title: '测试文档',
          componentCount: 2,
          hasActions: true
        },
        occurredAt: '2026-10-01T12:00:00.000Z'
      })

      // 验证注册表追踪
      const tracked = getA2UIRender(renderId)
      expect(tracked).toBeDefined()
      expect(tracked?.status).toBe('rendered')
      expect(tracked?.taskId).toBe('task-101')
      expect(tracked?.document).toEqual(doc)

      const taskRenders = listA2UIRenders('task-101')
      expect(taskRenders).toHaveLength(1)
      expect(taskRenders[0].renderId).toBe(renderId)

      // 模拟用户在客户端提交表单
      const submitSuccess = submitA2UIForm(renderId, 'submit', { input1: '填写的数值' })
      expect(submitSuccess).toBe(true)

      const updated = getA2UIRender(renderId)
      expect(updated?.status).toBe('submitted')
      expect(updated?.actionId).toBe('submit')
      expect(updated?.formData).toEqual({ input1: '填写的数值' })
      expect(updated?.submittedAt).toBeDefined()
    })

    it('提交不存在的 renderId 时返回 false', () => {
      const res = submitA2UIForm('non-existent-render', 'submit', {})
      expect(res).toBe(false)
    })
  })

  describe('isCancelAction 模糊匹配规则', () => {
    it('标准 cancel 动作判定为取消', () => {
      expect(isCancelAction('cancel')).toBe(true)
      expect(isCancelAction('CANCEL')).toBe(true)
      expect(isCancelAction('  cancel  ')).toBe(true)
    })

    it('常见前缀/后缀变体判定为取消', () => {
      expect(isCancelAction('btn_cancel')).toBe(true)
      expect(isCancelAction('cancel-btn')).toBe(true)
      expect(isCancelAction('cancel_dialog')).toBe(true)
      expect(isCancelAction('action_cancel_all')).toBe(true)
    })

    it('同义词 abort / dismiss 判定为取消', () => {
      expect(isCancelAction('abort')).toBe(true)
      expect(isCancelAction('btn_abort')).toBe(true)
      expect(isCancelAction('dismiss')).toBe(true)
      expect(isCancelAction('modal_dismiss')).toBe(true)
    })

    it('非取消类动作判定为 false', () => {
      expect(isCancelAction('submit')).toBe(false)
      expect(isCancelAction('confirm')).toBe(false)
      expect(isCancelAction('save')).toBe(false)
      expect(isCancelAction('next_step')).toBe(false)
    })
  })

  describe('onA2UIRender 实时通知机制', () => {
    it('execute 执行时向注册监听器广播 A2UIRenderNotice', async () => {
      const notices: unknown[] = []
      const unsubscribe = onA2UIRender((notice) => {
        notices.push(notice)
      })

      const doc: A2UIDocument = {
        version: '1.0',
        title: '测试广播',
        components: [{ type: 'heading', id: 'h1', props: { text: '问卷' } }]
      }

      const call: AuthorizedCall = {
        taskId: 'task-broadcast-1',
        callId: 'call-b-1',
        capability: a2uiRenderPlugin.descriptor as CapabilityDescriptor,
        bound: {
          args: { document: doc, componentCount: 1 },
          paths: {}
        }
      }

      const outcome = await a2uiRenderPlugin.execute(call, {})
      expect(outcome.ok).toBe(true)
      expect(notices).toHaveLength(1)
      expect(notices[0]).toMatchObject({
        taskId: 'task-broadcast-1',
        callId: 'call-b-1',
        document: doc
      })
      expect((notices[0] as { renderId: string }).renderId).toBe(outcome['renderId'])

      // 取消订阅后不再接收新通知
      unsubscribe()
      await a2uiRenderPlugin.execute(call, {})
      expect(notices).toHaveLength(1)
    })

    it('监听器抛出异常时不破坏 execute 主流程', async () => {
      onA2UIRender(() => {
        throw new Error('Listener crash!')
      })

      const doc: A2UIDocument = {
        version: '1.0',
        title: '健壮性测试',
        components: [{ type: 'divider', id: 'd1', props: {} }]
      }

      const call: AuthorizedCall = {
        taskId: 'task-robust-1',
        callId: 'call-r-1',
        capability: a2uiRenderPlugin.descriptor as CapabilityDescriptor,
        bound: {
          args: { document: doc, componentCount: 1 },
          paths: {}
        }
      }

      const outcome = await a2uiRenderPlugin.execute(call, {})
      expect(outcome.ok).toBe(true)
      expect(outcome['renderId']).toBeDefined()
    })
  })

  describe('formatA2UIFormSubmission 扩展取消动作支持', () => {
    it('识别 btn_cancel 与 dismiss 动作并输出规范的取消提示', () => {
      const doc: A2UIDocument = {
        version: '1.0',
        title: '表单',
        components: [{ type: 'text_input', id: 'name', props: {} }]
      }

      expect(formatA2UIFormSubmission(doc, {}, 'btn_cancel')).toBe(
        '【用户取消了表单交互】(action: btn_cancel)'
      )
      expect(formatA2UIFormSubmission(doc, {}, 'dismiss')).toBe(
        '【用户取消了表单交互】(action: dismiss)'
      )
    })
  })
})

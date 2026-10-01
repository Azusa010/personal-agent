import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { A2UIDocument, CapabilityDescriptor } from '@personal-agent/protocol'
import {
  A2UI_RENDERED_EVENT,
  A2UI_SUBMITTED_EVENT,
  a2uiRenderPlugin,
  clearA2UIRenders,
  formatA2UIFormSubmission,
  getA2UIRender,
  submitA2UIForm
} from '../../../src/main/capabilities/plugins/a2ui'
import { extractInitialFormValues } from '../../../src/renderer/src/components/a2ui/form-state'
import { sanitizeProps } from '../../../src/renderer/src/components/a2ui/sanitize'
import {
  migrate,
  openProductState,
  type SqliteDatabase
} from '../../../src/main/product-state/database'
import { SqliteEventRepository } from '../../../src/main/product-state/event-repository'
import { SqliteTaskRepository } from '../../../src/main/product-state/task-repository'
import type { AuthorizedCall, CapabilityPluginContext } from '../../../src/main/capabilities/plugin'
import type { ReminderRepository } from '../../../src/main/product-state/reminder-repository'

describe('A2UI 动态表单意图澄清 E2E 闭环', () => {
  let tempDir: string
  let db: SqliteDatabase
  let events: SqliteEventRepository

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pa-a2ui-e2e-'))
    db = openProductState(join(tempDir, 'product-state.db'))
    migrate(db)
    events = new SqliteEventRepository(db)
    clearA2UIRenders()
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // 忽略关闭异常
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('formatA2UIFormSubmission 格式化算法', () => {
    it('当 actionId 为 cancel 时返回取消交互提示', () => {
      const doc: A2UIDocument = {
        version: '1.0',
        title: '重构选项确认',
        components: [{ type: 'text_input', id: 'scope', props: { label: '重构范围' } }]
      }
      const summary = formatA2UIFormSubmission(doc, {}, 'cancel')
      expect(summary).toBe('【用户取消了表单交互】(action: cancel)')
    })

    it('正常提交时格式化标题及布尔、数组、空值与普通字符串字段', () => {
      const doc: A2UIDocument = {
        version: '1.0',
        title: '代码重构配置',
        components: [
          {
            type: 'text_input',
            id: 'module_name',
            props: { label: '目标模块' }
          },
          {
            type: 'multi_select',
            id: 'files',
            props: { label: '涉及文件' }
          },
          {
            type: 'multi_select',
            id: 'empty_tags',
            props: { label: '附加标签' }
          },
          {
            type: 'checkbox',
            id: 'run_tests',
            props: { label: '自动运行测试' }
          },
          {
            type: 'checkbox',
            id: 'deploy',
            props: { label: '即刻发布' }
          },
          {
            type: 'textarea',
            id: 'notes',
            props: { label: '补充备注' }
          }
        ]
      }

      const formData = {
        module_name: 'src/services/auth',
        files: ['login.ts', 'token.ts'],
        empty_tags: [],
        run_tests: true,
        deploy: false,
        notes: ''
      }

      const summary = formatA2UIFormSubmission(doc, formData, 'submit')
      expect(summary).toBe(
        '【表单提交结果】: 代码重构配置\n' +
          '- 目标模块: src/services/auth\n' +
          '- 涉及文件: login.ts, token.ts\n' +
          '- 附加标签: (无)\n' +
          '- 自动运行测试: 是\n' +
          '- 即刻发布: 否\n' +
          '- 补充备注: (空)'
      )
    })

    it('支持遍历深度嵌套在容器组件（card / form / grid）内的输入字段', () => {
      const doc: A2UIDocument = {
        version: '1.0',
        title: '嵌套表单配置',
        components: [
          {
            type: 'card',
            id: 'card1',
            props: { title: '基本信息' },
            children: [
              {
                type: 'grid',
                id: 'grid1',
                props: {},
                children: [
                  {
                    type: 'text_input',
                    id: 'first_name',
                    props: { label: '名' }
                  },
                  {
                    type: 'text_input',
                    id: 'last_name',
                    props: { label: '姓' }
                  }
                ]
              }
            ]
          }
        ]
      }

      const formData = {
        first_name: '三',
        last_name: '张'
      }

      const summary = formatA2UIFormSubmission(doc, formData, 'submit')
      expect(summary).toBe('【表单提交结果】: 嵌套表单配置\n- 名: 三\n- 姓: 张')
    })

    it('当组件没有 label 属性时优雅回退为组件 id', () => {
      const doc: A2UIDocument = {
        version: '1.0',
        components: [
          {
            type: 'text_input',
            id: 'custom_identifier_key',
            props: {}
          }
        ]
      }

      const summary = formatA2UIFormSubmission(
        doc,
        { custom_identifier_key: 'custom_value' },
        'submit'
      )
      expect(summary).toBe('【表单提交结果】\n- custom_identifier_key: custom_value')
    })
  })

  describe('完整意图澄清与表单提交端到端流程', () => {
    it('从 Agent 生成 A2UI 表单 → 客户端解析防御 → 用户提交与事件持久化 → 形成澄清确认摘要', async () => {
      const taskId = 'task-refactor-999'
      const callId = 'call-a2ui-clarify-1'

      const taskRepo = new SqliteTaskRepository(db)
      taskRepo.insert({
        id: taskId,
        goal: '重构代码库',
        status: 'running',
        createdAt: '2026-10-01T15:00:00.000Z',
        updatedAt: '2026-10-01T15:00:00.000Z'
      })

      // 1. Agent 面对模糊需求（"重构代码库"），决定调用 a2ui_render 推送级联澄清表单
      const a2uiDoc: A2UIDocument = {
        version: '1.0',
        title: '代码重构意图确认',
        components: [
          {
            type: 'heading',
            id: 'h1',
            props: { text: '请明确以下重构参数：', level: 3 }
          },
          {
            type: 'text_input',
            id: 'target_path',
            props: {
              label: '重构目标路径',
              placeholder: '例如 src/api/',
              default: 'src/api/'
            }
          },
          {
            type: 'radio_group',
            id: 'strategy',
            props: {
              label: '重构模式',
              options: ['提取公共接口', '模块拆分', '完全重写'],
              default: '提取公共接口'
            }
          },
          {
            type: 'checkbox',
            id: 'auto_test',
            props: {
              label: '重构后自动执行自动化测试',
              default: true
            }
          }
        ],
        actions: [
          { id: 'submit', label: '确认执行', type: 'submit' },
          { id: 'cancel', label: '取消', type: 'cancel' }
        ]
      }

      // 2. 宿主端执行 a2ui_render 插件调用
      const mockContext: CapabilityPluginContext = {
        scheduler: {
          db,
          reminders: {} as unknown as ReminderRepository,
          events,
          now: () => '2026-10-01T15:00:00.000Z'
        }
      }

      const boundRes = await a2uiRenderPlugin.bindArguments({ document: a2uiDoc })
      expect(boundRes.ok).toBe(true)
      if (!boundRes.ok) return

      const call: AuthorizedCall = {
        taskId,
        callId,
        capability: a2uiRenderPlugin.descriptor as CapabilityDescriptor,
        bound: boundRes.bound
      }

      const outcome = await a2uiRenderPlugin.execute(call, mockContext)
      expect(outcome.ok).toBe(true)
      const renderId = outcome['renderId'] as string
      expect(renderId).toMatch(/^render-/)

      // 3. 验证数据库中持久化了 a2ui_rendered 事件
      const recordedEvents = events.listByTask(taskId)
      const renderEvent = recordedEvents.find((e) => e.type === A2UI_RENDERED_EVENT)
      expect(renderEvent).toBeDefined()
      expect(renderEvent?.payload).toMatchObject({
        renderId,
        callId,
        title: '代码重构意图确认',
        hasActions: true
      })

      // 4. 客户端（Renderer）侧：安全净化 + 提取表单初始状态
      const initialFormValues = extractInitialFormValues(a2uiDoc.components)
      expect(initialFormValues).toEqual({
        target_path: 'src/api/',
        strategy: '提取公共接口',
        auto_test: true
      })

      // 验证属性净化：剥离可能的 XSS 危险属性
      const maliciousProps = {
        label: '目标路径',
        onClick: "alert('xss')",
        dangerouslySetInnerHTML: { __html: 'hack' }
      }
      const sanitized = sanitizeProps(maliciousProps)
      expect(sanitized).toEqual({ label: '目标路径' })

      // 5. 用户在前端交互：修改了重构模式与路径
      const userEditedFormData = {
        target_path: 'src/services/user/',
        strategy: '模块拆分',
        auto_test: true
      }

      // 6. 用户点击「确认执行」动作，调用 submitA2UIForm
      const submitSuccess = submitA2UIForm(
        renderId,
        'submit',
        userEditedFormData,
        events,
        () => '2026-10-01T15:01:00.000Z'
      )
      expect(submitSuccess).toBe(true)

      // 7. 验证渲染记录状态机变更
      const trackedRender = getA2UIRender(renderId)
      expect(trackedRender).toBeDefined()
      expect(trackedRender?.status).toBe('submitted')
      expect(trackedRender?.actionId).toBe('submit')
      expect(trackedRender?.formData).toEqual(userEditedFormData)
      expect(trackedRender?.submittedAt).toBe('2026-10-01T15:01:00.000Z')

      // 8. 验证数据库中追加持久化了 a2ui_submitted 事件
      const allEvents = events.listByTask(taskId)
      const submitEvent = allEvents.find((e) => e.type === A2UI_SUBMITTED_EVENT)
      expect(submitEvent).toBeDefined()
      expect(submitEvent?.payload).toEqual({
        renderId,
        actionId: 'submit',
        formData: userEditedFormData
      })

      // 9. 将表单结果格式化为 Agent 下一步的清晰意图输入
      const continuationPrompt = formatA2UIFormSubmission(a2uiDoc, userEditedFormData, 'submit')
      expect(continuationPrompt).toBe(
        '【表单提交结果】: 代码重构意图确认\n' +
          '- 重构目标路径: src/services/user/\n' +
          '- 重构模式: 模块拆分\n' +
          '- 重构后自动执行自动化测试: 是'
      )
    })
  })
})

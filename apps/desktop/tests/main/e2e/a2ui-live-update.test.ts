import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { A2UIDocument, CapabilityDescriptor } from '@personal-agent/protocol'
import type { A2UIUpdateNotice } from '../../../src/shared/ipc-contract'
import {
  A2UI_RENDERED_EVENT,
  A2UI_UPDATED_EVENT,
  a2uiRenderPlugin,
  a2uiUpdatePlugin,
  clearA2UIRenderListeners,
  clearA2UIRenders,
  getA2UIRender,
  onA2UIRenderUpdate,
  submitA2UIForm
} from '../../../src/main/capabilities/plugins/a2ui'
import {
  migrate,
  openProductState,
  type SqliteDatabase
} from '../../../src/main/product-state/database'
import { SqliteEventRepository } from '../../../src/main/product-state/event-repository'
import { SqliteTaskRepository } from '../../../src/main/product-state/task-repository'
import type { AuthorizedCall, CapabilityPluginContext } from '../../../src/main/capabilities/plugin'
import type { ReminderRepository } from '../../../src/main/product-state/reminder-repository'

describe('A2UI 活卡原地更新闭环（render → update → update）', () => {
  let tempDir: string
  let db: SqliteDatabase
  let events: SqliteEventRepository
  let mockContext: CapabilityPluginContext
  const taskId = 'task-live-card-001'

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pa-a2ui-update-'))
    db = openProductState(join(tempDir, 'product-state.db'))
    migrate(db)
    events = new SqliteEventRepository(db)
    clearA2UIRenders()
    clearA2UIRenderListeners()

    new SqliteTaskRepository(db).insert({
      id: taskId,
      goal: '盯进度并持续更新卡片',
      status: 'running',
      createdAt: '2026-10-25T15:00:00.000Z',
      updatedAt: '2026-10-25T15:00:00.000Z'
    })

    mockContext = {
      scheduler: {
        db,
        reminders: {} as unknown as ReminderRepository,
        events,
        now: () => '2026-10-25T15:00:00.000Z'
      }
    }
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // 忽略关闭异常
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  async function renderCard(document: A2UIDocument): Promise<string> {
    const boundRes = await a2uiRenderPlugin.bindArguments({ document })
    expect(boundRes.ok).toBe(true)
    if (!boundRes.ok) throw new Error('render bind 失败')
    const call: AuthorizedCall = {
      taskId,
      callId: `call-render-${Math.random().toString(36).slice(2, 8)}`,
      capability: a2uiRenderPlugin.descriptor as CapabilityDescriptor,
      bound: boundRes.bound
    }
    const outcome = await a2uiRenderPlugin.execute(call, mockContext)
    expect(outcome.ok).toBe(true)
    return (outcome as { renderId: string }).renderId
  }

  async function updateCard(
    renderId: string,
    args: Record<string, unknown>,
    callId: string
  ): Promise<ReturnType<typeof a2uiUpdatePlugin.execute> extends Promise<infer T> ? T : never> {
    const boundRes = await a2uiUpdatePlugin.bindArguments({ renderId, ...args })
    if (!boundRes.ok) {
      return boundRes as never
    }
    const call: AuthorizedCall = {
      taskId,
      callId,
      capability: a2uiUpdatePlugin.descriptor as CapabilityDescriptor,
      bound: boundRes.bound
    }
    return (await a2uiUpdatePlugin.execute(call, mockContext)) as never
  }

  it('同一 renderId 连续两次 update：document 替换、version 递增、事件落库、监听器收到通知', async () => {
    const renderId = await renderCard({
      version: '1.0',
      title: '任务进度',
      components: [
        { type: 'heading', id: 'progress-heading', props: { text: '重构进行中（0/2）', level: 3 } },
        { type: 'text_input', id: 'scope', props: { label: '范围', default: 'src/api/' } }
      ]
    })

    const notices: A2UIUpdateNotice[] = []
    const unsubscribe = onA2UIRenderUpdate((notice) => notices.push(notice))
    try {
      // 第一次 update：进度 1/2，保留输入组件
      const first = await updateCard(
        renderId,
        {
          title: '任务进度',
          components: [
            { type: 'heading', id: 'progress-heading', props: { text: '重构进行中（1/2）', level: 3 } },
            { type: 'text_input', id: 'scope', props: { label: '范围', default: 'src/api/' } }
          ]
        },
        'call-update-1'
      )
      expect(first.ok).toBe(true)
      if (first.ok) {
        expect(first.version).toBe(1)
        expect(first.componentCount).toBe(2)
      }

      // 第二次 update：进度 2/2，组件树换成完成态
      const second = await updateCard(
        renderId,
        {
          components: [
            { type: 'heading', id: 'progress-heading', props: { text: '重构完成（2/2）', level: 3 } },
            { type: 'alert', id: 'done', props: { text: '全部步骤完成', level: 'success' } }
          ]
        },
        'call-update-2'
      )
      expect(second.ok).toBe(true)
      if (second.ok) {
        expect(second.version).toBe(2)
      }

      // store：document 已替换为第二次内容，version 递增
      const tracked = getA2UIRender(renderId)
      expect(tracked?.version).toBe(2)
      expect(tracked?.status).toBe('rendered')
      expect(tracked?.document.components).toHaveLength(2)
      expect(tracked?.document.components[1]?.type).toBe('alert')

      // 事件库：rendered 1 条 + updated 2 条，payload 携带版本号与全量 document（历史回放依赖）
      const allEvents = events.listByTask(taskId)
      expect(allEvents.filter((e) => e.type === A2UI_RENDERED_EVENT)).toHaveLength(1)
      const updatedEvents = allEvents.filter((e) => e.type === A2UI_UPDATED_EVENT)
      expect(updatedEvents).toHaveLength(2)
      expect(updatedEvents[0]?.payload).toMatchObject({
        renderId,
        callId: 'call-update-1',
        componentCount: 2,
        version: 1
      })
      expect(updatedEvents[1]?.payload).toMatchObject({
        renderId,
        callId: 'call-update-2',
        version: 2
      })
      const updatedDoc = (updatedEvents[1]?.payload as Record<string, unknown>)['document']
      expect(updatedDoc).toMatchObject({
        version: '1.0'
      })
      expect((updatedDoc as { components: Array<{ type: string }> }).components.map((c) => c.type)).toEqual([
        'heading',
        'alert'
      ])

      // 监听器：收到两条携带最新 document 的更新通知
      expect(notices).toHaveLength(2)
      expect(notices[0]?.version).toBe(1)
      expect(notices[1]?.version).toBe(2)
      expect(notices[1]?.renderId).toBe(renderId)
      expect(notices[1]?.document.components[0]?.props?.text).toBe('重构完成（2/2）')
    } finally {
      unsubscribe()
    }
  })

  it('未知 renderId 被 bind 阶段拒绝', async () => {
    const res = await a2uiUpdatePlugin.bindArguments({
      renderId: 'render-not-exist',
      components: [{ type: 'heading', id: 'h', props: { text: 'x' } }]
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('INVALID_ARGUMENT')
      expect(res.reason).toContain('render-not-exist')
    }
  })

  it('已提交（submitted）的卡片不可更新', async () => {
    const renderId = await renderCard({
      version: '1.0',
      title: '确认表单',
      components: [{ type: 'text_input', id: 'scope', props: { label: '范围' } }]
    })
    const submitted = submitA2UIForm(
      renderId,
      'submit',
      { scope: 'src/core/' },
      events,
      () => '2026-10-25T15:01:00.000Z'
    )
    expect(submitted).toBe(true)

    const res = await a2uiUpdatePlugin.bindArguments({
      renderId,
      components: [{ type: 'heading', id: 'h', props: { text: 'x' } }]
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('INVALID_ARGUMENT')
      expect(res.reason).toContain('submitted')
    }

    // 且事件库不产生 a2ui_updated
    expect(events.listByTask(taskId).filter((e) => e.type === A2UI_UPDATED_EVENT)).toHaveLength(0)
  })

  it('execute 阶段防御：bind 通过后卡片被清空时返回失败而非崩溃', async () => {
    const renderId = await renderCard({
      version: '1.0',
      components: [{ type: 'heading', id: 'h', props: { text: 'x' } }]
    })
    const boundRes = await a2uiUpdatePlugin.bindArguments({
      renderId,
      components: [{ type: 'heading', id: 'h2', props: { text: 'y' } }]
    })
    expect(boundRes.ok).toBe(true)
    if (!boundRes.ok) return

    clearA2UIRenders()
    const call: AuthorizedCall = {
      taskId,
      callId: 'call-update-defensive',
      capability: a2uiUpdatePlugin.descriptor as CapabilityDescriptor,
      bound: boundRes.bound
    }
    const outcome = await a2uiUpdatePlugin.execute(call, mockContext)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.code).toBe('INVALID_ARGUMENT')
    }
  })
})

import { describe, it, expect } from 'vitest'
import type {
  ExecutionEventRecord,
  PlanRecord,
  PlanStep,
  RunTaskIpcResult
} from '../../shared/ipc-contract'
import {
  EVENT_LABELS,
  STATUS_LABELS,
  describeEvent,
  describePlanSteps,
  describeRunOutcome,
  extractFactCount,
  formatOccurredAt,
  summarizePayload
} from './view-model'

const AT = '2026-09-07T08:00:01.000Z'

function ev(type: string, payload: unknown, seq = 1, occurredAt = AT): ExecutionEventRecord {
  return { seq, taskId: 't-1', type, payload, occurredAt }
}

describe('describeRunOutcome', () => {
  it('completed → tone success，facts 与 taskId 原样透传', () => {
    const res: RunTaskIpcResult = {
      ok: true,
      taskId: 't-1',
      status: 'completed',
      facts: [{ text: '第一条', pageRefs: [1, 2] }]
    }

    expect(describeRunOutcome(res)).toEqual({
      tone: 'success',
      headline: '任务完成',
      detail: null,
      facts: [{ text: '第一条', pageRefs: [1, 2] }],
      taskId: 't-1'
    })
  })

  it('completed 但没带 facts → facts 是空数组而不是 undefined', () => {
    // RunTaskIpcResult 的 facts 是可选的。UI 要直接 .map，不能先判空。
    const res: RunTaskIpcResult = { ok: true, taskId: 't-1', status: 'completed' }

    expect(describeRunOutcome(res).facts).toEqual([])
  })

  it('failed → tone failed，detail 是 reason', () => {
    const res: RunTaskIpcResult = {
      ok: true,
      taskId: 't-2',
      status: 'failed',
      reason: '预算耗尽：已用 8 步 / 5 次工具调用'
    }

    const view = describeRunOutcome(res)
    expect(view.tone).toBe('failed')
    expect(view.headline).toBe('任务失败')
    expect(view.detail).toBe('预算耗尽：已用 8 步 / 5 次工具调用')
    expect(view.facts).toEqual([])
    expect(view.taskId).toBe('t-2')
  })

  it('failed 但没带 reason → detail 是 null，不是空串', () => {
    const res: RunTaskIpcResult = { ok: true, taskId: 't-2', status: 'failed' }

    expect(describeRunOutcome(res).detail).toBeNull()
  })

  it('ok:false → tone error，detail 带上错误码，taskId 是 null', () => {
    const res: RunTaskIpcResult = {
      ok: false,
      code: 'PROTOCOL_INVALID_REQUEST',
      message: 'goal 不能为空'
    }

    expect(describeRunOutcome(res)).toEqual({
      tone: 'error',
      headline: '这次调用没跑起来',
      detail: '[PROTOCOL_INVALID_REQUEST] goal 不能为空',
      facts: [],
      taskId: null
    })
  })

  it('三态的 tone 互不相同：UI 靠它选样式，撞了就没法区分', () => {
    const tones = [
      describeRunOutcome({ ok: true, taskId: 't', status: 'completed' }).tone,
      describeRunOutcome({ ok: true, taskId: 't', status: 'failed', reason: 'x' }).tone,
      describeRunOutcome({ ok: false, code: 'RUNTIME_DB_FAILED', message: 'x' }).tone
    ]

    expect(new Set(tones).size).toBe(3)
  })
})

describe('EVENT_LABELS', () => {
  it('登记的键就是 engine.py 的六个 EVENT_* 常量，一个不多一个不少', () => {
    // 这六个字符串是跨语言契约：Python 写库、TS 读库。任一边改名，
    // timeline 上就会出现没翻译的英文 type。这条测试钉住 TS 这一半。
    expect(Object.keys(EVENT_LABELS).sort()).toEqual(
      [
        'budget_exhausted',
        'task_completed',
        'task_failed',
        'task_started',
        'tool_called',
        'tool_result'
      ].sort()
    )
  })

  it('标签都非空且互不重复', () => {
    const labels = Object.values(EVENT_LABELS)

    expect(labels.every((l) => l.trim().length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('STATUS_LABELS', () => {
  it('五个任务状态全都有标签', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual(
      ['cancelled', 'completed', 'failed', 'pending', 'running'].sort()
    )
  })

  it('标签都非空且互不重复', () => {
    const labels = Object.values(STATUS_LABELS)

    expect(labels.every((l) => l.trim().length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('formatOccurredAt', () => {
  it('输出 YYYY-MM-DD HH:mm:ss，且按本地时区读回是同一个瞬间', () => {
    // 断言写成「形状 + 瞬间往返」而不是钉死字符串：机器时区不同，
    // 钉死的话换台机器就红。往返能抓住月份 0 基、时分秒写反这类错。
    const out = formatOccurredAt(AT)

    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    const back = new Date(out.replace(' ', 'T'))
    expect(back.getTime()).toBe(Math.floor(new Date(AT).getTime() / 1000) * 1000)
  })

  it('毫秒被丢掉，只到秒', () => {
    expect(formatOccurredAt('2026-09-07T08:00:01.750Z')).toMatch(/:01$/)
  })

  it.each([['不是时间'], [''], ['2026-13-45T99:99:99Z']])('脏数据 %s 原样返回', (bad) => {
    // occurredAt 在库里是 TEXT 没有 CHECK。一行脏数据不该让整条 timeline 渲染失败。
    expect(formatOccurredAt(bad)).toBe(bad)
  })
})

describe('summarizePayload', () => {
  it('task_started 的摘要里能看到 goal', () => {
    expect(summarizePayload('task_started', { goal: '整理 Downloads 里的 PDF' })).toContain(
      '整理 Downloads 里的 PDF'
    )
  })

  it('tool_called 的摘要里能看到 capability', () => {
    const line = summarizePayload('tool_called', {
      callId: 'call-1',
      capability: 'filesystem.list',
      arguments: { rootId: 'downloads' }
    })

    expect(line).toContain('filesystem.list')
  })

  it('tool_result 成功与失败给出不同的两行', () => {
    const ok = summarizePayload('tool_result', {
      callId: 'call-1',
      capability: 'filesystem.list',
      ok: true
    })
    const bad = summarizePayload('tool_result', {
      callId: 'call-1',
      capability: 'filesystem.list',
      ok: false
    })

    expect(ok).not.toBe(bad)
  })

  it('budget_exhausted 的摘要里两个数字都在', () => {
    const line = summarizePayload('budget_exhausted', { steps: 8, toolCalls: 5 })

    expect(line).toContain('8')
    expect(line).toContain('5')
  })

  it('task_completed 的摘要里能看到条数', () => {
    expect(summarizePayload('task_completed', { factCount: 3 })).toContain('3')
  })

  it('task_failed 读得懂 engine 的 { reason } 形状', () => {
    expect(summarizePayload('task_failed', { reason: '摘要缺页码引用' })).toContain(
      '摘要缺页码引用'
    )
  })

  it('task_failed 也读得懂 TS 侧的 { code, message } 形状', () => {
    // 同一个 type 有两个写入方：engine._fail 写 reason，
    // run-task 的 persistRuntimeFailure 与 reconcile 写 code + message。
    const line = summarizePayload('task_failed', {
      code: 'RUNTIME_MODEL_NOT_CONFIGURED',
      message: '运行时未配置模型，无法执行任务'
    })

    expect(line).toContain('运行时未配置模型')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['字符串', '就是一句话'],
    ['数组', [1, 2, 3]],
    ['数字', 42],
    ['空对象', {}]
  ])('payload 是 %s 时不抛，仍给出一行非空摘要', (_label, payload) => {
    const line = summarizePayload('task_started', payload)

    expect(typeof line).toBe('string')
    expect(line.trim().length).toBeGreaterThan(0)
  })

  it('字段类型不对时不抛（库里会有旧版本写的行）', () => {
    expect(() => summarizePayload('task_started', { goal: 42 })).not.toThrow()
    expect(() => summarizePayload('budget_exhausted', { steps: '八' })).not.toThrow()
    expect(() => summarizePayload('tool_called', null)).not.toThrow()
  })

  it('未登记的 type 也要给出一行', () => {
    const line = summarizePayload('未来新增的类型', { anything: true })

    expect(line.trim().length).toBeGreaterThan(0)
  })

  it('输出永远是一行：含换行会把 UI 的行布局打乱', () => {
    const inputs: Array<[string, unknown]> = [
      ['task_started', { goal: '第一行\n第二行' }],
      ['tool_called', { capability: 'a\nb', arguments: { x: 'y\nz' } }],
      ['task_failed', { reason: '原因\n补充' }],
      ['task_failed', { code: 'C', message: 'm1\nm2' }]
    ]

    for (const [type, payload] of inputs) {
      expect(summarizePayload(type, payload)).not.toContain('\n')
    }
  })

  it('超长的 arguments 不被原样吐出', () => {
    // arguments 是任意 JSON，长度不受控。原样塞进一行会把 timeline 挤爆。
    const huge = 'A'.repeat(10_000)
    const line = summarizePayload('tool_called', {
      callId: 'call-1',
      capability: 'document.extract_pdf',
      arguments: { absolutePath: huge }
    })

    expect(line.length).toBeLessThan(200)
    expect(line).not.toContain(huge)
  })
})

describe('describeEvent', () => {
  it('label 取自 EVENT_LABELS，seq 与 type 原样透传，time 走 formatOccurredAt', () => {
    const line = describeEvent(ev('task_started', { goal: '目标' }, 3))

    expect(line).toEqual({
      seq: 3,
      type: 'task_started',
      label: '任务开始',
      summary: expect.any(String),
      time: formatOccurredAt(AT)
    })
  })

  it.each([
    ['task_started', { goal: '整理 Downloads 里的 PDF' }],
    ['tool_called', { callId: 'call-1', capability: 'filesystem.list', arguments: {} }],
    ['tool_result', { callId: 'call-1', capability: 'filesystem.list', ok: true }],
    ['budget_exhausted', { steps: 8, toolCalls: 5 }],
    ['task_completed', { factCount: 3 }],
    ['task_failed', { reason: '摘要缺页码引用' }]
  ])('%s 能给出完整一行', (type, payload) => {
    const line = describeEvent(ev(type, payload))

    expect(line.label).toBe(EVENT_LABELS[type])
    expect(line.summary.trim().length).toBeGreaterThan(0)
    expect(line.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('未登记的 type：label 原样是英文 type，不显示空白也不抛', () => {
    const line = describeEvent(ev('某个没登记的类型', { a: 1 }))

    expect(line.label).toBe('某个没登记的类型')
    expect(line.type).toBe('某个没登记的类型')
  })

  it('脏 occurredAt 原样显示，其余字段照常', () => {
    const line = describeEvent(ev('task_started', { goal: '目标' }, 1, '不是时间'))

    expect(line.time).toBe('不是时间')
    expect(line.label).toBe('任务开始')
  })
})

describe('describePlanSteps', () => {
  function plan(steps: PlanStep[], version = 1): PlanRecord {
    return { id: 'p-1', taskId: 't-1', version, steps, createdAt: AT }
  }

  it('plan 为 null → 空数组，UI 不用先判 null', () => {
    expect(describePlanSteps(null)).toEqual([])
  })

  it('序号 1-based，capability 原样，没有 capability 的一步给中文说明', () => {
    const steps = describePlanSteps(
      plan([
        { description: '列出 Downloads 下的 PDF', capability: 'filesystem.list' },
        { description: '提取目标 PDF 的每页文本', capability: 'document.extract_pdf' },
        { description: '基于页面内容生成带页码引用的摘要' }
      ])
    )

    expect(steps.map((s) => s.index)).toEqual([1, 2, 3])
    expect(steps.map((s) => s.capability)).toEqual([
      'filesystem.list',
      'document.extract_pdf',
      null
    ])
    expect(steps[0]?.capabilityLabel).toBe('filesystem.list')
    expect(steps[2]?.capabilityLabel).toBe('模型产出，不经工具')
  })

  it('description 原样透传，不截断也不压平换行', () => {
    // 计划文本是产品钉死的模板，不是模型输出，不需要像事件 payload 那样防脏数据。
    const long = '很长的描述'.repeat(50)

    expect(describePlanSteps(plan([{ description: long }]))[0]?.description).toBe(long)
  })

  it('steps 是空数组时返回空数组，UI 据此显示「计划里没有步骤」', () => {
    expect(describePlanSteps(plan([]))).toEqual([])
  })
})

describe('extractFactCount', () => {
  it('task_completed 的 factCount 原样取出', () => {
    expect(extractFactCount([ev('task_completed', { factCount: 3 })])).toBe(3)
  })

  it('没有 task_completed → null，表示这个任务没跑完过', () => {
    expect(extractFactCount([ev('task_started', { goal: '目标' })])).toBeNull()
    expect(extractFactCount([])).toBeNull()
  })

  it('factCount 缺失或不是有限数字 → null，不当成 0', () => {
    // 0 与 null 语义不同：0 是「跑完了但没产出」，null 是「这条事件形状不对」。
    expect(extractFactCount([ev('task_completed', {})])).toBeNull()
    expect(extractFactCount([ev('task_completed', { factCount: '3' })])).toBeNull()
    expect(extractFactCount([ev('task_completed', { factCount: NaN })])).toBeNull()
    expect(extractFactCount([ev('task_completed', { factCount: Infinity })])).toBeNull()
  })

  it('factCount 是 0 时返回 0，不是 null', () => {
    expect(extractFactCount([ev('task_completed', { factCount: 0 })])).toBe(0)
  })

  it('多条 task_completed 取最后一条，那才是最终结局', () => {
    const events = [
      ev('task_completed', { factCount: 1 }, 1),
      ev('task_failed', { reason: '第一次不算' }, 2),
      ev('task_completed', { factCount: 5 }, 3)
    ]

    expect(extractFactCount(events)).toBe(5)
  })

  it('payload 不是对象时不炸', () => {
    expect(extractFactCount([ev('task_completed', null)])).toBeNull()
    expect(extractFactCount([ev('task_completed', '散文')])).toBeNull()
  })
})

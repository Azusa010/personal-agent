import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  ExecutionEventRecord,
  PlanRecord,
  PlanStep,
  RunTaskIpcResult,
  SummaryFact
} from '../../shared/ipc-contract'
import {
  EVENT_LABELS,
  PERMISSION_STATE_LABELS,
  STATUS_LABELS,
  describeEvent,
  describePlanSteps,
  describeReminderPreview,
  describeRunOutcome,
  extractFactCount,
  extractFacts,
  formatOccurredAt,
  formatRemaining,
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
  it('登记的键就是写库方用的十三个事件类型，一个不多一个不少', () => {
    // 前六个是跨语言契约：Python 写库、TS 读库，字符串来自 engine.py 的 EVENT_*。
    // 中间三个来自 permission-broker 的 PERMISSION_EVENT，写库方是 TS 自己。
    // reminder_created 来自 executor.ts 的 REMINDER_CREATED_EVENT（TASK-023）。
    // 最后三个来自 verify-deliverables.ts（TASK-026），写库方是 run-task.ts。
    // 任一边改名，timeline 上就会出现没翻译的英文 type。这条测试钉住展示层这一半。
    expect(Object.keys(EVENT_LABELS).sort()).toEqual(
      [
        'budget_exhausted',
        'permission_decision',
        'permission_expired',
        'permission_requested',
        'reminder_created',
        'task_completed',
        'task_failed',
        'task_started',
        'tool_called',
        'tool_result',
        'verification_failed',
        'verification_passed',
        'verification_started'
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
  it('六个任务状态全都有标签', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual(
      ['cancelled', 'completed', 'failed', 'pending', 'running', 'waiting_permission'].sort()
    )
  })

  it('标签都非空且互不重复', () => {
    const labels = Object.values(STATUS_LABELS)

    expect(labels.every((l) => l.trim().length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('PERMISSION_STATE_LABELS', () => {
  it('四个状态全都有标签，含不落库的 expired', () => {
    // expired 不在 permissions.status 的 CHECK 里，它是投影值。
    // 这里少了它，诊断表遇到过期记录就会显示 undefined。
    expect(Object.keys(PERMISSION_STATE_LABELS).sort()).toEqual(
      ['approved', 'denied', 'expired', 'pending'].sort()
    )
  })

  it('标签都非空且互不重复', () => {
    const labels = Object.values(PERMISSION_STATE_LABELS)

    expect(labels.every((l) => l.trim().length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('与 STATUS_LABELS 不共用词：任务状态与批准结论是两回事', () => {
    // 两张表会出现在同一个界面上。用词撞了的话，「已失败」到底是任务还是权限就分不清。
    const taskLabels = Object.values(STATUS_LABELS)
    const overlap = Object.values(PERMISSION_STATE_LABELS).filter((l) => taskLabels.includes(l))

    expect(overlap).toEqual([])
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

describe('formatRemaining', () => {
  const NOW = Date.parse('2026-09-07T08:00:00.000Z')

  it('剩余时间输出 mm:ss', () => {
    expect(formatRemaining('2026-09-07T08:04:32.000Z', NOW)).toBe('04:32')
  })

  it('超过一小时也按分钟累加，不换成小时', () => {
    // 批准窗口是 5 分钟，出现 90 分钟就说明 expiresAt 被写坏了。
    // 换成 '1:30:00' 反而看不出异常，累加分钟更直白。
    expect(formatRemaining('2026-09-07T09:30:00.000Z', NOW)).toBe('90:00')
  })

  it('已过期与正好到点都归零，不出现负数', () => {
    expect(formatRemaining('2026-09-07T07:59:59.000Z', NOW)).toBe('00:00')
    expect(formatRemaining('2026-09-07T08:00:00.000Z', NOW)).toBe('00:00')
  })

  it('不足一秒的余量向下取整', () => {
    expect(formatRemaining('2026-09-07T08:00:00.900Z', NOW)).toBe('00:00')
  })

  it.each([['不是时间'], [''], ['2026-13-45T99:99:99Z']])(
    'expiresAt 是脏数据 %s 时返回空串，由调用方降级成不显示倒计时',
    (bad) => {
      expect(formatRemaining(bad, NOW)).toBe('')
    }
  )

  it('now 是 NaN 时同样返回空串', () => {
    expect(formatRemaining('2026-09-07T08:04:32.000Z', Number.NaN)).toBe('')
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

  it('permission_requested 的摘要里能看到能力与目标路径', () => {
    // broker 写的 payload 形状：{ permissionId, capability, sourcePaths, targetPath, expiresAt }。
    // create_dir 只有 targetPath，sourcePaths 是空数组。
    const line = summarizePayload('permission_requested', {
      permissionId: 'p-1',
      capability: 'filesystem.create_dir',
      sourcePaths: [],
      targetPath: 'D:/downloads/reports',
      expiresAt: '2026-09-07T08:05:00.000Z'
    })

    expect(line).toContain('filesystem.create_dir')
    expect(line).toContain('D:/downloads/reports')
  })

  it('permission_requested 两个路径都有时优先显示 targetPath', () => {
    // move 两个都写。摘要只有一行，完整的两个路径在批准 Dialog 里看。
    const line = summarizePayload('permission_requested', {
      permissionId: 'p-2',
      capability: 'filesystem.move',
      sourcePaths: ['D:/downloads/a.pdf'],
      targetPath: 'D:/downloads/reports/a.pdf',
      expiresAt: '2026-09-07T08:05:00.000Z'
    })

    expect(line).toContain('D:/downloads/reports/a.pdf')
  })

  it('permission_requested 只有 sourcePaths 时把它们都列出来', () => {
    const line = summarizePayload('permission_requested', {
      capability: 'filesystem.move',
      sourcePaths: ['D:/a.pdf', 'D:/b.pdf'],
      targetPath: null
    })

    expect(line).toContain('D:/a.pdf')
    expect(line).toContain('D:/b.pdf')
  })

  it('permission_requested 的 sourcePaths 里混进非字符串时丢掉那一项，不丢整个列表', () => {
    const line = summarizePayload('permission_requested', {
      capability: 'filesystem.move',
      sourcePaths: ['D:/a.pdf', 42, ''],
      targetPath: null
    })

    expect(line).toContain('D:/a.pdf')
    expect(line).not.toContain('42')
  })

  it('permission_requested 路径全空时退回原始 payload，不给空行', () => {
    // scheduler.create 这类能力两个路径都没有。「批准什么」是这条事件唯一有用的信息，
    // 拿不到就显示原始 JSON，总比一行空白强。
    const line = summarizePayload('permission_requested', {
      capability: 'scheduler.create',
      sourcePaths: [],
      targetPath: null
    })

    expect(line.trim().length).toBeGreaterThan(0)
  })

  it('permission_requested 缺 sourcePaths 字段时不抛异常', () => {
    // broker 现在总会写 sourcePaths（可能是空数组），但 summarizePayload 读的是库里的
    // JSON TEXT：历史事件与脏数据都可能整个字段缺失。`as string[]` 只是编译期的断言，
    // 运行时 undefined.length 会抛 TypeError——describeEvent 在 MessageStream 里是逐条
    // map 的，一条抛异常整列时间线都渲染不出来。
    const line = summarizePayload('permission_requested', { capability: 'scheduler.create' })

    expect(line.trim().length).toBeGreaterThan(0)
    expect(line).not.toContain('undefined')
  })

  it('permission_requested 的 sourcePaths 不是数组时不抛异常', () => {
    // `as unknown[] | null` 只拦住了 undefined，拦不住「字段在但类型不对」。
    // 字符串也有 .length，会走进 else-if 分支，而字符串没有 .filter。
    const line = summarizePayload('permission_requested', {
      capability: 'filesystem.move',
      sourcePaths: 'D:/downloads/a.pdf',
      targetPath: null
    })

    expect(line.trim().length).toBeGreaterThan(0)
    expect(line).not.toContain('undefined')
  })

  it('permission_requested 缺 capability 时不把 undefined 拼进摘要', () => {
    const line = summarizePayload('permission_requested', {
      sourcePaths: [],
      targetPath: 'D:/downloads/reports'
    })

    expect(line).toContain('D:/downloads/reports')
    expect(line).not.toContain('undefined')
  })

  it('permission_decision 复用状态标签表，未知值原样显示', () => {
    expect(
      summarizePayload('permission_decision', { permissionId: 'p-1', decision: 'approved' })
    ).toBe(PERMISSION_STATE_LABELS.approved)
    expect(
      summarizePayload('permission_decision', { permissionId: 'p-1', decision: 'denied' })
    ).toBe(PERMISSION_STATE_LABELS.denied)
    expect(summarizePayload('permission_decision', { decision: '也许' })).toBe('也许')
  })

  it('permission_decision 缺 decision 时退回原始 payload，不显示字面量 undefined', () => {
    const line = summarizePayload('permission_decision', { permissionId: 'p-1' })

    expect(line).toContain('p-1')
    expect(line).not.toContain('undefined')
  })

  it('permission_decision 的 decision 是空串时不给空行', () => {
    // `??` 只拦 null 与 undefined，空串会直接穿过去，最终得到一行空白。
    // 本文件的 str() 助手就是为这种情况存在的：它把空串与纯空白也归为无效。
    const line = summarizePayload('permission_decision', { permissionId: 'p-1', decision: '  ' })

    expect(line.trim().length).toBeGreaterThan(0)
    expect(line).toContain('p-1')
  })

  it('permission_expired 给固定文案，不受 payload 影响', () => {
    const a = summarizePayload('permission_expired', { permissionId: 'p-1', expiresAt: AT })
    const b = summarizePayload('permission_expired', {})

    expect(a).toBe(b)
    expect(a.trim().length).toBeGreaterThan(0)
  })

  it('verification_started：报出待校验的摘要条数', () => {
    expect(summarizePayload('verification_started', { factCount: 3 })).toContain('3')
  })

  it('verification_passed：报出通过项数', () => {
    const line = summarizePayload('verification_passed', {
      report: {
        ok: true,
        checks: [
          { id: 'summary_present', ok: true, detail: '有摘要' },
          { id: 'file_at_target', ok: true, detail: '文件在目标目录' }
        ],
        reason: null
      },
      evidence: { taskId: 't-1' }
    })

    expect(line).toContain('2/2')
  })

  it('verification_failed：给出判定表的原因（这一行是 UI 上唯一的失败解释）', () => {
    const line = summarizePayload('verification_failed', {
      report: { ok: false, checks: [], reason: '被批准的文件不在目标目录' }
    })

    expect(line).toContain('被批准的文件不在目标目录')
  })

  it('verification_* 缺 report 时也要给出一行，不把 Evidence Bundle 原样吐出来', () => {
    const line = summarizePayload('verification_failed', {})

    expect(line.trim().length).toBeGreaterThan(0)
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
      ['task_failed', { code: 'C', message: 'm1\nm2' }],
      [
        'permission_requested',
        { capability: 'filesystem.move', sourcePaths: ['a\nb'], targetPath: 'c\nd' }
      ],
      ['permission_decision', { decision: ' approved\ndenied ' }]
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

describe('extractFacts', () => {
  const FACTS = [
    { text: '第一条', pageRefs: [1, 2] },
    { text: '第二条', pageRefs: [3] }
  ]

  it('payload 里的 facts 原样还原', () => {
    const events = [ev('task_completed', { factCount: 2, facts: FACTS })]

    expect(extractFacts(events)).toEqual(FACTS)
  })

  it('没有 task_completed → 空数组', () => {
    expect(extractFacts([ev('task_started', { goal: '目标' })])).toEqual([])
    expect(extractFacts([])).toEqual([])
  })

  it('改契约之前写的旧记录：只有 factCount，正文还原不出来但条数还在', () => {
    // 消息流靠这两个返回值的不一致判定「正文读不出来」，不能两个都降级成空。
    const events = [ev('task_completed', { factCount: 3 })]

    expect(extractFacts(events)).toEqual([])
    expect(extractFactCount(events)).toBe(3)
  })

  it('facts 不是数组 → 空数组，不当成一条也不是数组的东西去 map', () => {
    expect(extractFacts([ev('task_completed', { facts: '散文' })])).toEqual([])
    expect(extractFacts([ev('task_completed', { facts: null })])).toEqual([])
    expect(extractFacts([ev('task_completed', { facts: { text: 'a' } })])).toEqual([])
  })

  it('形状不对的整条丢掉，其余照常还原', () => {
    const events = [
      ev('task_completed', {
        factCount: 3,
        facts: [{ text: '好的', pageRefs: [1] }, { text: '', pageRefs: [1] }, '不是对象']
      })
    ]

    expect(extractFacts(events)).toEqual([{ text: '好的', pageRefs: [1] }])
  })

  it('pageRefs 里混进坏页码 → 整条丢，不剔坏的留好的', () => {
    // 剔完再渲染会把「来自第 1、3 页」变成「第 1 页」，看上去像真的。
    const events = [
      ev('task_completed', {
        facts: [
          { text: '混了字符串页码', pageRefs: [1, '3'] },
          { text: '混了 0', pageRefs: [0] },
          { text: '混了小数', pageRefs: [1.5] },
          { text: '干净的', pageRefs: [2] }
        ]
      })
    ]

    expect(extractFacts(events)).toEqual([{ text: '干净的', pageRefs: [2] }])
  })

  it('pageRefs 缺字段 → 整条丢', () => {
    expect(extractFacts([ev('task_completed', { facts: [{ text: '没页码' }] })])).toEqual([])
  })

  it('多条 task_completed 取最后一条', () => {
    const events = [
      ev('task_completed', { facts: [{ text: '旧的', pageRefs: [1] }] }, 1),
      ev('task_completed', { facts: [{ text: '新的', pageRefs: [2] }] }, 2)
    ]

    expect(extractFacts(events)).toEqual([{ text: '新的', pageRefs: [2] }])
  })

  it('payload 不是对象时不炸', () => {
    expect(extractFacts([ev('task_completed', null)])).toEqual([])
  })
})

describe('task_completed 的 payload 带上 facts 之后对 timeline 行的影响', () => {
  it('factCount 还在时，timeline 那行照旧只显示条数，不被 facts 的 JSON 撑爆', () => {
    const line = summarizePayload('task_completed', {
      factCount: 2,
      facts: [
        { text: '很长的正文'.repeat(40), pageRefs: [1] },
        { text: '另一条', pageRefs: [2, 3] }
      ]
    })

    expect(line).toBe('产出 2 条摘要')
  })

  it('factCount 从 payload 里去掉，timeline 那行就退化成整段 JSON', () => {
    // 钉的是 engine 侧不能只发 facts 不发 factCount 的原因：两个字段都得在。
    const line = summarizePayload('task_completed', {
      facts: [{ text: '很长的正文'.repeat(40), pageRefs: [1] }]
    })

    expect(line).not.toBe('产出 1 条摘要')
    expect(line.startsWith('{')).toBe(true)
    expect(line.length).toBeLessThanOrEqual(160)
  })
})

// 双端共用的那份 fixture。Python 侧 test_protocol_fixtures.py 拿它验 Pydantic 镜像，
// 这里拿它验展示层能不能还原。两边各绿不代表对得上，共用一份样本才钉得住。
describe('protocol fixture 交叉验证：Python 发出的 task_completed，TS 这边能还原', () => {
  const FIXTURE = fileURLToPath(
    new URL(
      '../../../../../packages/protocol/fixtures/agent-run-task.completed.response.json',
      import.meta.url
    )
  )
  const { result } = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    result: { facts: SummaryFact[]; events: ExecutionEventRecord[] }
  }

  it('extractFacts 还原出的正文与 result.facts 逐条一致', () => {
    expect(extractFacts(result.events)).toEqual(result.facts)
  })

  it('extractFactCount 与 result.facts 的条数一致', () => {
    expect(extractFactCount(result.events)).toBe(result.facts.length)
  })

  it('timeline 那行只显示条数，不被 facts 撑爆', () => {
    const completed = result.events.find((e) => e.type === 'task_completed')

    expect(summarizePayload('task_completed', completed?.payload)).toBe(
      `产出 ${result.facts.length} 条摘要`
    )
  })
})

// ---- TASK-023：Reminder 在时间线与批准面板的展示 ----

describe('summarizePayload：reminder_created', () => {
  it('时间渲染成本地格式 + 通知内容，「今晚」解析成几点要一眼看见', () => {
    const line = summarizePayload('reminder_created', {
      reminderId: 'r-1',
      toolCallId: 'tc-1',
      remindAt: '2099-01-01T00:00:00.000Z',
      message: '该读书了'
    })

    expect(line).toContain('提醒时间：')
    expect(line).toContain(formatOccurredAt('2099-01-01T00:00:00.000Z'))
    expect(line).toContain('该读书了')
  })

  it('缺 remindAt 只显示内容；两者都缺退回原始 payload，不给空行', () => {
    expect(summarizePayload('reminder_created', { message: '该读书了' })).toBe('该读书了')

    const fallback = summarizePayload('reminder_created', { reminderId: 'r-1' })
    expect(fallback).toContain('r-1')
    expect(fallback.trim().length).toBeGreaterThan(0)
  })

  it('describeEvent 给中文标签「创建提醒」', () => {
    const view = describeEvent(ev('reminder_created', { remindAt: '2099-01-01T00:00:00.000Z' }))
    expect(view.label).toBe('创建提醒')
  })
})

describe('describeReminderPreview', () => {
  const canonical = JSON.stringify({
    remindAt: '2099-01-01T00:00:00.000Z',
    message: '该读书了'
  })

  it('scheduler.create + 合法 argsCanonical → 时间与内容', () => {
    expect(
      describeReminderPreview({ capability: 'scheduler.create', argsCanonical: canonical })
    ).toEqual({ remindAt: '2099-01-01T00:00:00.000Z', message: '该读书了' })
  })

  it('缺 message → remindAt 照常给，message 为 null：时间预览不陪葬', () => {
    const noMessage = JSON.stringify({ remindAt: '2099-01-01T00:00:00.000Z' })
    expect(
      describeReminderPreview({ capability: 'scheduler.create', argsCanonical: noMessage })
    ).toEqual({ remindAt: '2099-01-01T00:00:00.000Z', message: null })
  })

  it('非 scheduler.create 一律 null：文件类能力的展示不受影响', () => {
    expect(
      describeReminderPreview({
        capability: 'filesystem.move',
        argsCanonical: JSON.stringify({ source: 'D:/a.pdf', target: 'D:/Reading/a.pdf' })
      })
    ).toBeNull()
  })

  it('argsCanonical 是脏数据时返回 null 不抛：Dialog 退回通用展示', () => {
    expect(
      describeReminderPreview({ capability: 'scheduler.create', argsCanonical: 'not json' })
    ).toBeNull()
    expect(
      describeReminderPreview({
        capability: 'scheduler.create',
        argsCanonical: JSON.stringify({ message: 'x' })
      })
    ).toBeNull()
    expect(
      describeReminderPreview({
        capability: 'scheduler.create',
        argsCanonical: JSON.stringify({ remindAt: 42 })
      })
    ).toBeNull()
  })
})

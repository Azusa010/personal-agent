import { describe, expect, it } from 'vitest'

import type { PlanStep } from '../../shared/domain'
import { checkAlignment } from './alignment'

// 与 Python 侧 planning.make_plan 的三步逐字一致。第三步没有 capability 键
//（不是 null），这是 model_dump(exclude_none=True) 的结果。
const PLAN: readonly PlanStep[] = [
  { description: '列出 Downloads 下的 PDF', capability: 'filesystem.list' },
  { description: '提取目标 PDF 的每页文本', capability: 'document.extract_pdf' },
  { description: '基于页面内容生成带页码引用的摘要' }
]

// 这份计划只有两步带 capability，所以合法的 executedCalls 只有 0 和 1。
const SEQUENCE = ['filesystem.list', 'document.extract_pdf']

describe('checkAlignment：按计划顺序放行', () => {
  it('第 1 次调用对得上第 1 个带 capability 的步骤', () => {
    expect(checkAlignment(PLAN, 0, 'filesystem.list')).toEqual({ aligned: true })
  })

  it('第 2 次调用对得上第 2 个带 capability 的步骤', () => {
    expect(checkAlignment(PLAN, 1, 'document.extract_pdf')).toEqual({ aligned: true })
  })

  it('aligned 是字面量 true，不是真值', () => {
    // 判别联合靠这个字段收窄。写成 1 或 'yes' 的话 TS 会当场报错，
    // 但写成 { aligned: true, reason: '...' } 这种多余字段不会——
    // 所以这里连形状一起钉。
    const out = checkAlignment(PLAN, 0, SEQUENCE[0] as string)

    expect(out).toEqual({ aligned: true })
    expect(Object.keys(out)).toEqual(['aligned'])
  })

  it('没有 capability 的步骤不参与计数', () => {
    // 三步计划里只有两个带 capability。把第三步也算进去的话，
    // 序号会整体错位一格，第二次调用就永远对不上。
    for (const step of PLAN) {
      if (step.capability === undefined) continue
      expect(SEQUENCE).toContain(step.capability)
    }
    expect(SEQUENCE).toHaveLength(2)
    expect(PLAN.filter((s) => s.capability === undefined)).toHaveLength(1)
  })

  it('单步计划：第 1 次放行，第 2 次超出', () => {
    const single: readonly PlanStep[] = [
      { description: '只列一次', capability: 'filesystem.list' },
      { description: '收尾，不调工具' }
    ]

    expect(checkAlignment(single, 0, 'filesystem.list')).toEqual({ aligned: true })
    expect(checkAlignment(single, 1, 'filesystem.list').aligned).toBe(false)
  })
})

describe('checkAlignment：跑偏', () => {
  it('第 1 次就调第二个能力 -> not aligned，reason 逐字钉住', () => {
    const out = checkAlignment(PLAN, 0, 'document.extract_pdf')

    expect(out.aligned).toBe(false)
    // 逐字而不是 toContain：这条 reason 会原样进 timeline 事件，
    // 是事后唯一能看出模型跑偏到哪一步的地方，措辞漂了就得有人看见。
    expect(!out.aligned && out.reason).toBe(
      '第 1 次 tool call 期望 filesystem.list，实际是 document.extract_pdf'
    )
  })

  it('第 2 次重复调第一个能力 -> not aligned', () => {
    const out = checkAlignment(PLAN, 1, 'filesystem.list')

    expect(!out.aligned && out.reason).toBe(
      '第 2 次 tool call 期望 document.extract_pdf，实际是 filesystem.list'
    )
  })

  it('能力名大小写不同 -> not aligned', () => {
    // 严格相等，不做归一化。放宽一次，registry 的唯一事实来源就作废了：
    // 'FileSystem.List' 既不在 registry 里也不在计划里，却能被放行。
    expect(checkAlignment(PLAN, 0, 'FileSystem.List').aligned).toBe(false)
  })

  it('计划里的能力用完之后再来一次 -> not aligned，reason 说清计划几步', () => {
    // 模型多调一次工具就是超出授权范围，这正是 Phase 2 要防的「不可绕过」。
    const out = checkAlignment(PLAN, 2, 'filesystem.list')

    expect(out.aligned).toBe(false)
    expect(!out.aligned && out.reason).toBe('计划只有 2 步带 capability，第 3 次调用超出了它')
  })

  it('远超计划长度同样是超出，序号跟着 executedCalls 走', () => {
    const out = checkAlignment(PLAN, 7, 'filesystem.list')

    expect(!out.aligned && out.reason).toBe('计划只有 2 步带 capability，第 8 次调用超出了它')
  })

  it('计划里一步 capability 都没有 -> 任何调用都超出', () => {
    const planless: readonly PlanStep[] = [{ description: '只想不做' }]

    const out = checkAlignment(planless, 0, 'filesystem.list')

    expect(out.aligned).toBe(false)
    expect(!out.aligned && out.reason).toBe('计划只有 0 步带 capability，第 1 次调用超出了它')
  })

  it('空计划 -> not aligned，而不是放行', () => {
    // 契约层 MakePlanResult 钉了 min(1)，所以生产上到不了这里。
    // 但「没有基准」必须判成拒绝：默认放行等于策略在数据缺失时失效。
    expect(checkAlignment([], 0, 'filesystem.list').aligned).toBe(false)
  })
})

describe('checkAlignment：纯函数', () => {
  it('不修改 plan', () => {
    const before = JSON.stringify(PLAN)

    checkAlignment(PLAN, 0, 'filesystem.list')
    checkAlignment(PLAN, 5, 'document.extract_pdf')

    expect(JSON.stringify(PLAN)).toBe(before)
    expect(PLAN).toHaveLength(3)
  })

  it('同一个输入两次调用结果相同', () => {
    // 判定不可复现的话，「Deny 为零副作用 / Allow 精确执行一次」这条 Exit Gate
    // 就没法验证：同一个调用跑两遍得到两个结论，重放测试毫无意义。
    const first = checkAlignment(PLAN, 1, 'filesystem.list')
    const second = checkAlignment(PLAN, 1, 'filesystem.list')

    expect(first).toEqual(second)
  })

  it('capability 里带路径分隔符也不影响判定', () => {
    // 只是当字符串比，不该被解析成路径或能力层级。
    expect(checkAlignment(PLAN, 0, 'filesystem.list/../../etc').aligned).toBe(false)
  })
})

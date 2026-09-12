import { describe, it, expect } from 'vitest'
import { PHASE1_PLAN_STEPS } from './plan-template'
import { findCapability } from '../capabilities/registry'
import type { PlanStep } from '../product-state/plan-repository'

describe('PHASE1_PLAN_STEPS', () => {
  it('三步钉死：list → extract → summary，第三步没有 capability', () => {
    // 第三步的摘要由模型自己产出，不经过 host 工具。
    // 给它编一个 capability 会让 UI 显示一个不存在的工具调用。
    expect(PHASE1_PLAN_STEPS.map((s) => s.capability)).toEqual([
      'filesystem.list',
      'document.extract_pdf',
      undefined
    ])
  })

  it('每个 capability 都在 registry 里且是 READ', () => {
    // Phase 1 是只读链路。Plan 里出现 WRITE 能力就是范围漂移，
    // 而 Scope 只放行 READ，模型看得见却调不动。
    for (const step of PHASE1_PLAN_STEPS) {
      if (step.capability === undefined) continue
      const found = findCapability(step.capability)
      expect(found, `${step.capability} 不在 registry 里`).not.toBeNull()
      expect(found?.kind, `${step.capability} 不是 READ`).toBe('READ')
    }
  })

  it('description 全部非空且互不重复', () => {
    const descriptions = PHASE1_PLAN_STEPS.map((s) => s.description)
    for (const d of descriptions) {
      expect(d.trim().length, 'description 不能是空白').toBeGreaterThan(0)
    }
    expect(new Set(descriptions).size).toBe(descriptions.length)
  })

  it('可直接交给 SqlitePlanRepository.append（PlanStep[] 而非 readonly）', () => {
    // append 吃的是 PlanStep[]，模板是 readonly PlanStep[]，
    // 调用方要展开一次。这条钉住展开后的形状没被改坏。
    const steps: PlanStep[] = [...PHASE1_PLAN_STEPS]
    expect(steps).toHaveLength(3)
    expect(steps[0]).toEqual({
      description: '列出 Downloads 下的 PDF',
      capability: 'filesystem.list'
    })
  })
})

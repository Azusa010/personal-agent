import type { PlanStep } from '../product-state/plan-repository'

export const PHASE1_PLAN_STEPS: readonly PlanStep[] = [
  { description: '列出 Downloads 下的 PDF', capability: 'filesystem.list' },
  { description: '提取目标 PDF 的每页文本', capability: 'document.extract_pdf' },
  { description: '基于页面内容生成带页码引用的摘要' }
]

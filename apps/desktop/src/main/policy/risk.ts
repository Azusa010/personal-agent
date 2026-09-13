import type { CapabilityDescriptor } from '@personal-agent/protocol'

/** 一次调用的风险等级。
 */
export type RiskLevel = 'NONE' | 'PERMISSION_REQUIRED'

export interface RiskAssessment {
  level: RiskLevel
  /** 判定依据。会进 timeline 事件，是事后唯一能看懂「为什么被拦」的地方。 */
  reason: string
}

export function assessRisk(capability: CapabilityDescriptor): RiskAssessment {
  if (capability.kind === 'WRITE') {
    return {
      level: 'PERMISSION_REQUIRED',
      reason: `${capability.name} 是 WRITE，会产生副作用，必须绑定 Permission`
    }
  }
  return { level: 'NONE', reason: `${capability.name} 是 READ，无副作用` }
}

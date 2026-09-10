import { CapabilityDescriptor, findCapability, listCapabilities } from './registry'
import { isInScope, TaskScope } from './scope'

export type AuthorizeDenialCode = 'CAPABILITY_NOT_REGISTERED' | 'CAPABILITY_OUT_OF_SCOPE'

// 判别联合类型
export type AuthorizeResult =
  | { allowed: true; capability: CapabilityDescriptor }
  | { allowed: false; code: AuthorizeDenialCode; name: string; reason: string }

export interface ToolRetriever {
  /** 不可见门：Agent 能看到的能力，已按 Scope 过滤 */
  listVisible(scope: TaskScope): CapabilityDescriptor[]
  /** 不可执行门 */
  authorize(scope: TaskScope, name: string): AuthorizeResult
}

// 规则-based 的能力检索器
export class RuleBasedToolRetriever implements ToolRetriever {
  // 找到所有在 scope 之内的能力
  listVisible(scope: TaskScope): CapabilityDescriptor[] {
    return listCapabilities().filter((c) => isInScope(scope, c.name))
  }

  // 授权检查
  authorize(scope: TaskScope, name: string): AuthorizeResult {
    const capability = findCapability(name)
    if (capability === null) {
      return {
        allowed: false,
        code: 'CAPABILITY_NOT_REGISTERED',
        name,
        reason: `未注册的能力: ${name}`
      }
    }

    if (!isInScope(scope, name)) {
      return {
        allowed: false,
        code: 'CAPABILITY_OUT_OF_SCOPE',
        name,
        reason: `能力 ${name} 不在任务 ${scope.taskId} 的 Scope 内`
      }
    }

    return { allowed: true, capability }
  }
}

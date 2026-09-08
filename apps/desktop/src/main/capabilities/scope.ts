import { CapabilityName, listByKind } from './registry'

export interface TaskScope {
  taskId: string
  capabilities: CapabilityName[]
}

export function readOnlyScope(taskId: string): TaskScope {
  return {
    taskId,
    capabilities: listByKind('READ').map((c) => c.name as CapabilityName)
  }
}

export function isInScope(scope: TaskScope, name: string): boolean {
  return (scope.capabilities as readonly string[]).includes(name)
}

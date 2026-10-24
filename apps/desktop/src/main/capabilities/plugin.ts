import type { CapabilityDescriptor, CapabilityExposure, CapabilityKind } from './registry'
import type { BoundArgs, BindResult } from '../policy/argument-binders'
import type { AuthorizedCall } from '../policy/execution-policy'
export type { AuthorizedCall }
import type { RecoveryVerdict } from './idempotency'
import type { ToolExecutionRecord } from '../product-state/tool-execution-repository'
import type { ReminderRecord } from '../../shared/domain'
import type { SqliteDatabase } from '../product-state/database'
import type { ReminderRepository } from '../product-state/reminder-repository'
import type { EventRepository } from '../product-state/event-repository'
import type { NotificationPort } from '../notifications/notification-port'

export type CapabilityOutcome = Record<string, unknown>

export interface PermissionPaths {
  readonly sourcePaths: string[]
  readonly targetPath: string | null
}

export interface ExecutorSchedulerWiring {
  readonly db: SqliteDatabase
  readonly reminders: ReminderRepository
  readonly events: EventRepository
  readonly now?: () => string
  readonly newId?: () => string
  readonly notifications?: NotificationPort
  readonly armTimer?: (reminder: ReminderRecord) => void
}

export interface ExecutorKnowledgeWiring {
  readonly search: (params: Record<string, unknown>) => Promise<Record<string, unknown>>
}

export interface ExecutorMemoryWiring {
  readonly search: (params: Record<string, unknown>) => Promise<Record<string, unknown>>
}

export interface CapabilityPluginContext {
  readonly scheduler?: ExecutorSchedulerWiring
  readonly knowledge?: ExecutorKnowledgeWiring
  readonly memory?: ExecutorMemoryWiring
}

export interface CapabilityPluginIdempotency {
  readonly isWrite: boolean
  extractSideEffects?(bound: BoundArgs): PermissionPaths
  resolveRecovery?(record: ToolExecutionRecord): Promise<RecoveryVerdict>
}

export interface CapabilityPluginDescriptor {
  readonly name: string
  readonly kind: CapabilityKind
  readonly description: string
  readonly exposure?: CapabilityExposure
}

/**
 * 自描述能力插件 (CapabilityPlugin)。
 * 将能力元数据、参数契约校验、权限路径提取、幂等与崩溃恢复及执行体高内聚收敛，
 * 消除散落在多个分发器中的 switch-case，符合开闭原则（OCP）。
 */
export interface CapabilityPlugin {
  readonly name: string
  readonly descriptor: CapabilityDescriptor | CapabilityPluginDescriptor

  /** 契约校验与路径规范化 (Path-Guard) */
  bindArguments(args: Record<string, unknown>): Promise<BindResult>

  /** 权限路径提取（供 permission-broker 使用） */
  extractPermissionPaths?(bound: BoundArgs): PermissionPaths

  /** 幂等与崩溃恢复策略（供 idempotency 使用） */
  readonly idempotency?: CapabilityPluginIdempotency

  /** 副作用执行体 */
  execute(call: AuthorizedCall, context: CapabilityPluginContext): Promise<CapabilityOutcome>
}

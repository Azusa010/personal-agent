import { describe, expect, it } from 'vitest'

import { listCapabilities } from './registry'
import {
  getCapabilityPlugin,
  listCapabilityPlugins,
  registerCapabilityPlugin,
  type CapabilityPlugin
} from './plugins'
import { bindArguments } from '../policy/argument-binders'
import { isWriteCapability, resolveExecution } from './idempotency'
import { createExecutor } from './executor'
import { UI_ORIGIN } from '../policy/execution-policy'
import type { TaskScope } from './scope'
import type { ToolExecutionRecord } from '../product-state/tool-execution-repository'
import type { PermissionRecord } from '../../shared/domain'
import type { CapabilityId } from '@personal-agent/protocol'

describe('CapabilityPlugin 架构与完整性验证', () => {
  it('所有内建能力均有对应的 CapabilityPlugin 实现', () => {
    const registryCaps = listCapabilities()
    const plugins = listCapabilityPlugins()

    expect(plugins.length).toBeGreaterThanOrEqual(registryCaps.length)

    for (const cap of registryCaps) {
      const plugin = getCapabilityPlugin(cap.name)
      expect(plugin, `缺少能力插件: ${cap.name}`).toBeDefined()
      expect(plugin?.name).toBe(cap.name)
      expect(plugin?.descriptor.kind).toBe(cap.kind)
      expect(plugin?.descriptor.description).toBe(cap.description)
    }
  })

  it('支持运行时动态注册自定义插件并打通 4 大子系统', async () => {
    const customToolName = 'custom_mock_tool'
    const customPlugin: CapabilityPlugin = {
      name: customToolName,
      descriptor: {
        name: customToolName,
        kind: 'WRITE',
        description: '自定义测试工具'
      },
      async bindArguments(args) {
        if (args['value'] !== 'valid') {
          return { ok: false, code: 'INVALID_ARGUMENT', reason: 'value 必须为 valid' }
        }
        return {
          ok: true,
          bound: {
            args: { value: 'valid' },
            paths: { target: '/mock/path' }
          }
        }
      },
      extractPermissionPaths(bound) {
        return {
          sourcePaths: [],
          targetPath: bound.paths['target'] ?? null
        }
      },
      idempotency: {
        isWrite: true,
        async resolveRecovery() {
          return { kind: 'done' }
        }
      },
      async execute(call) {
        return { ok: true, executed: true, val: call.bound.args['value'] }
      }
    }

    // 1. 动态注册
    registerCapabilityPlugin(customPlugin)
    expect(getCapabilityPlugin(customToolName)).toBe(customPlugin)

    // 2. 子系统 1: argument-binders 参数校验绑定
    const invalidBind = await bindArguments(customToolName, { value: 'wrong' })
    expect(invalidBind.ok).toBe(false)

    const validBind = await bindArguments(customToolName, { value: 'valid' })
    expect(validBind.ok).toBe(true)
    if (!validBind.ok) return

    // 3. 子系统 2: permission 路径提取
    const permissionPaths = customPlugin.extractPermissionPaths?.(validBind.bound)
    expect(permissionPaths).toEqual({
      sourcePaths: [],
      targetPath: '/mock/path'
    })

    // 4. 子系统 3: idempotency 幂等与恢复
    expect(isWriteCapability(customToolName)).toBe(true)
    const mockRecord: ToolExecutionRecord = {
      idempotencyKey: 't1:custom_mock_tool:hash',
      taskId: 't1',
      toolCallId: 'c1',
      capability: customToolName,
      argsHash: 'hash',
      sourcePaths: [],
      targetPath: '/mock/path',
      status: 'attempting',
      attemptedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: null,
      resultPayload: null
    }
    const verdict = await resolveExecution(mockRecord)
    expect(verdict).toEqual({ kind: 'done' })

    // 5. 子系统 4: executor 策略与执行（带批准门禁）
    const scope: TaskScope = {
      taskId: 't1',
      capabilities: [customToolName as unknown as CapabilityId]
    }
    const permission = {
      gate: {
        request: async () => ({
          approved: true as const,
          permission: {} as unknown as PermissionRecord
        }),
        verify: async () => ({ ok: true as const })
      }
    }
    const executor = createExecutor(scope, UI_ORIGIN, undefined, permission)
    const result = await executor({
      callId: 'c1',
      capability: customToolName as unknown as CapabilityId,
      arguments: { value: 'valid' }
    })

    expect(result).toEqual({ ok: true, executed: true, val: 'valid' })
  })
})

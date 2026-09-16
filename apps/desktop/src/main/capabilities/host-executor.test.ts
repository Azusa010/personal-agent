import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CapabilityFailure,
  ERROR_CODE,
  FilesystemListResult,
  HostExecuteToolParams,
  HostExecuteToolResult
} from '@personal-agent/protocol'

import {
  configureHostExecutor,
  executeCapability,
  executeHostTool,
  listVisibleCapabilities,
  resetHostExecutorWiring
} from './host-executor'
import { beginTask, endTask } from '../policy/task-context'
import type { BoundArgs } from '../policy/argument-binders'
import type { PermissionGateOutcome, PermissionVerifyOutcome } from '../policy/execution-policy'
import type { PlanStep } from '../../shared/domain'

const ENV_NAME = 'PERSONAL_AGENT_DOWNLOADS_DIR'

// executeHostTool 走 agent origin，必须有当前任务、调用还得对齐计划。
// 这份就是 planning.make_plan 的字面值（TASK-028 起五步加摘要），顺序与
// AGENT_TASK_CAPABILITIES 逐字对应。
const PLAN: readonly PlanStep[] = [
  { description: '列出 Downloads 下的 PDF', capability: 'filesystem.list' },
  { description: '提取目标 PDF 的每页文本', capability: 'document.extract_pdf' },
  { description: '在 Downloads 下创建 Reading 目录', capability: 'filesystem.create_dir' },
  { description: '把选中的 PDF 移到 Reading', capability: 'filesystem.move' },
  { description: '创建一次性阅读提醒', capability: 'scheduler.create' },
  { description: '基于页面内容生成带页码引用的摘要' }
]

// 单步计划：只测「第一个 WRITE 调用」时不必先跑完 list / extract——
// 对齐按序号比对，计划第一步写什么，第 1 次调用就得是什么。
const WRITE_FIRST_PLAN: readonly PlanStep[] = [
  { description: '在 Downloads 下创建 Reading 目录', capability: 'filesystem.create_dir' }
]

let dir: string

function hostParams(
  callId: string,
  capability: string,
  args: Record<string, unknown>
): HostExecuteToolParams {
  return HostExecuteToolParams.parse({ callId, capability, arguments: args })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-host-'))
  vi.stubEnv(ENV_NAME, dir)
})

afterEach(async () => {
  // 单槽：漏了 endTask，下一个测试文件的 executeHostTool 会全数吃 NO_ACTIVE_TASK。
  endTask()
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

describe('executeCapability: IPC 网关', () => {
  it('合法调用走通并返回 entries', async () => {
    // 整个文件从没碰过 runtime-host，这条绿了就说明 executor 单例
    // 与 Python 子进程生命周期解耦：Python 没启动也能列举。
    await writeFile(join(dir, 'a.pdf'), 'A')

    const out = await executeCapability('filesystem.list', { rootId: 'downloads' })

    expect(out['ok']).toBe(true)
    expect(out['entries']).toEqual([expect.objectContaining({ name: 'a.pdf', sizeBytes: 1 })])
  })

  it('capability 名不在 CapabilityId 里时被网关层拒', async () => {
    const out = await executeCapability('filesystem.nope', {})

    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.INVALID_ARGUMENT)
    // 网关层与执行体层拒的都是 INVALID_ARGUMENT，只能靠 reason 分辨是谁拒的。
    expect(String(out['reason'])).toContain('capability 或 arguments')
  })

  it('arguments 非法时被执行体层拒，reason 指向 filesystem.list', async () => {
    const out = await executeCapability('filesystem.list', { rootId: 'secrets' })

    expect(out['code']).toBe(ERROR_CODE.INVALID_ARGUMENT)
    expect(String(out['reason'])).toContain('filesystem.list 参数')
  })

  it('WRITE 能力被拒，证明网关用的是 readOnlyScope', async () => {
    const out = await executeCapability('filesystem.move', { from: 'a', to: 'b' })

    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.CAPABILITY_OUT_OF_SCOPE)
    expect(() => CapabilityFailure.parse(out)).not.toThrow()
  })

  it('成功输出同时过 envelope 层与 payload 层契约', async () => {
    const out = await executeCapability('filesystem.list', { rootId: 'downloads' })

    expect(() => HostExecuteToolResult.parse(out)).not.toThrow()
    expect(() => FilesystemListResult.parse(out)).not.toThrow()
  })

  it('单例不缓存失败状态：上一次根不可用不影响下一次', async () => {
    vi.stubEnv(ENV_NAME, join(dir, 'nope'))
    const first = await executeCapability('filesystem.list', { rootId: 'downloads' })
    expect(first['ok']).toBe(false)

    vi.stubEnv(ENV_NAME, dir)
    await writeFile(join(dir, 'b.pdf'), 'BB')
    const second = await executeCapability('filesystem.list', { rootId: 'downloads' })

    expect(second['ok']).toBe(true)
    expect(second['entries']).toEqual([expect.objectContaining({ name: 'b.pdf', sizeBytes: 2 })])
  })
})

describe('executeHostTool: supervisor 网关', () => {
  it('与 executeCapability 对同一输入给同样结果（READ 部分）', async () => {
    // 两个入口共用同一个 retriever 与同一张能力表，只差 origin 与 Scope 的写权限：
    // READ 结果不一致就说明分发漂了，TEST-005 的「单一关口」也就不成立。
    await writeFile(join(dir, 'c.pdf'), 'CCC')
    beginTask('task-host', '整理 PDF', PLAN)

    const viaHost = await executeHostTool(
      hostParams('tc-1', 'filesystem.list', { rootId: 'downloads' })
    )
    const viaIpc = await executeCapability('filesystem.list', { rootId: 'downloads' })

    expect(viaHost).toEqual(viaIpc)
  })

  it('WRITE 在 agent 这条的 Scope 内，只是没接权限通道时被拒（fail-closed）', async () => {
    // 与 ui 那条的差别正在这里：ui 是 CAPABILITY_OUT_OF_SCOPE（压根不在只读 Scope 里），
    // agent 是 PERMISSION_REQUIRED（在 Scope 里、但没有人能批准）。
    beginTask('task-host', '整理 PDF', WRITE_FIRST_PLAN)

    const viaHost = await executeHostTool(
      hostParams('tc-2', 'filesystem.create_dir', { path: join(dir, 'Reading') })
    )
    const viaIpc = await executeCapability('filesystem.move', { source: 'a', target: 'b' })

    expect(viaHost['ok']).toBe(false)
    expect(viaHost['code']).toBe(ERROR_CODE.PERMISSION_REQUIRED)
    expect(viaIpc['code']).toBe(ERROR_CODE.CAPABILITY_OUT_OF_SCOPE)
  })

  it('根不可用时返回精确码而不是冒泡成异常', async () => {
    // 冒泡的话 supervisor 的 catch 会把 code 写死成 HOST_HANDLER_FAILED，
    // Python engine 就分不清是权限问题还是崩溃。
    vi.stubEnv(ENV_NAME, join(dir, 'nope'))
    beginTask('task-host', '整理 PDF', PLAN)

    const out = await executeHostTool(
      hostParams('tc-3', 'filesystem.list', { rootId: 'downloads' })
    )

    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.FILESYSTEM_ROOT_UNAVAILABLE)
    expect(() => CapabilityFailure.parse(out)).not.toThrow()
  })

  it('没有当前任务时拒绝：这是 agent origin 与 ui origin 唯一的分岭', async () => {
    // 两个断言必须一起看：executeHostTool 拒、executeCapability 不拒。
    // 把它们弄成同一个 origin（任一方向）都会让其中一条红。
    const viaHost = await executeHostTool(
      hostParams('tc-4', 'filesystem.list', { rootId: 'downloads' })
    )
    const viaIpc = await executeCapability('filesystem.list', { rootId: 'downloads' })

    expect(viaHost['ok']).toBe(false)
    expect(viaHost['code']).toBe(ERROR_CODE.NO_ACTIVE_TASK)
    expect(viaIpc['ok']).toBe(true)
  })

  it('任务结束后槽位真的让了出来', async () => {
    // endTask 漏了的话 run-task.ts 的 finally 就是个装饰，
    // 下一个任务永远吃 TASK_BUSY。这里从网关这一头反向验证。
    beginTask('task-host', '整理 PDF', PLAN)
    endTask()

    const out = await executeHostTool(
      hostParams('tc-5', 'filesystem.list', { rootId: 'downloads' })
    )

    expect(out['code']).toBe(ERROR_CODE.NO_ACTIVE_TASK)
  })
})

describe('listVisibleCapabilities: 握手时下发的清单', () => {
  it('两个 READ 加三个 WRITE，顺序与计划一致', () => {
    // TASK-028 起模型要能看见完整 Golden Path 的五个工具（少一个就走不完计划）。
    // 顺序也要钉：清单每次不一样的话，REQ-010 的连续 20 次就无法靠快照对比定位。
    expect(listVisibleCapabilities().map((c) => c.name)).toEqual([
      'filesystem.list',
      'document.extract_pdf',
      'filesystem.create_dir',
      'filesystem.move',
      'scheduler.create'
    ])
  })

  it('不带 notification.send，且每项都有非空 description', () => {
    // notification.send 由 Reminder 到点触发，不是模型能自选的动作。
    const names = listVisibleCapabilities().map((c) => c.name)
    expect(names).not.toContain('notification.send')

    for (const c of listVisibleCapabilities()) {
      expect(c.description.length, c.name).toBeGreaterThan(0)
    }
  })

  it('下发的清单与 agent 那条实际放行的一致：没有一个是 OUT_OF_SCOPE', async () => {
    // 清单里有但 executor 因 Scope 拒，意味着握手骗了模型：它会反复提一个永远不会
    // 被放行的能力，直到预算耗尽。WRITE 在没接权限通道时回 PERMISSION_REQUIRED ——
    // 那是「有人能批准才放行」，与 OUT_OF_SCOPE 不是一回事。
    beginTask('task-visible', '整理 PDF', PLAN)

    for (const c of listVisibleCapabilities()) {
      const out = await executeHostTool(hostParams(`tc-visible-${c.name}`, c.name, {}))
      expect(out['code'], c.name).not.toBe(ERROR_CODE.CAPABILITY_OUT_OF_SCOPE)
    }
  })
})

describe('configureHostExecutor: 生产接线', () => {
  afterEach(() => {
    resetHostExecutorWiring()
  })

  /** 只会说「批准」的假批准通道，记下每一次请求。真 broker 的行为在 security-matrix 里测。 */
  function approvingGate(requests: { taskId: string; capability: string }[]): {
    request(input: {
      taskId: string
      capability: string
      bound: BoundArgs
    }): Promise<PermissionGateOutcome>
    verify(): Promise<PermissionVerifyOutcome>
  } {
    return {
      async request(input): Promise<PermissionGateOutcome> {
        requests.push({ taskId: input.taskId, capability: input.capability })
        return { approved: true }
      },
      async verify(): Promise<PermissionVerifyOutcome> {
        return { ok: true }
      }
    }
  }

  it('接上批准通道之后 WRITE 真的执行，且归属键是当前任务', async () => {
    const requests: { taskId: string; capability: string }[] = []
    configureHostExecutor({ permission: { gate: approvingGate(requests) } })
    beginTask('task-wired', '整理 PDF', WRITE_FIRST_PLAN)

    const out = await executeHostTool(
      hostParams('tc-w1', 'filesystem.create_dir', { path: join(dir, 'Reading') })
    )

    expect(out['ok']).toBe(true)
    // Scope 每次按当前任务现取：权限记录、任务状态回推、幂等表都按这个 taskId 归属，
    // 用固定值（bootstrap）会把三种记录全挂到一个不存在的任务上。
    expect(requests).toEqual([{ taskId: 'task-wired', capability: 'filesystem.create_dir' }])
  })

  it('用户拒绝时交给 policy 收场：不改目录、回拒绝码', async () => {
    configureHostExecutor({
      permission: {
        gate: {
          async request(): Promise<PermissionGateOutcome> {
            return { approved: false, code: ERROR_CODE.PERMISSION_DENIED, reason: '用户拒绝' }
          },
          async verify(): Promise<PermissionVerifyOutcome> {
            return { ok: true }
          }
        }
      }
    })
    beginTask('task-denied', '整理 PDF', WRITE_FIRST_PLAN)

    const out = await executeHostTool(
      hostParams('tc-w2', 'filesystem.create_dir', { path: join(dir, 'Reading') })
    )

    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.PERMISSION_DENIED)
  })

  it('接线只影响 agent 那条：ui 那条仍然只有只读 Scope，不挂批准', async () => {
    const requests: { taskId: string; capability: string }[] = []
    configureHostExecutor({ permission: { gate: approvingGate(requests) } })

    const out = await executeCapability('filesystem.create_dir', { path: join(dir, 'Reading') })

    expect(out['code']).toBe(ERROR_CODE.CAPABILITY_OUT_OF_SCOPE)
    expect(requests).toEqual([])
  })
})

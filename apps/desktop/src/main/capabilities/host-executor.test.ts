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

import { executeCapability, executeHostTool, listVisibleCapabilities } from './host-executor'
import { beginTask, endTask } from '../policy/task-context'
import type { PlanStep } from '../../shared/domain'

const ENV_NAME = 'PERSONAL_AGENT_DOWNLOADS_DIR'

// executeHostTool 走 agent origin，必须有当前任务、调用还得对齐计划。
// 这份就是 planning.make_plan 的字面值：第三步没有 capability 键。
const PLAN: readonly PlanStep[] = [
  { description: '列出 Downloads 下的 PDF', capability: 'filesystem.list' },
  { description: '提取目标 PDF 的每页文本', capability: 'document.extract_pdf' },
  { description: '基于页面内容生成带页码引用的摘要' }
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
  it('与 executeCapability 对同一输入给同样结果', async () => {
    // 两个入口共用同一个 scope 与 retriever，只差 origin：结果不一致就说明
    // scope 或分发漂了，TEST-005 的「单一关口」也就不成立。
    await writeFile(join(dir, 'c.pdf'), 'CCC')
    beginTask('task-host', '整理 PDF', PLAN)

    const viaHost = await executeHostTool(
      hostParams('tc-1', 'filesystem.list', { rootId: 'downloads' })
    )
    const viaIpc = await executeCapability('filesystem.list', { rootId: 'downloads' })

    expect(viaHost).toEqual(viaIpc)
  })

  it('WRITE 能力同样被拒：两个网关共用同一个 scope', async () => {
    // Scope 检查排在「有没有当前任务」之前，所以这条不需要 beginTask。
    const out = await executeHostTool(hostParams('tc-2', 'filesystem.move', { from: 'a', to: 'b' }))

    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.CAPABILITY_OUT_OF_SCOPE)
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
  it('只含两个 READ 能力，顺序与 registry 一致', () => {
    // Phase 1 Exit Checklist 第 3 条：Agent 只见两个 READ Capability。
    // 顺序也要钉：清单每次不一样的话，REQ-010 的连续 20 次就无法靠快照对比定位。
    expect(listVisibleCapabilities().map((c) => c.name)).toEqual([
      'filesystem.list',
      'document.extract_pdf'
    ])
  })

  it('每项都是 READ 且带非空 description', () => {
    for (const c of listVisibleCapabilities()) {
      expect(c.kind, c.name).toBe('READ')
      expect(c.description.length, c.name).toBeGreaterThan(0)
    }
  })

  it('下发的清单与 executor 实际放行的一致', async () => {
    // 清单里有但 executor 因 scope 拒，意味着握手骗了模型：
    // 它会反复提一个永远不会被放行的能力，直到预算耗尽。
    for (const c of listVisibleCapabilities()) {
      const out = await executeCapability(c.name, {})
      expect(out['code'], c.name).not.toBe(ERROR_CODE.CAPABILITY_OUT_OF_SCOPE)
    }

    const write = await executeCapability('filesystem.move', { from: 'a', to: 'b' })
    expect(write['code']).toBe(ERROR_CODE.CAPABILITY_OUT_OF_SCOPE)
  })
})

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ERROR_CODE, type HostExecuteToolParams } from '@personal-agent/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { findCapability } from '../capabilities/registry'
import { RuleBasedToolRetriever, type ToolRetriever } from '../capabilities/retriever'
import { readOnlyScope, type TaskScope } from '../capabilities/scope'
import { toPosix } from '../capabilities/roots'
import type { PlanStep, TaskStatus } from '../../shared/domain'
import {
  AGENT_ORIGIN,
  createExecutionPolicy,
  UI_ORIGIN,
  type CallOrigin,
  type ExecutionPolicy,
  type PermissionGate,
  type PermissionGateOutcome,
  type PermissionVerifyOutcome,
  type TaskStatePort
} from './execution-policy'
import { beginTask, currentTask, endTask } from './task-context'
import type { BoundArgs } from './argument-binders'

const ENV_NAME = 'PERSONAL_AGENT_DOWNLOADS_DIR'
const TASK_ID = 'task-policy'

const PLAN: readonly PlanStep[] = [
  { description: '列出 Downloads 下的 PDF', capability: 'filesystem.list' },
  { description: '提取目标 PDF 的每页文本', capability: 'document.extract_pdf' },
  { description: '基于页面内容生成带页码引用的摘要' }
]

let dir: string
let realRoot: string

function params(
  callId: string,
  capability: HostExecuteToolParams['capability'],
  args: Record<string, unknown>
): HostExecuteToolParams {
  return { callId, capability, arguments: args }
}

/** 放行一切的 retriever，能力描述符仍取自真 registry。
 *  只用来把「Scope 之外」这一关单独摘掉，好看清 WRITE 能力在后面几关的顺序。 */
function allowRetriever(name: string): ToolRetriever {
  const found = findCapability(name)
  if (found === null) throw new Error(`registry 里没有 ${name}`)
  return { listVisible: () => [found], authorize: () => ({ allowed: true, capability: found }) }
}

function policy(
  origin: CallOrigin,
  retriever: ToolRetriever = new RuleBasedToolRetriever(),
  scope: TaskScope = readOnlyScope(TASK_ID)
): ExecutionPolicy {
  return createExecutionPolicy({ scope, retriever, origin })
}

function agentPolicy(retriever?: ToolRetriever): ExecutionPolicy {
  return policy(AGENT_ORIGIN, retriever)
}

const STAMP = '2026-09-14T09:00:00.000Z'

const MOVE_PLAN: readonly PlanStep[] = [{ description: '移动文件', capability: 'filesystem.move' }]

/** source 与 target 都在根内。target 还不存在，绑定器靠
 *  resolveWithinRootReal 对「不存在」的处理放行（只对最近的存在祖先做 realpath）。 */
function moveArgs(): Record<string, unknown> {
  return { source: `${realRoot}/a.pdf`, target: `${realRoot}/Reading/a.pdf` }
}

type GateInput = Parameters<PermissionGate['request']>[0]

interface FakeGate {
  readonly gate: PermissionGate
  /** request 收到的入参。批准面板展示的就是这里面的 bound.paths。 */
  readonly inputs: GateInput[]
  readonly verifyCalls: [string, BoundArgs][]
  /** hold 模式下手动结算 */
  release(outcome: PermissionGateOutcome): void
}

function makeGate(
  outcome: PermissionGateOutcome,
  opts: { verify?: PermissionVerifyOutcome; hold?: boolean } = {}
): FakeGate {
  const inputs: GateInput[] = []
  const verifyCalls: [string, BoundArgs][] = []
  let resolve: ((o: PermissionGateOutcome) => void) | null = null
  return {
    inputs,
    verifyCalls,
    release: (o) => resolve?.(o),
    gate: {
      request: (input) => {
        inputs.push(input)
        if (opts.hold !== true) return Promise.resolve(outcome)
        return new Promise<PermissionGateOutcome>((r) => {
          resolve = r
        })
      },
      verify: (toolCallId, bound) => {
        verifyCalls.push([toolCallId, bound])
        return Promise.resolve(opts.verify ?? { ok: true })
      }
    }
  }
}

/** 只记录调用，不碰库：策略要的就是 updateStatus 这一个方法。 */
function taskPort(): { calls: [string, TaskStatus, string][]; port: TaskStatePort } {
  const calls: [string, TaskStatus, string][] = []
  return {
    calls,
    port: {
      updateStatus: (id, status, at) => {
        calls.push([id, status, at])
      }
    }
  }
}

function policyWithGate(
  gate: PermissionGate,
  opts: {
    retriever?: ToolRetriever
    tasks?: TaskStatePort
    origin?: CallOrigin
    scope?: TaskScope
  } = {}
): ExecutionPolicy {
  return createExecutionPolicy({
    scope: opts.scope ?? readOnlyScope(TASK_ID),
    // WRITE 能力在 readOnlyScope 的第②关就会被拦，用放行一切的 retriever 把
    // 那一关单独摘掉，才能看清后面挂起与复查的顺序。
    retriever: opts.retriever ?? allowRetriever('filesystem.move'),
    origin: opts.origin ?? AGENT_ORIGIN,
    permissions: gate,
    tasks: opts.tasks,
    now: () => STAMP
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-policy-'))
  realRoot = toPosix(await realpath(dir))
  vi.stubEnv(ENV_NAME, dir)
})

afterEach(async () => {
  // 单槽：漏一次 endTask，后面每条 agent origin 的测试都活在别人的计划里。
  endTask()
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

describe('execution-policy：注册与 Scope（TEST-005）', () => {
  it('未注册的能力 -> CAPABILITY_NOT_REGISTERED', async () => {
    const deny: ToolRetriever = {
      listVisible: () => [],
      authorize: (_s, name) => ({
        allowed: false,
        code: 'CAPABILITY_NOT_REGISTERED',
        name,
        reason: `未注册的能力: ${name}`
      })
    }
    beginTask(TASK_ID, '整理 PDF', PLAN)

    const out = await agentPolicy(deny).evaluate(
      params('tc-1', 'filesystem.list', { rootId: 'downloads' })
    )

    expect(out.allowed).toBe(false)
    expect(!out.allowed && out.code).toBe(ERROR_CODE.CAPABILITY_NOT_REGISTERED)
  })

  it('Scope 外的 WRITE -> CAPABILITY_OUT_OF_SCOPE', async () => {
    beginTask(TASK_ID, '整理 PDF', PLAN)

    const out = await agentPolicy().evaluate(
      params('tc-2', 'filesystem.move', { from: 'a', to: 'b' })
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.CAPABILITY_OUT_OF_SCOPE)
  })

  it('Scope 检查排在「有没有当前任务」之前', async () => {
    // 顺序即语义：能力压根不许用，就没必要去看它在不在计划里。
    // 反过来排的话，同一次越权调用会在有无任务两种情况下报两个不同的码，
    // RISK-005 的「越权」在日志里就统计不稳。
    const out = await agentPolicy().evaluate(
      params('tc-3', 'filesystem.move', { from: 'a', to: 'b' })
    )

    expect(currentTask()).toBeNull()
    expect(!out.allowed && out.code).toBe(ERROR_CODE.CAPABILITY_OUT_OF_SCOPE)
  })

  it('Deny 为零副作用：拒绝路径上执行体一次都没跑', async () => {
    // 根指向不存在的目录。若判定顺序漂了、先碰了文件系统，
    // 这里会得到 FILESYSTEM_ROOT_UNAVAILABLE 而不是 CAPABILITY_OUT_OF_SCOPE。
    vi.stubEnv(ENV_NAME, join(dir, 'nope'))
    beginTask(TASK_ID, '整理 PDF', PLAN)

    const out = await agentPolicy().evaluate(
      params('tc-4', 'filesystem.move', { from: 'a', to: 'b' })
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.CAPABILITY_OUT_OF_SCOPE)
  })
})

describe('execution-policy：agent 必须有当前任务', () => {
  it('没有当前任务 -> NO_ACTIVE_TASK', async () => {
    const out = await agentPolicy().evaluate(
      params('tc-5', 'filesystem.list', { rootId: 'downloads' })
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.NO_ACTIVE_TASK)
    // reason 里要带能力名，否则日志上看不出是哪次调用没任务。
    expect(!out.allowed && out.reason).toContain('filesystem.list')
  })

  it('任务检查排在风险检查之前', async () => {
    // 没有比对基准时，连「这次调用该不该授权」都不该判：
    // 先判风险会让一次身份不明的调用进 Permission 流程。
    const out = await agentPolicy(allowRetriever('scheduler.create')).evaluate(
      params('tc-6', 'scheduler.create', {})
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.NO_ACTIVE_TASK)
  })

  it('beginTask 之后同一个调用就放行了', async () => {
    beginTask(TASK_ID, '整理 PDF', PLAN)

    const out = await agentPolicy().evaluate(
      params('tc-7', 'filesystem.list', { rootId: 'downloads' })
    )

    expect(out.allowed).toBe(true)
  })

  it('ui origin 没有任务也放行：这是两条入口唯一的分岭', async () => {
    // renderer 的 IPC 服务「打开窗口就看见文件列表」，它没有计划可比。
    // 把 ui 也要求有任务，等于把 UI 打死；把 agent 放宽，Phase 2 就白做了。
    const out = await policy(UI_ORIGIN).evaluate(
      params('tc-8', 'filesystem.list', { rootId: 'downloads' })
    )

    expect(currentTask()).toBeNull()
    expect(out.allowed).toBe(true)
  })

  it('ui origin 一样要过风险关', async () => {
    // 分岭只在「有没有任务、对不对齐」两关，其余几关两条路都走。
    // 用 filesystem.move 而不是 scheduler.create：后者没有绑定器，
    // 在新的顺序下会先撞 NOT_IMPLEMENTED，测不到它声称要测的风险关。
    const out = await policy(UI_ORIGIN, allowRetriever('filesystem.move')).evaluate(
      params('tc-9', 'filesystem.move', moveArgs())
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.PERMISSION_REQUIRED)
  })
})

describe('execution-policy：ActionAlignment', () => {
  it('第一次调用对得上计划第 1 个带 capability 的步骤 -> 放行', async () => {
    beginTask(TASK_ID, '整理 PDF', PLAN)

    const out = await agentPolicy().evaluate(
      params('tc-10', 'filesystem.list', { rootId: 'downloads' })
    )

    expect(out.allowed).toBe(true)
    expect(currentTask()?.executedCalls).toBe(1)
  })

  it('第一次就调计划第二步的能力 -> ACTION_NOT_ALIGNED', async () => {
    beginTask(TASK_ID, '整理 PDF', PLAN)

    const out = await agentPolicy().evaluate(
      params('tc-11', 'document.extract_pdf', { path: join(dir, 'a.pdf') })
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.ACTION_NOT_ALIGNED)
    expect(!out.allowed && out.reason).toBe(
      '第 1 次 tool call 期望 filesystem.list，实际是 document.extract_pdf'
    )
  })

  it('被拒的调用不占序号：调错了再改对，仍然对得上同一步', async () => {
    beginTask(TASK_ID, '整理 PDF', PLAN)

    const wrong = await agentPolicy().evaluate(
      params('tc-12', 'document.extract_pdf', { path: join(dir, 'a.pdf') })
    )
    expect(wrong.allowed).toBe(false)
    expect(currentTask()?.executedCalls).toBe(0)

    const right = await agentPolicy().evaluate(
      params('tc-13', 'filesystem.list', { rootId: 'downloads' })
    )
    expect(right.allowed).toBe(true)
    expect(currentTask()?.executedCalls).toBe(1)
  })

  it('计划里的能力用完之后再来一次 -> ACTION_NOT_ALIGNED', async () => {
    beginTask(TASK_ID, '整理 PDF', PLAN)
    await agentPolicy().evaluate(params('tc-14', 'filesystem.list', { rootId: 'downloads' }))
    await agentPolicy().evaluate(
      params('tc-15', 'document.extract_pdf', { path: join(dir, 'a.pdf') })
    )

    const extra = await agentPolicy().evaluate(
      params('tc-16', 'filesystem.list', { rootId: 'downloads' })
    )

    expect(currentTask()?.executedCalls).toBe(2)
    expect(!extra.allowed && extra.code).toBe(ERROR_CODE.ACTION_NOT_ALIGNED)
    // 计数不能因为一次拒绝就往回退或往上加。
    expect(currentTask()?.executedCalls).toBe(2)
  })

  it('ui origin 不做对齐，也不占序号', async () => {
    beginTask(TASK_ID, '整理 PDF', PLAN)

    // 顺序上 ui 的第一次调用与计划第 1 步无关，所以哪怕能力不同也放行。
    const out = await policy(UI_ORIGIN).evaluate(
      params('tc-17', 'document.extract_pdf', { path: join(dir, 'a.pdf') })
    )

    expect(out.allowed).toBe(true)
    expect(currentTask()?.executedCalls).toBe(0)
  })
})

describe('execution-policy：风险', () => {
  it('没有批准通道时 WRITE 能力 -> PERMISSION_REQUIRED', async () => {
    // 没通道就退回 Phase 1 的行为：宁可少做，不可多做。
    // 有通道时走挂起，见下一组。
    beginTask(TASK_ID, '整理 PDF', MOVE_PLAN)

    const out = await agentPolicy(allowRetriever('filesystem.move')).evaluate(
      params('tc-18', 'filesystem.move', moveArgs())
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.PERMISSION_REQUIRED)
    expect(!out.allowed && out.reason).toContain('filesystem.move')
    expect(currentTask()?.executedCalls).toBe(0)
  })

  it('参数绑定排在批准之前：烂参数不该先去要授权', async () => {
    // 批准面板要展示规范化后的绕对路径，args_hash 也必须是绑定后的值。
    // 在绑定之前挂起，等于让用户批准一个还不知道会落在哪里的操作。
    beginTask(TASK_ID, '整理 PDF', MOVE_PLAN)
    const gate = makeGate({ approved: true })

    const out = await policyWithGate(gate.gate).evaluate(
      params('tc-19', 'filesystem.move', { from: '../../etc', to: '\\\\server\\share' })
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.INVALID_ARGUMENT)
    expect(gate.inputs).toEqual([])
  })

  it('路径逃出根时也不挂起：guard 比批准靠前', async () => {
    beginTask(TASK_ID, '整理 PDF', MOVE_PLAN)
    const gate = makeGate({ approved: true })

    const out = await policyWithGate(gate.gate).evaluate(
      params('tc-19b', 'filesystem.move', {
        source: `${realRoot}/a.pdf`,
        target: 'C:/Windows/Temp/evil.pdf'
      })
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
    expect(gate.inputs).toEqual([])
  })

  it('没有绑定器的 WRITE 能力先撞 NOT_IMPLEMENTED，到不了批准这一关', async () => {
    // 顺序换了之后的必然结果。scheduler.create 与 notification.send 还没有绑定器，
    // 所以它们现在报未实现而不是要授权。
    beginTask(TASK_ID, '整理 PDF', [{ description: '建日程', capability: 'scheduler.create' }])
    const gate = makeGate({ approved: true })

    const out = await policyWithGate(gate.gate, {
      retriever: allowRetriever('scheduler.create')
    }).evaluate(params('tc-19c', 'scheduler.create', {}))

    expect(!out.allowed && out.code).toBe(ERROR_CODE.NOT_IMPLEMENTED)
    expect(gate.inputs).toEqual([])
  })
})

describe('execution-policy：挂起等批准', () => {
  it('批准 -> 放行，gate 收到的是规范化后的绝对路径', async () => {
    beginTask(TASK_ID, '整理 PDF', MOVE_PLAN)
    const gate = makeGate({ approved: true })

    const out = await policyWithGate(gate.gate).evaluate(
      params('tc-40', 'filesystem.move', moveArgs())
    )

    expect(out.allowed).toBe(true)
    expect(gate.inputs).toHaveLength(1)
    expect(gate.inputs[0]).toEqual({
      taskId: TASK_ID,
      toolCallId: 'tc-40',
      capability: 'filesystem.move',
      bound: {
        args: moveArgs(),
        paths: { source: `${realRoot}/a.pdf`, target: `${realRoot}/Reading/a.pdf` }
      }
    })
    expect(currentTask()?.executedCalls).toBe(1)
  })

  it('批准之后还要复查：verify 拿到同一个 callId 与同一份 bound', async () => {
    beginTask(TASK_ID, '整理 PDF', MOVE_PLAN)
    const gate = makeGate({ approved: true })

    const out = await policyWithGate(gate.gate).evaluate(
      params('tc-41', 'filesystem.move', moveArgs())
    )

    expect(out.allowed).toBe(true)
    expect(gate.verifyCalls).toHaveLength(1)
    expect(gate.verifyCalls[0][0]).toBe('tc-41')
    expect(gate.verifyCalls[0][1]).toEqual(gate.inputs[0].bound)
  })

  it('复查不通过 -> 用复查的码，不放行也不计数', async () => {
    // 对应 Checklist「参数变化后旧 Permission 无效」：批准不等于放行。
    beginTask(TASK_ID, '整理 PDF', MOVE_PLAN)
    const gate = makeGate(
      { approved: true },
      { verify: { ok: false, code: ERROR_CODE.PERMISSION_TAMPERED, reason: '参数变了' } }
    )

    const out = await policyWithGate(gate.gate).evaluate(
      params('tc-42', 'filesystem.move', moveArgs())
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.PERMISSION_TAMPERED)
    expect(!out.allowed && out.reason).toBe('参数变了')
    expect(currentTask()?.executedCalls).toBe(0)
  })

  it('挂起期间停在 waiting_permission，结算后推回 running', async () => {
    beginTask(TASK_ID, '整理 PDF', MOVE_PLAN)
    const gate = makeGate({ approved: true }, { hold: true })
    const tasks = taskPort()

    const evaluating = policyWithGate(gate.gate, { tasks: tasks.port }).evaluate(
      params('tc-43', 'filesystem.move', moveArgs())
    )

    // 先改状态再挂起。反过来的话会有一段时间任务已经在等批准、
    // 库里却还写着 running，UI 那几秒显示的是错的。
    await vi.waitFor(() => expect(tasks.calls).toHaveLength(1))
    expect(tasks.calls[0]).toEqual([TASK_ID, 'waiting_permission', STAMP])

    gate.release({ approved: true })
    const out = await evaluating

    expect(out.allowed).toBe(true)
    expect(tasks.calls.map((c) => c[1])).toEqual(['waiting_permission', 'running'])
  })

  it('拒绝 -> PERMISSION_DENIED，任务仍推回 running，不计数', async () => {
    // 拒绝不是任务失败：Python 侧拿到 ok:false 的工具结果照常往下走。
    beginTask(TASK_ID, '整理 PDF', MOVE_PLAN)
    const gate = makeGate({
      approved: false,
      code: ERROR_CODE.PERMISSION_DENIED,
      reason: '用户拒绝了 filesystem.move'
    })
    const tasks = taskPort()

    const out = await policyWithGate(gate.gate, { tasks: tasks.port }).evaluate(
      params('tc-44', 'filesystem.move', moveArgs())
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.PERMISSION_DENIED)
    expect(tasks.calls.map((c) => c[1])).toEqual(['waiting_permission', 'running'])
    expect(currentTask()?.executedCalls).toBe(0)
    // 拒绝不需要复查：没有放行就没有「执行前重算」这回事
    expect(gate.verifyCalls).toEqual([])
  })

  it('过期 -> PERMISSION_EXPIRED 原样透传，任务仍推回 running', async () => {
    beginTask(TASK_ID, '整理 PDF', MOVE_PLAN)
    const gate = makeGate({
      approved: false,
      code: ERROR_CODE.PERMISSION_EXPIRED,
      reason: '批准请求已过期'
    })
    const tasks = taskPort()

    const out = await policyWithGate(gate.gate, { tasks: tasks.port }).evaluate(
      params('tc-45', 'filesystem.move', moveArgs())
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.PERMISSION_EXPIRED)
    expect(tasks.calls.map((c) => c[1])).toEqual(['waiting_permission', 'running'])
  })

  it('gate 抛异常时异常原样冒泡，但任务仍被推回 running', async () => {
    // 推回失败不能盖掉 gate 的原始异常：那会把「库写不进去」
    // 显示成「用户拒绝」，两个故障的排查方向完全不同。
    beginTask(TASK_ID, '整理 PDF', MOVE_PLAN)
    const tasks = taskPort()
    const throwing: PermissionGate = {
      request: () => Promise.reject(new Error('模拟库写失败')),
      verify: () => Promise.resolve({ ok: true })
    }

    await expect(
      policyWithGate(throwing, { tasks: tasks.port }).evaluate(
        params('tc-46', 'filesystem.move', moveArgs())
      )
    ).rejects.toThrow('模拟库写失败')
    expect(tasks.calls.map((c) => c[1])).toEqual(['waiting_permission', 'running'])
  })

  it('UI origin 不改任务状态：bootstrap 不是库里的任务', async () => {
    // scope.taskId 是 'bootstrap'，库里根本没这条，updateStatus 会抛「tasks 中不存在」。
    // UI 路径也没有计划可比，不需要 beginTask。
    const gate = makeGate({ approved: true })
    const tasks = taskPort()

    const out = await policyWithGate(gate.gate, {
      origin: UI_ORIGIN,
      scope: readOnlyScope('bootstrap'),
      tasks: tasks.port
    }).evaluate(params('tc-47', 'filesystem.move', moveArgs()))

    expect(out.allowed).toBe(true)
    expect(tasks.calls).toEqual([])
  })

  it('没注入 tasks 时也能挂起与放行', async () => {
    beginTask(TASK_ID, '整理 PDF', MOVE_PLAN)
    const gate = makeGate({ approved: true })

    const out = await policyWithGate(gate.gate).evaluate(
      params('tc-48', 'filesystem.move', moveArgs())
    )

    expect(out.allowed).toBe(true)
    expect(gate.inputs).toHaveLength(1)
  })

  it('READ 能力不挂起：gate 两个方法都不被调', async () => {
    // Checklist 第一条：READ 不弹 Permission。
    beginTask(TASK_ID, '整理 PDF', PLAN)
    const gate = makeGate({ approved: true })

    const out = await policyWithGate(gate.gate, {
      retriever: new RuleBasedToolRetriever()
    }).evaluate(params('tc-49', 'filesystem.list', { rootId: 'downloads' }))

    expect(out.allowed).toBe(true)
    expect(gate.inputs).toEqual([])
    expect(gate.verifyCalls).toEqual([])
  })
})

describe('execution-policy：参数契约与路径', () => {
  it('rootId 不在白名单 -> INVALID_ARGUMENT', async () => {
    beginTask(TASK_ID, '整理 PDF', PLAN)

    const out = await agentPolicy().evaluate(
      params('tc-20', 'filesystem.list', { rootId: 'system32' })
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.INVALID_ARGUMENT)
    expect(!out.allowed && out.reason).toContain('filesystem.list')
    expect(currentTask()?.executedCalls).toBe(0)
  })

  it('根外路径 -> PATH_OUT_OF_ROOT', async () => {
    beginTask(TASK_ID, '整理 PDF', [{ description: '提取', capability: 'document.extract_pdf' }])

    const out = await agentPolicy().evaluate(
      params('tc-21', 'document.extract_pdf', { path: 'C:/Windows/win.ini' })
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
  })

  it('根内 junction 指向根外 -> PATH_ESCAPES_ROOT_VIA_LINK', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pa-policy-outside-'))
    try {
      await writeFile(join(outside, 'secret.pdf'), 'S')
      await symlink(outside, join(dir, 'escape'), 'junction')
      beginTask(TASK_ID, '整理 PDF', [{ description: '提取', capability: 'document.extract_pdf' }])

      const out = await agentPolicy().evaluate(
        params('tc-22', 'document.extract_pdf', { path: join(dir, 'escape', 'secret.pdf') })
      )

      expect(!out.allowed && out.code).toBe(ERROR_CODE.PATH_ESCAPES_ROOT_VIA_LINK)
      expect(currentTask()?.executedCalls).toBe(0)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('UNC -> PATH_UNC_NOT_ALLOWED', async () => {
    beginTask(TASK_ID, '整理 PDF', [{ description: '提取', capability: 'document.extract_pdf' }])

    const out = await agentPolicy().evaluate(
      params('tc-23', 'document.extract_pdf', { path: '\\\\evil-server\\share\\x.pdf' })
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.PATH_UNC_NOT_ALLOWED)
  })
})

describe('execution-policy：放行产物', () => {
  it('AuthorizedCall 带 callId、descriptor、绑定后的参数与 taskId', async () => {
    await writeFile(join(dir, 'a.pdf'), 'A')
    beginTask(TASK_ID, '整理 PDF', [{ description: '提取', capability: 'document.extract_pdf' }])

    const out = await agentPolicy().evaluate(
      params('tc-24', 'document.extract_pdf', { path: join(dir, 'a.pdf') })
    )

    if (!out.allowed) throw new Error('期望放行')
    expect(out.call.callId).toBe('tc-24')
    expect(out.call.taskId).toBe(TASK_ID)
    // descriptor 取自 registry，不是模型给的字符串拼出来的。
    expect(out.call.capability).toEqual(findCapability('document.extract_pdf'))
    expect(out.call.bound.paths['path']).toBe(`${realRoot}/a.pdf`)
  })

  it('taskId 来自 scope 而不是当前任务', async () => {
    // 两者在生产上相等，但来源必须是 scope：host-executor 用的是 BOOTSTRAP_SCOPE，
    // 与 run-task 生成的 taskId 不是一回事。写错来源会让 Permission 绑到错的任务上。
    beginTask('task-other', '整理 PDF', PLAN)

    const out = await agentPolicy().evaluate(
      params('tc-25', 'filesystem.list', { rootId: 'downloads' })
    )

    expect(out.allowed && out.call.taskId).toBe(TASK_ID)
  })

  it('filesystem.list 的 bound.paths 为空：rootId 不是路径', async () => {
    beginTask(TASK_ID, '整理 PDF', PLAN)

    const out = await agentPolicy().evaluate(
      params('tc-26', 'filesystem.list', { rootId: 'downloads' })
    )

    expect(out.allowed && out.call.bound.args).toEqual({ rootId: 'downloads' })
    expect(out.allowed && out.call.bound.paths).toEqual({})
  })

  it('连续放行两次，序号依次是 1 和 2', async () => {
    await writeFile(join(dir, 'a.pdf'), 'A')
    beginTask(TASK_ID, '整理 PDF', PLAN)

    const first = await agentPolicy().evaluate(
      params('tc-27', 'filesystem.list', { rootId: 'downloads' })
    )
    const second = await agentPolicy().evaluate(
      params('tc-28', 'document.extract_pdf', { path: join(dir, 'a.pdf') })
    )

    expect(first.allowed).toBe(true)
    expect(second.allowed).toBe(true)
    expect(currentTask()?.executedCalls).toBe(2)
  })
})

describe('execution-policy：evaluate 永不抛', () => {
  it('一堆坏输入全都变成 allowed:false', async () => {
    // 抛出去的话 supervisor 的 catch 会把 code 写死成 HOST_HANDLER_FAILED，
    // 前面七关的精确码一个都留不下来。
    await mkdir(join(dir, 'sub'), { recursive: true })
    vi.stubEnv(ENV_NAME, join(dir, 'nope'))
    beginTask(TASK_ID, '整理 PDF', PLAN)

    const inputs: HostExecuteToolParams[] = [
      params('tc-30', 'filesystem.list', { rootId: 'downloads' }),
      params('tc-31', 'filesystem.list', { rootId: 'nope' }),
      params('tc-32', 'filesystem.list', {}),
      params('tc-33', 'document.extract_pdf', { path: '' }),
      params('tc-34', 'document.extract_pdf', { path: 'C:/Windows/win.ini' }),
      params('tc-35', 'document.extract_pdf', { path: join(dir, 'ghost.pdf') }),
      params('tc-36', 'filesystem.move', { from: 'a', to: 'b' }),
      params('tc-37', 'scheduler.create', {}),
      params('tc-38', 'notification.send', {})
    ]

    for (const input of inputs) {
      const out = await agentPolicy().evaluate(input)
      expect(typeof out.allowed, input.callId).toBe('boolean')
      if (!out.allowed) {
        expect(typeof out.code, input.callId).toBe('string')
        expect(out.code.length, input.callId).toBeGreaterThan(0)
        expect(typeof out.reason, input.callId).toBe('string')
      }
    }
  })
})

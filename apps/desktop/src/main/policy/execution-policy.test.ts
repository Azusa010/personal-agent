import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ERROR_CODE, type HostExecuteToolParams } from '@personal-agent/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { findCapability } from '../capabilities/registry'
import { RuleBasedToolRetriever, type ToolRetriever } from '../capabilities/retriever'
import { readOnlyScope, type TaskScope } from '../capabilities/scope'
import { toPosix } from '../capabilities/roots'
import type { PlanStep } from '../../shared/domain'
import {
  AGENT_ORIGIN,
  createExecutionPolicy,
  UI_ORIGIN,
  type CallOrigin,
  type ExecutionPolicy
} from './execution-policy'
import { beginTask, currentTask, endTask } from './task-context'

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
    // 分岭只在「有没有任务、对不对齐」两关，其余五关两条路都走。
    const out = await policy(UI_ORIGIN, allowRetriever('scheduler.create')).evaluate(
      params('tc-9', 'scheduler.create', {})
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
  it('WRITE 能力 -> PERMISSION_REQUIRED', async () => {
    // TASK-019 会把它换成「挂起等 permission.respond」。在那之前先以拒绝落地：
    // 宁可少做，不可多做。
    const plan: readonly PlanStep[] = [
      { description: '建一个目录', capability: 'scheduler.create' }
    ]
    beginTask(TASK_ID, '整理 PDF', plan)

    const out = await agentPolicy(allowRetriever('scheduler.create')).evaluate(
      params('tc-18', 'scheduler.create', {})
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.PERMISSION_REQUIRED)
    expect(!out.allowed && out.reason).toContain('scheduler.create')
    expect(currentTask()?.executedCalls).toBe(0)
  })

  it('风险检查排在参数绑定之前', async () => {
    // 参数烂掉的 WRITE 调用不该先去碰文件系统：
    // 「要不要授权」是比「参数对不对」更靠前的问题。
    vi.stubEnv(ENV_NAME, join(dir, 'nope'))
    const plan: readonly PlanStep[] = [{ description: '移动文件', capability: 'filesystem.move' }]
    beginTask(TASK_ID, '整理 PDF', plan)

    const out = await agentPolicy(allowRetriever('filesystem.move')).evaluate(
      params('tc-19', 'filesystem.move', { from: '../../etc', to: '\\\\server\\share' })
    )

    expect(!out.allowed && out.code).toBe(ERROR_CODE.PERMISSION_REQUIRED)
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

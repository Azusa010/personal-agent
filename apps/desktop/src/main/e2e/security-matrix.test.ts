/**
 * Phase 2 安全测试矩阵（TASK-022 / GOAL-003）。
 *
 * 与 golden-path.test.ts 的分工：golden-path 走真 Python 验证「正常只读路径」，
 * 本文件不 spawn Python——所有安全判定（Scope、路径 guard、Permission 六步、幂等）
 * 都在 host 侧（Electron Main），Python 只是 host.execute_tool 的发起方，不参与
 * 安全语义。所以这里用**全真组件**在 host 侧组装完整 WRITE 链路：
 *
 *   executor → policy.evaluate（八级管道）→ broker.request（挂起）
 *            → UI respond → broker.verify（六步）→ beginAttempt（幂等关）
 *            → runCapability（真文件系统副作用）→ afterExecute
 *
 * 真组件 = 真 broker + 真四 repo + 内存 SQLite + 真临时文件系统 + 真批准决策。
 * 与 idempotency-guard.test.ts 的区别：那里的 gate 是假 approveGate，这里的 gate
 * 是真 broker，Deny / Tamper / Retry 都真的走 respond 与 verify。
 *
 * 五组对应 Deliverables 的五类测试，追溯 Phase 2 Exit Checklist 七条：
 *   Deny      → 「Deny 后目录和文件均不变化」「WRITE 必须等待 Permission」
 *   Allow     → 「READ 不弹 Permission」「Allow 后创建 Reading 并移动一次」
 *   Tamper    → 「参数变化后旧 Permission 无效」
 *   Traversal → 「..\、junction/symlink 和大小写路径逃逸测试失败」
 *   Retry     → 「重复响应无副作用」+ 幂等只执行一次
 *   Crash     → 「崩溃恢复不重复副作用」
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ERROR_CODE, type HostExecuteToolParams } from '@personal-agent/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ExecutionEventRecord,
  PermissionDecision,
  PermissionNotice,
  PermissionRecord,
  ToolExecutionRecord,
  ToolExecutionStatus
} from '../../shared/domain'
import { createExecutor, type CapabilityOutcome } from '../capabilities/executor'
import { idempotencyKey } from '../capabilities/idempotency'
import { RuleBasedToolRetriever } from '../capabilities/retriever'
import { toPosix } from '../capabilities/roots'
import type { TaskScope } from '../capabilities/scope'
import { fingerprintArguments } from '../permission/args-hash'
import { createPermissionBroker, type PermissionBroker } from '../permission/permission-broker'
import type { BoundArgs } from '../policy/argument-binders'
import { UI_ORIGIN } from '../policy/execution-policy'
import {
  MEMORY_DB,
  migrate,
  openProductState,
  type SqliteDatabase
} from '../product-state/database'
import { SqliteEventRepository } from '../product-state/event-repository'
import { SqlitePermissionRepository } from '../product-state/permission-repository'
import { SqliteTaskRepository } from '../product-state/task-repository'
import { SqliteToolExecutionRepository } from '../product-state/tool-execution-repository'

const ENV_NAME = 'PERSONAL_AGENT_DOWNLOADS_DIR'
const T0 = '2026-09-15T09:00:00.000Z'
const T1 = '2026-09-15T09:00:05.000Z'
const TASK_ID = 'task-sec'
// 批准窗口。够长以便测试从容 respond，过期组用 advanceTimersByTimeAsync 主动推进。
const TTL_MS = 1000

// WRITE 任务的完整 Scope：一个「整理 PDF」任务能读能写。READ 项用来验证不挂起。
const WRITE_SCOPE: TaskScope = {
  taskId: TASK_ID,
  capabilities: ['filesystem.list', 'filesystem.create_dir', 'filesystem.move']
}

let dir = ''
let realRoot = ''
let db: SqliteDatabase | null = null
let clock = T0
let idSeq = 0
let notices: PermissionNotice[] = []
// drive 靠它把「已挂起」这件事从 notify 回调传回测试体。每个测试重置。
let requestedResolve: ((permission: PermissionRecord) => void) | null = null
let broker: PermissionBroker | null = null
let run: (params: HostExecuteToolParams) => Promise<CapabilityOutcome>
let taskRepo: SqliteTaskRepository
let permRepo: SqlitePermissionRepository
let eventRepo: SqliteEventRepository
let execRepo: SqliteToolExecutionRepository

beforeEach(async () => {
  // 真 IO 先在真时钟下做完，再启用假定时器，避免 fake timers 干扰 fs promise。
  dir = await mkdtemp(join(tmpdir(), 'pa-sec-'))
  realRoot = toPosix(await realpath(dir))

  clock = T0
  idSeq = 0
  notices = []
  requestedResolve = null

  vi.stubEnv(ENV_NAME, dir)
  vi.useFakeTimers()

  db = openProductState(MEMORY_DB)
  migrate(db)
  taskRepo = new SqliteTaskRepository(db)
  permRepo = new SqlitePermissionRepository(db)
  eventRepo = new SqliteEventRepository(db)
  execRepo = new SqliteToolExecutionRepository(db)
  taskRepo.insert({
    id: TASK_ID,
    goal: '整理下载目录',
    status: 'running',
    createdAt: T0,
    updatedAt: T0
  })

  broker = createPermissionBroker({
    permissions: permRepo,
    events: eventRepo,
    now: () => clock,
    newId: () => `perm-${++idSeq}`,
    ttlMs: TTL_MS,
    root: () => realRoot,
    notify: (notice) => {
      notices.push(notice)
      if (notice.kind === 'requested' && requestedResolve !== null) {
        requestedResolve(notice.permission)
        requestedResolve = null
      }
    }
  })

  run = createExecutor(
    WRITE_SCOPE,
    UI_ORIGIN,
    new RuleBasedToolRetriever(),
    { gate: broker, tasks: taskRepo, now: () => clock },
    { executions: execRepo, now: () => clock }
  )
})

afterEach(async () => {
  broker?.dispose()
  broker = null
  db?.close()
  db = null
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

// ---------- harness helpers ----------

/** 原始路径（dir 形式），模拟模型给的参数。executor 内部 bindArguments 会转成 realRoot 形式。 */
function p(...segs: string[]): string {
  return join(dir, ...segs)
}

/** realpath 形式，与 executor 内部 bindArguments 产出、broker 落库的 paths 逐字一致。
 *  幂等 key、Crash seed 都必须用它，否则和链路里算出的 key 对不上。 */
function rp(...segs: string[]): string {
  return `${realRoot}/${segs.join('/')}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 授权根快照：名字+大小+mtime 排序。「零副作用」的统一铁证——跑前跑后逐字相同。 */
async function snapshotRoot(): Promise<string[]> {
  const names = await readdir(dir)
  const rows = await Promise.all(
    names.map(async (name) => {
      const s = await stat(join(dir, name))
      return `${name}:${s.size}:${s.mtimeMs}`
    })
  )
  return rows.sort()
}

function params(
  callId: string,
  capability: HostExecuteToolParams['capability'],
  args: Record<string, unknown>
): HostExecuteToolParams {
  return { callId, capability, arguments: args }
}

/** move 的绑定结果（realRoot 形式）。args 会被 paths 覆盖，算 hash 时只看 paths。 */
function moveBound(source: string, target: string): BoundArgs {
  return { args: { source, target }, paths: { source, target } }
}

/** create_dir 的绑定结果（realRoot 形式）。 */
function dirBound(path: string): BoundArgs {
  return { args: { path }, paths: { path } }
}

function eventsOfType(type: string): ExecutionEventRecord[] {
  return eventRepo.listByTask(TASK_ID).filter((event) => event.type === type)
}

/** 往 tool_executions 塞一条执行记录，模拟「上次进程跑到一半崩了」留下的库状态。
 *  bound 必须用 realRoot 形式，key 才与 executor 内部 beginAttempt 算出的逐字一致。 */
function seedExecution(
  capability: string,
  bound: BoundArgs,
  status: ToolExecutionStatus,
  resultPayload: unknown = null
): void {
  const source = bound.paths['source']
  const target = bound.paths['target'] ?? bound.paths['path'] ?? null
  const record: ToolExecutionRecord = {
    idempotencyKey: idempotencyKey(capability, bound),
    taskId: TASK_ID,
    toolCallId: 'call-crash',
    capability,
    argsHash: fingerprintArguments(bound).hash,
    sourcePaths: source === undefined ? [] : [source],
    targetPath: target,
    status,
    attemptedAt: T0,
    finishedAt: status === 'attempting' ? null : T1,
    resultPayload
  }
  execRepo.insert(record)
}

/** 等 broker 把 permission 挂起（notify requested）。必须在 run() 之前调用，否则
 *  bindArguments 的真 IO 可能在 requestedResolve 就位前就触发 notify，信号丢失。 */
function nextRequested(): Promise<PermissionRecord> {
  return new Promise<PermissionRecord>((resolve) => {
    requestedResolve = resolve
  })
}

interface DriveOptions {
  /** 不传 = 不 respond（过期组靠推进定时器结算） */
  decision?: PermissionDecision
  /** 挂起后、respond 前触发：查瞬时 waiting_permission 状态、篡改库都在这 */
  onSuspended?: (permission: PermissionRecord) => void
}

/** 完整链路驱动：发起调用 → 等挂起 → onSuspended → respond → 结算返回。 */
async function drive(
  callParams: HostExecuteToolParams,
  opts: DriveOptions = {}
): Promise<CapabilityOutcome> {
  const suspended = nextRequested()
  const resultPromise = run(callParams)
  const permission = await suspended
  opts.onSuspended?.(permission)
  if (opts.decision !== undefined) {
    broker?.respond(permission.id, opts.decision)
  }
  return resultPromise
}

// ---------- Deny：拒绝即零副作用 ----------

describe('Deny：拒绝即零副作用', () => {
  it('move 被拒 → PERMISSION_DENIED，source 仍在、target 未建、根零变化', async () => {
    await mkdir(join(dir, 'Reading'))
    await writeFile(join(dir, 'a.pdf'), 'ORIGINAL')
    const before = await snapshotRoot()

    const out = await drive(
      params('tc-deny-move', 'filesystem.move', {
        source: p('a.pdf'),
        target: p('Reading', 'a.pdf')
      }),
      { decision: 'denied' }
    )

    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.PERMISSION_DENIED)
    // 拒绝发生在 runCapability 之前：source 原封不动，target 从没被创建。
    expect(await readFile(join(dir, 'a.pdf'), 'utf-8')).toBe('ORIGINAL')
    expect(await exists(join(dir, 'Reading', 'a.pdf'))).toBe(false)
    expect(await snapshotRoot()).toEqual(before)
  })

  it('create_dir 被拒 → 目录未建，根零变化', async () => {
    const before = await snapshotRoot()

    const out = await drive(
      params('tc-deny-dir', 'filesystem.create_dir', { path: p('Reading') }),
      {
        decision: 'denied'
      }
    )

    expect(out['code']).toBe(ERROR_CODE.PERMISSION_DENIED)
    expect(await exists(join(dir, 'Reading'))).toBe(false)
    expect(await snapshotRoot()).toEqual(before)
  })

  it('WRITE 没有批准通道 → PERMISSION_REQUIRED，零副作用', async () => {
    // 不注入 gate：risk 判 PERMISSION_REQUIRED 时无路可走，直接拒，绝不放行副作用。
    const noGate = createExecutor(WRITE_SCOPE, UI_ORIGIN, new RuleBasedToolRetriever(), undefined, {
      executions: execRepo,
      now: () => clock
    })
    const before = await snapshotRoot()

    const out = await noGate(params('tc-nogate', 'filesystem.create_dir', { path: p('Reading') }))

    expect(out['code']).toBe(ERROR_CODE.PERMISSION_REQUIRED)
    expect(await exists(join(dir, 'Reading'))).toBe(false)
    expect(await snapshotRoot()).toEqual(before)
  })

  it('批准窗口超时 → PERMISSION_EXPIRED，零副作用', async () => {
    await writeFile(join(dir, 'a.pdf'), 'ORIGINAL')
    const before = await snapshotRoot()

    const suspended = nextRequested()
    const resultPromise = run(
      params('tc-expire', 'filesystem.move', {
        source: p('a.pdf'),
        target: p('Reading', 'a.pdf')
      })
    )
    await suspended
    // 推进过 TTL，触发 broker 的过期定时器：写 expired 事件 + 结算 PERMISSION_EXPIRED。
    await vi.advanceTimersByTimeAsync(TTL_MS + 1)
    const out = await resultPromise

    expect(out['code']).toBe(ERROR_CODE.PERMISSION_EXPIRED)
    expect(await readFile(join(dir, 'a.pdf'), 'utf-8')).toBe('ORIGINAL')
    expect(await snapshotRoot()).toEqual(before)
  })
})

// ---------- Allow：批准精确执行一次 + READ 不挂起 ----------

describe('Allow：批准精确执行一次，READ 不弹 Permission', () => {
  it('READ（filesystem.list）不挂起、不建 Permission，直接成功', async () => {
    const out = await run(params('tc-read', 'filesystem.list', { rootId: 'downloads' }))

    expect(out['ok']).toBe(true)
    // 没有任何 permission 记录、没有 notify，证明 READ 完全没走批准通道。
    expect(permRepo.findByTaskId(TASK_ID)).toEqual([])
    expect(notices).toEqual([])
  })

  it('create_dir 批准 → 目录建成，且确实走过了批准通道', async () => {
    const out = await drive(
      params('tc-allow-dir', 'filesystem.create_dir', { path: p('Reading') }),
      { decision: 'approved' }
    )

    expect(out['ok']).toBe(true)
    expect(out['created']).toBe(true)
    expect((await stat(join(dir, 'Reading'))).isDirectory()).toBe(true)
    // 走过了批准通道：permission 落库为 approved，请求/决策事件各一条。
    // 注：UI_ORIGIN 不推 waiting_permission（trackState 仅对 agent origin 生效），
    // 任务状态挂起归 execution-policy.test.ts 的 agent 链路覆盖。
    const perms = permRepo.findByTaskId(TASK_ID)
    expect(perms).toHaveLength(1)
    expect(perms[0]?.status).toBe('approved')
    expect(eventsOfType('permission_requested')).toHaveLength(1)
    expect(eventsOfType('permission_decision')).toHaveLength(1)
  })

  it('move 批准 → source 消失、target 内容一致，幂等记录翻 succeeded', async () => {
    await mkdir(join(dir, 'Reading'))
    await writeFile(join(dir, 'a.pdf'), 'BYTES')

    const out = await drive(
      params('tc-allow-move', 'filesystem.move', {
        source: p('a.pdf'),
        target: p('Reading', 'a.pdf')
      }),
      { decision: 'approved' }
    )

    expect(out['ok']).toBe(true)
    expect(await exists(join(dir, 'a.pdf'))).toBe(false)
    expect(await readFile(join(dir, 'Reading', 'a.pdf'), 'utf-8')).toBe('BYTES')
    const key = idempotencyKey('filesystem.move', moveBound(rp('a.pdf'), rp('Reading', 'a.pdf')))
    expect(execRepo.findByKey(key)?.status).toBe('succeeded')
  })
})

// ---------- Tamper：篡改使旧批准失效 ----------

describe('Tamper：参数变化后旧 Permission 无效', () => {
  it('批准后 args_hash 被篡改 → verify 第5步 PERMISSION_TAMPERED，零副作用', async () => {
    await mkdir(join(dir, 'Reading'))
    await writeFile(join(dir, 'a.pdf'), 'ORIGINAL')
    const before = await snapshotRoot()

    const out = await drive(
      params('tc-tamper-hash', 'filesystem.move', {
        source: p('a.pdf'),
        target: p('Reading', 'a.pdf')
      }),
      {
        decision: 'approved',
        onSuspended: (permission) => {
          // 模拟批准记录被移花接木：库里 hash 被改，执行时重算的是真参数的 hash。
          db?.prepare('UPDATE permissions SET args_hash = ? WHERE id = ?').run(
            'tampered-hash',
            permission.id
          )
        }
      }
    )

    expect(out['code']).toBe(ERROR_CODE.PERMISSION_TAMPERED)
    expect(await readFile(join(dir, 'a.pdf'), 'utf-8')).toBe('ORIGINAL')
    expect(await snapshotRoot()).toEqual(before)
  })

  it('批准记录的 callId 被篡改 → verify 查不到批准 → PERMISSION_REQUIRED，零副作用', async () => {
    await mkdir(join(dir, 'Reading'))
    await writeFile(join(dir, 'a.pdf'), 'ORIGINAL')
    const before = await snapshotRoot()

    const out = await drive(
      params('tc-tamper-call', 'filesystem.move', {
        source: p('a.pdf'),
        target: p('Reading', 'a.pdf')
      }),
      {
        decision: 'approved',
        onSuspended: (permission) => {
          // 把批准记录改挂到别的 callId：执行时按原 callId 查就落空了。
          db?.prepare('UPDATE permissions SET tool_call_id = ? WHERE id = ?').run(
            'stolen-call',
            permission.id
          )
        }
      }
    )

    // findByToolCallId(原 callId) → null → verifyPermission 第1步。
    expect(out['code']).toBe(ERROR_CODE.PERMISSION_REQUIRED)
    expect(await readFile(join(dir, 'a.pdf'), 'utf-8')).toBe('ORIGINAL')
    expect(await snapshotRoot()).toEqual(before)
  })
})

// ---------- Traversal：路径逃逸 100% 拒绝 ----------

describe('Traversal：路径逃逸在 bindArguments 阶段即拒，零副作用', () => {
  it('move source 用 .. 逃逸 → PATH_OUT_OF_ROOT', async () => {
    const before = await snapshotRoot()

    const out = await run(
      params('tc-trav-dotdot', 'filesystem.move', {
        source: join(dir, '..', 'secret.pdf'),
        target: p('a.pdf')
      })
    )

    expect(out['code']).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
    expect(await snapshotRoot()).toEqual(before)
  })

  it('move target 经 junction 逃出根 → PATH_ESCAPES_ROOT_VIA_LINK，根外零落地', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pa-sec-out-'))
    try {
      await writeFile(join(dir, 'a.pdf'), 'ORIGINAL')
      await symlink(outside, join(dir, 'escape'), 'junction')
      const before = await snapshotRoot()

      const out = await run(
        params('tc-trav-junction', 'filesystem.move', {
          source: p('a.pdf'),
          target: join(dir, 'escape', 'a.pdf')
        })
      )

      expect(out['code']).toBe(ERROR_CODE.PATH_ESCAPES_ROOT_VIA_LINK)
      // a.pdf 没被移动，根外目录也没多出任何文件。
      expect(await readFile(join(dir, 'a.pdf'), 'utf-8')).toBe('ORIGINAL')
      expect(await readdir(outside)).toEqual([])
      expect(await snapshotRoot()).toEqual(before)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('move target 是 UNC → PATH_UNC_NOT_ALLOWED', async () => {
    await writeFile(join(dir, 'a.pdf'), 'ORIGINAL')
    const before = await snapshotRoot()

    const out = await run(
      params('tc-trav-unc', 'filesystem.move', {
        source: p('a.pdf'),
        target: '\\\\evil-server\\share\\a.pdf'
      })
    )

    expect(out['code']).toBe(ERROR_CODE.PATH_UNC_NOT_ALLOWED)
    expect(await snapshotRoot()).toEqual(before)
  })

  it('move target 落到同名前缀兄弟目录 → PATH_OUT_OF_ROOT', async () => {
    const evilDir = `${dir}-evil`
    await mkdir(evilDir, { recursive: true })
    try {
      await writeFile(join(dir, 'a.pdf'), 'ORIGINAL')
      const before = await snapshotRoot()

      const out = await run(
        params('tc-trav-sibling', 'filesystem.move', {
          source: p('a.pdf'),
          target: join(evilDir, 'a.pdf')
        })
      )

      // 不补分隔符时 'dir-evil'.startsWith('dir') 会误判通过，这里必须拒。
      expect(out['code']).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
      expect(await readFile(join(dir, 'a.pdf'), 'utf-8')).toBe('ORIGINAL')
      expect(await snapshotRoot()).toEqual(before)
    } finally {
      await rm(evilDir, { recursive: true, force: true })
    }
  })

  it('根内大小写变体放行：toLowerCase 比较不误杀合法路径', async () => {
    const out = await drive(
      params('tc-trav-case', 'filesystem.create_dir', { path: join(dir, 'READING') }),
      { decision: 'approved' }
    )

    // 大小写变体的根内路径不算越界；批准执行后目录建成。
    expect(out['code']).not.toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
    expect(out['ok']).toBe(true)
  })
})

// ---------- Retry：重复无副作用 ----------

describe('Retry：重复响应与重复执行都只产生一次副作用', () => {
  it('重复 respond(approved) → 第二次 repeated:true，决策事件只落一条', async () => {
    await mkdir(join(dir, 'Reading'))
    await writeFile(join(dir, 'a.pdf'), 'BYTES')

    const suspended = nextRequested()
    const resultPromise = run(
      params('tc-retry-respond', 'filesystem.move', {
        source: p('a.pdf'),
        target: p('Reading', 'a.pdf')
      })
    )
    const permission = await suspended

    const first = broker?.respond(permission.id, 'approved')
    const second = broker?.respond(permission.id, 'approved')
    const out = await resultPromise

    expect(first).toMatchObject({ ok: true, repeated: false })
    expect(second).toMatchObject({ ok: true, repeated: true })
    // 第二次 respond 无副作用：决策事件仍只有一条。
    expect(eventsOfType('permission_decision')).toHaveLength(1)
    expect(out['ok']).toBe(true)
  })

  it('同参数、不同 callId 重复执行 → 第二次幂等 skip，只移动一次', async () => {
    await mkdir(join(dir, 'Reading'))
    await writeFile(join(dir, 'a.pdf'), 'BYTES')
    const key = idempotencyKey('filesystem.move', moveBound(rp('a.pdf'), rp('Reading', 'a.pdf')))

    const first = await drive(
      params('tc-retry-1', 'filesystem.move', {
        source: p('a.pdf'),
        target: p('Reading', 'a.pdf')
      }),
      { decision: 'approved' }
    )
    expect(first['ok']).toBe(true)
    expect(execRepo.findByKey(key)?.status).toBe('succeeded')

    // 第二次 source 已不在：真跑必然 MOVE_SOURCE_MISSING，只有 skip 才会 ok:true。
    const second = await drive(
      params('tc-retry-2', 'filesystem.move', {
        source: p('a.pdf'),
        target: p('Reading', 'a.pdf')
      }),
      { decision: 'approved' }
    )
    expect(second['ok']).toBe(true)
    expect(await readFile(join(dir, 'Reading', 'a.pdf'), 'utf-8')).toBe('BYTES')
    expect(await exists(join(dir, 'a.pdf'))).toBe(false)
    // tool_executions 仍只有一条：第二次没新建、没翻转。
    expect(execRepo.findByTaskId(TASK_ID).filter((r) => r.idempotencyKey === key)).toHaveLength(1)
  })
})

// ---------- Crash：崩溃恢复不重复副作用 ----------

describe('Crash：崩溃恢复不重复副作用', () => {
  it('move 崩在 rename 后、翻转前 → skip，不重复移动', async () => {
    await mkdir(join(dir, 'Reading'))
    // 上次进程已把 a.pdf 移进 Reading，但没来得及翻 succeeded 就崩了。
    await writeFile(join(dir, 'Reading', 'a.pdf'), 'ALREADY-MOVED')
    seedExecution('filesystem.move', moveBound(rp('a.pdf'), rp('Reading', 'a.pdf')), 'attempting')

    const out = await drive(
      params('tc-crash-move', 'filesystem.move', {
        source: p('a.pdf'),
        target: p('Reading', 'a.pdf')
      }),
      { decision: 'approved' }
    )

    // source 不在、target 在 → resolveMove 判 done → skip，绝不重跑 rename。
    expect(out['ok']).toBe(true)
    expect(out['idempotent']).toBe(true)
    expect(await readFile(join(dir, 'Reading', 'a.pdf'), 'utf-8')).toBe('ALREADY-MOVED')
    expect(await exists(join(dir, 'a.pdf'))).toBe(false)
    const key = idempotencyKey('filesystem.move', moveBound(rp('a.pdf'), rp('Reading', 'a.pdf')))
    expect(execRepo.findByKey(key)?.status).toBe('succeeded')
  })

  it('create_dir 崩在建目录后、翻转前 → skip，不重复创建（补 create_dir 恢复 gap）', async () => {
    // 上次已建好 Reading 但没翻 succeeded 就崩了。idempotency-guard.test.ts 只覆盖 move。
    await mkdir(join(dir, 'Reading'))
    seedExecution('filesystem.create_dir', dirBound(rp('Reading')), 'attempting')

    const out = await drive(
      params('tc-crash-dir', 'filesystem.create_dir', { path: p('Reading') }),
      { decision: 'approved' }
    )

    // 目标存在且是目录 → resolveCreateDir 判 done → skip。
    expect(out['ok']).toBe(true)
    expect(out['idempotent']).toBe(true)
    expect((await stat(join(dir, 'Reading'))).isDirectory()).toBe(true)
    const key = idempotencyKey('filesystem.create_dir', dirBound(rp('Reading')))
    expect(execRepo.findByKey(key)?.status).toBe('succeeded')
  })
})

import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, it, expect, vi } from 'vitest'
import { PythonSupervisor, type HostHandler } from './python-supervisor'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { RUNTIME_ERROR_CODE } from './error-code'
import { ERROR_CODE } from '@personal-agent/protocol'

// 假子进程
function makeFakeChild(): {
  child: ChildProcess
  written: string[]
  stdout: PassThrough
  stderr: PassThrough
} {
  const written: string[] = []
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const fake = Object.assign(new EventEmitter(), {
    stdin: {
      write: (s: string): boolean => {
        written.push(s)
        return true
      },
      end: (): void => {}
    },
    stdout,
    stderr,
    kill: (): void => {}
  })
  return { child: fake as unknown as ChildProcess, written, stdout, stderr }
}

describe('PythonSupervisor ~ Slice 1', () => {
  it('request 写出合法 NDJSON,喂一行响应即 resolve', async () => {
    const { child, written, stdout } = makeFakeChild()
    const sup = new PythonSupervisor({
      command: 'fake',
      args: [],
      capabilities: [],
      spawnFn: () => child
    })
    sup.start()

    const p = sup.request('system.ping')

    expect(written).toHaveLength(1)
    const req = JSON.parse(written[0])
    expect(req).toMatchObject({ jsonrpc: '2.0', method: 'system.ping', params: {} })
    expect(typeof req.id).toBe('string')

    stdout.push(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\n')
    await expect(p).resolves.toEqual({})
  })

  it('流≠行:响应被切成两块也能正常拼装', async () => {
    const { child, written, stdout } = makeFakeChild()
    const sup = new PythonSupervisor({
      command: 'fake',
      args: [],
      capabilities: [],
      spawnFn: () => child
    })
    sup.start()

    const p = sup.request('system.ping')
    const req = JSON.parse(written[0])
    const full = JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } }) + '\n'
    const cut = Math.floor(full.length / 2)
    stdout.push(full.slice(0, cut))
    stdout.push(full.slice(cut))

    await expect(p).resolves.toEqual({ ok: true })
  })
})

describe('PythonSupervisor ~ Slice 2', () => {
  it('并发：多个请求各按自己的 id 对上响应（乱序返回也行）', async () => {
    const { child, written, stdout } = makeFakeChild()
    const sup = new PythonSupervisor({
      command: 'fake',
      args: [],
      capabilities: [],
      spawnFn: () => child
    })
    sup.start()
    const p1 = sup.request('system.ping')
    const p2 = sup.request('system.ping')
    const id1 = JSON.parse(written[0]).id
    const id2 = JSON.parse(written[1]).id
    expect(id1).not.toBe(id2)

    stdout.push(JSON.stringify({ jsonrpc: '2.0', id: id2, result: { which: 2 } }) + '\n')
    stdout.push(JSON.stringify({ jsonrpc: '2.0', id: id1, result: { which: 1 } }) + '\n')
    await expect(p1).resolves.toEqual({ which: 1 })
    await expect(p2).resolves.toEqual({ which: 2 })
  })
  it('超时:无响应则 reject RUNTIME_TIMEOUT,不悬挂', async () => {
    const { child } = makeFakeChild()
    const sup = new PythonSupervisor({
      command: 'fake',
      args: [],
      capabilities: [],
      spawnFn: () => child,
      defaultTimeoutMs: 50
    })
    sup.start()
    const p = sup.request('system.ping')
    await expect(p).rejects.toMatchObject({ code: RUNTIME_ERROR_CODE.TIMEOUT })
  }, 2000)
  it('崩溃:pending全部reject且广播runtime.crashed', async () => {
    const { child } = makeFakeChild()
    const sup = new PythonSupervisor({
      command: 'fake',
      args: [],
      capabilities: [],
      spawnFn: () => child
    })
    sup.start()

    const onCrashed = vi.fn()
    sup.on('runtime.crashed', onCrashed)
    const p = sup.request('system.ping')
    child.emit('exit', 1, null)
    await expect(p).rejects.toMatchObject({ code: RUNTIME_ERROR_CODE.CRASHED })
    expect(onCrashed).toHaveBeenCalledOnce()
  })
  it('崩溃后新发的 request 立刻 reject CRASHED,不写死管道也不挂 timeout', async () => {
    const { child, written } = makeFakeChild()
    const sup = new PythonSupervisor({
      command: 'fake',
      args: [],
      capabilities: [],
      spawnFn: () => child,
      defaultTimeoutMs: 5000
    })
    sup.start()

    child.emit('exit', null, 'SIGTERM')
    const writtenBefore = written.length

    const p = sup.request('filesystem.list')
    await expect(p).rejects.toMatchObject({ code: RUNTIME_ERROR_CODE.CRASHED })
    expect(written).toHaveLength(writtenBefore)
  }, 2000)
})

describe('PythonSupervisor ~ Slice 3', () => {
  it('stderr: 子进程 stderr 原样转发为 stderr 事件', async () => {
    const { child, stderr } = makeFakeChild()
    const sup = new PythonSupervisor({
      command: 'fake',
      args: [],
      capabilities: [],
      spawnFn: () => child
    })
    sup.start()

    const chunks: string[] = []
    sup.on('stderr', (c: string) => chunks.push(c))
    stderr.write('python 日志一行\n')
    await new Promise((r) => setImmediate(r))
    expect(chunks.join('')).toBe('python 日志一行\n')
  })
  it('cancel:AbortSignal 触发后 reject RUNTIME_CANCELLED', async () => {
    const { child } = makeFakeChild()
    const sup = new PythonSupervisor({
      command: 'fake',
      args: [],
      capabilities: [],
      spawnFn: () => child
    })
    sup.start()
    const ac = new AbortController()
    const p = sup.request('system.ping', {}, { signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ code: RUNTIME_ERROR_CODE.CANCELLED })
  })
})

describe('PythonSupervisor ~ Slice 2b (握手)', () => {
  it('initialize:发出参数正确;版本不匹配的响应 -> RUNTIME_HANDSHAKE_FAILED', async () => {
    const { child, written, stdout } = makeFakeChild()
    const sup = new PythonSupervisor({
      command: 'fake',
      args: [],
      capabilities: [
        { name: 'filesystem.list', kind: 'READ', description: '列出授权根目录下的条目' },
        {
          name: 'document.extract_pdf',
          kind: 'READ',
          description: '提取 PDF 每页文本与页码'
        }
      ],
      spawnFn: () => child
    })
    sup.start()
    const p = sup.initialize()
    const req = JSON.parse(written[0])
    expect(req).toMatchObject({
      method: 'system.initialize',
      params: {
        protocolVersion: '0.1',
        // 只钉 name 与 kind 的内容与顺序：这份清单是 Agent 的权限边界，
        // 漂了就意味着模型看到的能力和它真正能调的不一致。
        capabilities: [
          { name: 'filesystem.list', kind: 'READ' },
          { name: 'document.extract_pdf', kind: 'READ' }
        ],
        client: { name: 'personal-agent-electron', version: '0.1.0' }
      }
    })
    stdout.push(
      JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: { protocolVersion: '9.9', server: { name: 'x', version: '0' } }
      }) + '\n'
    )
    await expect(p).rejects.toMatchObject({ code: RUNTIME_ERROR_CODE.HANDSHAKE_FAILED })
  })
})

describe('RUNTIME_ERROR_CODE 注册表', () => {
  it('码的字面值稳定（钉住契约，防 CANCELED/CANCELLED 那类拼写漂移）', () => {
    expect(RUNTIME_ERROR_CODE).toEqual({
      NOT_STARTED: 'RUNTIME_NOT_STARTED',
      TIMEOUT: 'RUNTIME_TIMEOUT',
      CANCELLED: 'RUNTIME_CANCELLED',
      STOPPED: 'RUNTIME_STOPPED',
      CRASHED: 'RUNTIME_CRASHED',
      HANDSHAKE_FAILED: 'RUNTIME_HANDSHAKE_FAILED',
      RESPONSE_INVALID: 'RUNTIME_RESPONSE_INVALID',
      DB_FAILED: 'RUNTIME_DB_FAILED',
      ORPHANED: 'RUNTIME_ORPHANED'
    })
  })
})

//  -----真实往返-----
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..', '..', '..')
const venvPy = join(repoRoot, 'services', 'agent-runtime', '.venv', 'Scripts', 'python.exe')
const runtimeCwd = join(repoRoot, 'services', 'agent-runtime')
const itReal = existsSync(venvPy) ? it : it.skip

itReal(
  '真实 spawn Python:system.ping -> pong',
  async () => {
    const sup = new PythonSupervisor({
      command: venvPy,
      args: ['-m', 'personal_agent'],
      capabilities: [],
      cwd: runtimeCwd
    })
    sup.start()
    const result = await sup.request('system.ping')
    expect(result).toEqual({})
    await sup.stop()
  },
  15000
)
itReal(
  '真实 spawn Python:initialize 握手 -> 校验 server -> ping',
  async () => {
    const sup = new PythonSupervisor({
      command: venvPy,
      args: ['-m', 'personal_agent'],
      cwd: runtimeCwd,
      capabilities: [
        { name: 'filesystem.list', kind: 'READ', description: '列出授权根目录下的条目' },
        {
          name: 'document.extract_pdf',
          kind: 'READ',
          description: '提取 PDF 每页文本与页码'
        }
      ]
    })
    sup.start()
    const init = await sup.initialize()
    expect(init.protocolVersion).toBe('0.1')
    expect(init.server.name).toBe('personal-agent-runtime')
    expect(init.server.version).toBe('0.1.0')

    const ping = await sup.request('system.ping')
    expect(ping).toEqual({})
    await sup.stop()
  },
  15000
)

// ----- 片 2b：反向 RPC（Python → TS）-----
describe('PythonSupervisor ~ 片 2b (host.execute_tool)', () => {
  interface Reply {
    jsonrpc: string
    id: string
    result?: Record<string, unknown>
    error?: { code: string; message: string }
  }

  /** 造一条 Python 发来的反向请求。over 用于覆盖字段制造非法输入。 */
  function hostLine(over: Record<string, unknown> = {}): string {
    return (
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'call-1',
        method: 'host.execute_tool',
        params: {
          callId: 'tc-1',
          capability: 'filesystem.list',
          arguments: { rootId: 'downloads' }
        },
        ...over
      }) + '\n'
    )
  }

  function makeSup(
    handler?: HostHandler,
    over: { defaultTimeoutMs?: number; hostTimeoutMs?: number } = {}
  ): {
    sup: PythonSupervisor
    written: string[]
    stdout: PassThrough
    stderr: PassThrough
  } {
    const fake = makeFakeChild()
    const sup = new PythonSupervisor({
      command: 'fake',
      args: [],
      capabilities: [],
      spawnFn: () => fake.child,
      defaultTimeoutMs: 5000,
      hostHandler: handler,
      ...over
    })
    sup.start()
    return { sup, written: fake.written, stdout: fake.stdout, stderr: fake.stderr }
  }

  /** handleHostRequest 是 async，回复不会同步出现在 written 里。 */
  async function replyAt(written: string[], index: number): Promise<Reply> {
    await vi.waitFor(() => expect(written.length).toBeGreaterThan(index))
    return JSON.parse(written[index]) as Reply
  }

  it('收到 host 请求 -> 调 handler -> 把 result 写回 stdin', async () => {
    const handler = vi.fn<HostHandler>(async () => ({ ok: true, entries: [] }))
    const { written, stdout } = makeSup(handler)

    stdout.push(hostLine())
    const reply = await replyAt(written, 0)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0][0]).toMatchObject({
      callId: 'tc-1',
      capability: 'filesystem.list',
      arguments: { rootId: 'downloads' }
    })
    expect(reply).toEqual({ jsonrpc: '2.0', id: 'call-1', result: { ok: true, entries: [] } })
  })

  it('handler 返回 ok:false -> 原样进 result，不走 error', async () => {
    // PDF 损坏是可预期的业务结果。塞进 error 会让 Python 侧
    // 把正常返回值当成通道故障，两条路径的错误处理完全不同。
    const { written, stdout } = makeSup(async () => ({
      ok: false,
      code: 'PDF_CORRUPT',
      reason: 'PDF 结构损坏'
    }))

    stdout.push(hostLine())
    const reply = await replyAt(written, 0)

    expect(reply.error).toBeUndefined()
    expect(reply.result).toMatchObject({ ok: false, code: 'PDF_CORRUPT' })
  })

  it('未注入 hostHandler -> 回 NOT_IMPLEMENTED', async () => {
    const { written, stdout } = makeSup(undefined)

    stdout.push(hostLine())
    const reply = await replyAt(written, 0)

    expect(reply.error?.code).toBe(ERROR_CODE.NOT_IMPLEMENTED)
    expect(reply.id).toBe('call-1')
  })

  it('id 用了 TS 的 req- 命名空间 -> 回 PROTOCOL_INVALID_REQUEST', async () => {
    const handler = vi.fn(async () => ({ ok: true }))
    const { written, stdout } = makeSup(handler)

    stdout.push(hostLine({ id: 'req-1' }))
    const reply = await replyAt(written, 0)

    expect(reply.error?.code).toBe(ERROR_CODE.PROTOCOL_INVALID_REQUEST)
    // id 不合法也得回：Python 侧在阻塞等，靠 id 原样带回去才能对上
    expect(reply.id).toBe('req-1')
    expect(handler).not.toHaveBeenCalled()
  })

  it('capability 不在 REQ-006 白名单 -> 回错且不执行', async () => {
    // SEC-007：shell.exec 这类根本不该被注册。
    // 校验必须在调 handler 之前，否则白名单只是文档。
    const handler = vi.fn(async () => ({ ok: true }))
    const { written, stdout } = makeSup(handler)

    stdout.push(
      hostLine({
        params: {
          callId: 'tc-x',
          capability: 'shell.exec',
          arguments: { command: 'format C:' }
        }
      })
    )
    const reply = await replyAt(written, 0)

    expect(reply.error?.code).toBe(ERROR_CODE.PROTOCOL_INVALID_REQUEST)
    expect(handler).not.toHaveBeenCalled()
  })

  it('handler 抛异常 -> 回 HOST_HANDLER_FAILED，异常不冒泡', async () => {
    const { written, stdout } = makeSup(async () => {
      throw new Error('boom')
    })

    // routeLine 跑在 stdout 的 data 回调里，异常冒出去就是 unhandled exception
    expect(() => stdout.push(hostLine())).not.toThrow()
    const reply = await replyAt(written, 0)

    expect(reply.error?.code).toBe(ERROR_CODE.HOST_HANDLER_FAILED)
    expect(reply.error?.message).toContain('boom')
  })

  it('host 请求不会误 resolve TS 自己的 pending', async () => {
    // 钉住 routeLine 分流后的那个 return。漏了的话同一条消息
    // 会接着走 settle，把请求当成响应 resolve 掉。
    const { sup, written, stdout } = makeSup(async () => ({ ok: true }))

    const p = sup.request('system.ping')
    expect(written).toHaveLength(1)
    const tsId = (JSON.parse(written[0]) as Reply).id

    // 构造撞车：Python 用了跟 TS pending 相同的 id
    stdout.push(hostLine({ id: tsId }))
    const reply = await replyAt(written, 1)
    expect(reply.error?.code).toBe(ERROR_CODE.PROTOCOL_INVALID_REQUEST)

    // pending 必须还挂着。被误 resolve 的话这里是 'resolved'，
    // 调用方拿到 undefined 当成功结果，两边都不报错。
    const state = await Promise.race([
      p.then(
        () => 'resolved',
        () => 'rejected'
      ),
      new Promise<string>((r) => setTimeout(() => r('pending'), 100))
    ])
    expect(state).toBe('pending')
  })

  // ----- 片 2c：hostTimeoutMs -----
  describe('host 超时', () => {
    /** handler 挂 delay 毫秒后才 resolve，用来触发超时。 */
    function slowHandler(delay: number): HostHandler {
      return () =>
        new Promise<Record<string, unknown>>((resolve) =>
          setTimeout(() => resolve({ ok: true, late: true }), delay)
        )
    }

    it('handler 超过 hostTimeoutMs -> 回 HOST_TIMEOUT', async () => {
      const { written, stdout } = makeSup(slowHandler(500), { hostTimeoutMs: 30 })

      stdout.push(hostLine())
      const reply = await replyAt(written, 0)

      expect(reply.error?.code).toBe(ERROR_CODE.HOST_TIMEOUT)
      // Python 侧阻塞在 readline 上等这个 id，丢了就是永久挂起
      expect(reply.id).toBe('call-1')
      expect(reply.error?.message).toContain('30ms')
    })

    it('超时后 handler 晚到的 result 被丢弃，不写第二行', async () => {
      const { written, stdout } = makeSup(slowHandler(120), { hostTimeoutMs: 20 })

      stdout.push(hostLine())
      await replyAt(written, 0)
      // 等晚到的 handler resolve 完
      await new Promise((r) => setTimeout(r, 250))

      // 再写一行的话 Python 会收到两个同 id 的响应：第二个进 inbox，
      // 主循环拿它去 dispatch，因缺 method 校验失败，白跑一轮往返。
      expect(written).toHaveLength(1)
      expect(written[0]).toContain(ERROR_CODE.HOST_TIMEOUT)
    })

    it('超时后 handler 晚到的异常也被丢弃，不写第二行', async () => {
      const { written, stdout } = makeSup(
        () =>
          new Promise<Record<string, unknown>>((_, reject) =>
            setTimeout(() => reject(new Error('late boom')), 120)
          ),
        { hostTimeoutMs: 20 }
      )

      stdout.push(hostLine())
      await replyAt(written, 0)
      await new Promise((r) => setTimeout(r, 250))

      expect(written).toHaveLength(1)
      expect(written[0]).not.toContain(ERROR_CODE.HOST_HANDLER_FAILED)
    })

    it('host 超时不影响 TS 自己的 pending 请求', async () => {
      const { sup, written, stdout } = makeSup(slowHandler(300), { hostTimeoutMs: 20 })

      const ping = sup.request('system.ping')
      const pingId = (JSON.parse(written[0]) as Reply).id
      stdout.push(hostLine())

      const timeout = await replyAt(written, 1)
      expect(timeout.error?.code).toBe(ERROR_CODE.HOST_TIMEOUT)

      stdout.push(JSON.stringify({ jsonrpc: '2.0', id: pingId, result: {} }) + '\n')
      await expect(ping).resolves.toEqual({})

      await new Promise((r) => setTimeout(r, 350))
      expect(written).toHaveLength(2)
    })
  })
})

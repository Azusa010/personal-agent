import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, it, expect, vi } from 'vitest'
import { PythonSupervisor } from './python-supervisor'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { RUNTIME_ERROR_CODE } from './error-code'

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
    const sup = new PythonSupervisor({ command: 'fake', args: [], spawnFn: () => child })
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
    const sup = new PythonSupervisor({ command: 'fake', args: [], spawnFn: () => child })
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
    const sup = new PythonSupervisor({ command: 'fake', args: [], spawnFn: () => child })
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
      spawnFn: () => child,
      defaultTimeoutMs: 50
    })
    sup.start()
    const p = sup.request('system.ping')
    await expect(p).rejects.toMatchObject({ code: RUNTIME_ERROR_CODE.TIMEOUT })
  }, 2000)
  it('崩溃:pending全部reject且广播runtime.crashed', async () => {
    const { child } = makeFakeChild()
    const sup = new PythonSupervisor({ command: 'fake', args: [], spawnFn: () => child })
    sup.start()

    const onCrashed = vi.fn()
    sup.on('runtime.crashed', onCrashed)
    const p = sup.request('system.ping')
    child.emit('exit', 1, null)
    await expect(p).rejects.toMatchObject({ code: RUNTIME_ERROR_CODE.CRASHED })
    expect(onCrashed).toHaveBeenCalledOnce()
  })
})

describe('PythonSupervisor ~ Slice 3', () => {
  it('stderr: 子进程 stderr 原样转发为 stderr 事件', async () => {
    const { child, stderr } = makeFakeChild()
    const sup = new PythonSupervisor({ command: 'fake', args: [], spawnFn: () => child })
    sup.start()

    const chunks: string[] = []
    sup.on('stderr', (c: string) => chunks.push(c))
    stderr.write('python 日志一行\n')
    await new Promise((r) => setImmediate(r))
    expect(chunks.join('')).toBe('python 日志一行\n')
  })
  it('cancel:AbortSignal 触发后 reject RUNTIME_CANCELLED', async () => {
    const { child } = makeFakeChild()
    const sup = new PythonSupervisor({ command: 'fake', args: [], spawnFn: () => child })
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
    const sup = new PythonSupervisor({ command: 'fake', args: [], spawnFn: () => child })
    sup.start()
    const p = sup.initialize()
    const req = JSON.parse(written[0])
    expect(req).toMatchObject({
      method: 'system.initialize',
      params: {
        protocolVersion: '0.1',
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
      HANDSHAKE_FAILED: 'RUNTIME_HANDSHAKE_FAILED'
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
      cwd: runtimeCwd
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

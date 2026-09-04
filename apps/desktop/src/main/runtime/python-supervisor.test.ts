import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, it, expect, vi } from 'vitest'
import { PythonSupervisor } from './python-supervisor'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

// 假子进程
function makeFakeChild(): { child: ChildProcess; written: string[]; stdout: PassThrough } {
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
  return { child: fake as unknown as ChildProcess, written, stdout }
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
    await expect(p).rejects.toMatchObject({ code: 'RUNTIME_TIMEOUT' })
  }, 100)
  it('崩溃:pending全部reject且广播runtime.crashed', async () => {
    const { child } = makeFakeChild()
    const sup = new PythonSupervisor({ command: 'fake', args: [], spawnFn: () => child })
    sup.start()

    const onCrashed = vi.fn()
    sup.on('runtime.crashed', onCrashed)
    const p = sup.request('system.ping')
    child.emit('exit', 1, null)
    await expect(p).rejects.toMatchObject({ code: 'RUNTIME_CRASHED' })
    expect(onCrashed).toHaveBeenCalledOnce()
  })
})

import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, it, expect } from 'vitest'
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

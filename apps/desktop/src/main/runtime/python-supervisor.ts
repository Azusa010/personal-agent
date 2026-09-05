import { ChildProcess, spawn, SpawnOptions } from 'node:child_process'
import EventEmitter from 'events'
import { PROTOCOL_VERSION, InitializeResult, InitializeParams } from '@personal-agent/protocol'
import { z } from 'zod'
import { RUNTIME_ERROR_CODE } from './error-code'

export type SpawnFn = (cmd: string, args: string[], opts?: SpawnOptions) => ChildProcess

export interface PythonSupervisorOptions {
  command: string
  args: string[]
  cwd?: string
  spawnFn?: SpawnFn
  defaultTimeoutMs?: number
}

interface ResponseMsg {
  id?: string | null
  result?: unknown
  error?: {
    code: string
    message: string
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
  cleanup?: () => void
}

export class RuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'RuntimeError'
  }
}

const CLIENT_INFO = {
  name: 'personal-agent-electron',
  version: '0.1.0'
}

export class PythonSupervisor extends EventEmitter {
  private child: ChildProcess | null = null
  private buffer = ''
  private readonly pending = new Map<string, Pending>()
  private idCounter = 0
  private readonly spawnFn: SpawnFn
  private readonly command: string
  private readonly args: string[]
  private readonly cwd?: string
  private readonly defaultTimeoutMs: number
  private stopping = false

  constructor(opts: PythonSupervisorOptions) {
    super()
    this.command = opts.command
    this.args = opts.args
    this.cwd = opts.cwd
    this.spawnFn = opts.spawnFn ?? (spawn as unknown as SpawnFn)
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30000
  }

  // spawn 启动子进程，监听三个管道
  start(): void {
    this.child = this.spawnFn(this.command, this.args, { cwd: this.cwd })

    // stdout => onStdout(chunk)对块进行切分
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))

    // stderr
    this.child.stderr?.setEncoding('utf8')
    this.child.stderr?.on('data', (chunk: string) => this.emit('stderr', chunk))

    // 崩溃
    this.child.on('error', (err) => {
      this.emit('stderr', `[supervisor] 子进程错误: ${err.message}\n`)
      this.handleCrash('error', err.message)
    })
    this.child.on('exit', (code, signal) => {
      this.emit('stderr', `[supervisor] 子进程退出: code=${code} signal=${signal}\n`)
      if (this.stopping)
        this.failAllPending(RUNTIME_ERROR_CODE.STOPPED, 'runtime 正在关闭') //通过stop()优雅退出
      else this.handleCrash('exit', `code=${code} signal=${signal}`) // 意外退出
    })
  }

  // 握手
  async initialize(): Promise<z.infer<typeof InitializeResult>> {
    /**
     * 与 Python runtime 做 initialize 握手。
     */
    const params = InitializeParams.safeParse({
      protocolVersion: PROTOCOL_VERSION,
      client: CLIENT_INFO
    })
    if (!params.success) {
      throw new RuntimeError(
        RUNTIME_ERROR_CODE.HANDSHAKE_FAILED,
        `initialize 参数不符合契约 ${params.error.message}`
      )
    }
    const result = await this.request('system.initialize', params.data)
    const parsed = InitializeResult.safeParse(result)
    if (!parsed.success) {
      throw new RuntimeError(
        RUNTIME_ERROR_CODE.HANDSHAKE_FAILED,
        `initialize 握手不符合契约 ${parsed.error.message}`
      )
    }
    return parsed.data
  }

  // 发送请求
  request(
    method: string,
    params: unknown = {},
    opts?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<unknown> {
    if (!this.child?.stdin) {
      return Promise.reject(new RuntimeError(RUNTIME_ERROR_CODE.NOT_STARTED, 'runtime 尚未启动'))
    }
    if (opts?.signal?.aborted) {
      return Promise.reject(new RuntimeError(RUNTIME_ERROR_CODE.CANCELLED, `请求 ${method} 已取消`))
    }
    const id = `req-${++this.idCounter}`
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id, (p) => {
          p.reject(
            new RuntimeError(RUNTIME_ERROR_CODE.TIMEOUT, `请求 ${method} 超时 (${timeoutMs}ms)`)
          )
        })
      }, timeoutMs)

      const onAbort = (): void => {
        this.settle(id, (p) => {
          p.reject(new RuntimeError(RUNTIME_ERROR_CODE.CANCELLED, `请求 ${method} 已取消`))
        })
      }

      opts?.signal?.addEventListener('abort', onAbort, { once: true })
      const cleanup = (): void => {
        opts?.signal?.removeEventListener('abort', onAbort)
      }

      this.pending.set(id, { resolve, reject, timer, cleanup })
      this.child!.stdin!.write(line)
    })
  }

  // 关闭
  stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.child) return resolve()
      this.stopping = true
      const timer = setTimeout(() => this.child?.kill(), 3000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      this.child.stdin?.end()
    })
  }

  // ===== 内部 =====
  private onStdout(chunk: string): void {
    this.buffer += chunk
    let n1: number
    // 取出所有完整行
    while ((n1 = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, n1)
      // 剩下的半行到下一块再拼
      this.buffer = this.buffer.slice(n1 + 1)
      this.routeLine(line)
    }
  }

  private routeLine(line: string): void {
    const text = line.trim()
    if (!text) return
    let msg: ResponseMsg
    try {
      msg = JSON.parse(text) as ResponseMsg
    } catch {
      this.emit('stderr', `[supervisor] stdout 非法 JSON: ${text}\n`)
      return
    }
    if (msg.id == null) return
    this.settle(msg.id, (p) => {
      if (msg.error) p.reject(new RuntimeError(msg.error?.code, msg.error?.message))
      else p.resolve(msg.result)
    })
  }

  // 拒绝所有未决请求
  private failAllPending(code: string, message: string): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, (p) => {
        p.reject(new RuntimeError(code, message))
      })
    }
  }

  private handleCrash(reason: string, detail: string): void {
    this.failAllPending(RUNTIME_ERROR_CODE.CRASHED, `子进程崩溃 (${reason}:${detail})`)
    this.emit('runtime.crashed', { reason, detail })
  }

  private settle(id: string, fn: (p: Pending) => void): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)
    p.cleanup?.()
    fn(p)
  }
}

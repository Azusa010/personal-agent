import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Windows adapter（DEP-011）的验收：发出去、探明真实结果、不伪造成功。
 *
 * 用假 electron 模块替身：真 Notification 会弹系统通知，CI/测试机上都不可
 * 依赖。替身记录构造参数与 show() 调用，事件由测试手动触发——
 * 「show 事件到达才算成功」这条契约因此可以被精确钉住。
 */
const { FakeNotification } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  class FakeNotification {
    /** 测试可切换：模拟无桌面环境 */
    static supported = true
    static isSupported(): boolean {
      return FakeNotification.supported
    }
    static instances: FakeNotification[] = []

    readonly options: { title?: string; body?: string }
    showCalls = 0
    private listeners = new Map<string, Listener[]>()

    constructor(options: { title?: string; body?: string }) {
      this.options = options
      FakeNotification.instances.push(this)
    }

    on(event: string, fn: Listener): this {
      const list = this.listeners.get(event) ?? []
      list.push(fn)
      this.listeners.set(event, list)
      return this
    }

    once(event: string, fn: Listener): this {
      const wrapped: Listener = (...args) => {
        const list = this.listeners.get(event) ?? []
        this.listeners.set(
          event,
          list.filter((f) => f !== wrapped)
        )
        fn(...args)
      }
      return this.on(event, wrapped)
    }

    /** 真 Electron Notification 继承 EventEmitter，适配器「先到先生效」的
     *  实现会用它摘掉后到的监听器；替身必须提供同一面 API。 */
    removeAllListeners(event?: string): this {
      if (event === undefined) {
        this.listeners.clear()
      } else {
        this.listeners.delete(event)
      }
      return this
    }

    show(): void {
      this.showCalls += 1
    }

    /** 测试手动触发，模拟 Electron 的事件到达。
     *  注意 'failed' 在真 Electron（Windows）上是 (event, error) 两参、
     *  error 是字符串——替身按同一签名发，少发一个参数就不是在测真实契约。 */
    emit(event: string, ...args: unknown[]): void {
      for (const fn of [...(this.listeners.get(event) ?? [])]) {
        fn(...args)
      }
    }
  }

  return { FakeNotification }
})

vi.mock('electron', () => ({
  Notification: FakeNotification
}))

import type { NotificationOutcome } from './notification-port'
import { ElectronNotificationAdapter } from './windows-notification'

const PENDING = Symbol('pending')

/** 断言 promise 还没 settle：与一个已 resolve 的哨兵赛跑。 */
async function expectPending(promise: Promise<unknown>): Promise<void> {
  const winner = await Promise.race([promise, Promise.resolve(PENDING)])
  expect(winner).toBe(PENDING)
}

/** 调 send 并把 rejection 预先标记为已处理。
 *  红灯期占位实现会 reject，而用例往往在 waitFor 超时处先失败、
 *  来不及给 pending 挂处理器——unhandled rejection 会把整个测试文件刷成
 *  file-level error，淹没真正的断言信号。挂一个空 catch 不影响后续对同一
 *  promise 的断言：它 reject 时 expect(...).resolves 照样红。 */
function sendTracked(
  adapter: ElectronNotificationAdapter,
  request: { title: string; body: string }
): Promise<NotificationOutcome> {
  const pending = adapter.send(request)
  void pending.catch(() => {})
  return pending
}

beforeEach(() => {
  FakeNotification.supported = true
  FakeNotification.instances = []
})

describe('ElectronNotificationAdapter', () => {
  it('系统不支持时回 ok:false，不创建通知', async () => {
    // 这条现在就该绿：isSupported 判定在脚手架里，不是 TODO 的一部分。
    FakeNotification.supported = false
    const out = await new ElectronNotificationAdapter().send({ title: 'T', body: 'B' })

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason.length).toBeGreaterThan(0)
    expect(FakeNotification.instances).toHaveLength(0)
  })

  it('title/body 原样进 Notification，show() 被调用', async () => {
    const adapter = new ElectronNotificationAdapter()
    const pending = sendTracked(adapter, { title: '个人代理提醒', body: '该读书了' })

    await vi.waitFor(() => expect(FakeNotification.instances).toHaveLength(1))
    const n = FakeNotification.instances[0]
    expect(n.options).toEqual({ title: '个人代理提醒', body: '该读书了' })
    expect(n.showCalls).toBe(1)

    n.emit('show')
    await expect(pending).resolves.toEqual({ ok: true })
  })

  it("'show' 事件到达前不 resolve：提前返回就是伪造成功", async () => {
    // US-06「不伪造成功」的适配器层表达：show() 调用本身不是结果，
    // 系统真的展示了（'show' 事件）才是。
    const adapter = new ElectronNotificationAdapter()
    const pending = sendTracked(adapter, { title: 'T', body: 'B' })

    await vi.waitFor(() => expect(FakeNotification.instances).toHaveLength(1))
    expect(FakeNotification.instances[0].showCalls).toBe(1)
    await expectPending(pending)

    FakeNotification.instances[0].emit('show')
    await expect(pending).resolves.toEqual({ ok: true })
  })

  it("'failed' 事件 → ok:false，reason 带上错误信息", async () => {
    // reason 会原样落进 reminders.failure_reason，必须能看懂为什么失败。
    const adapter = new ElectronNotificationAdapter()
    const pending = sendTracked(adapter, { title: 'T', body: 'B' })

    await vi.waitFor(() => expect(FakeNotification.instances).toHaveLength(1))
    FakeNotification.instances[0].emit('failed', {}, 'toast platform unavailable')

    const out = await pending
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('toast platform unavailable')
  })

  it('先到先生效：show 之后再 failed 不改变结果，也不抛', async () => {
    // 两个事件都注册了的话，晚到的那个不能再动已 settle 的 promise，
    // 也不能让监听器抛出来（unhandled rejection 会掀翻主进程日志）。
    const adapter = new ElectronNotificationAdapter()
    const pending = sendTracked(adapter, { title: 'T', body: 'B' })

    await vi.waitFor(() => expect(FakeNotification.instances).toHaveLength(1))
    const n = FakeNotification.instances[0]
    n.emit('show')
    await expect(pending).resolves.toEqual({ ok: true })

    expect(() => n.emit('failed', {}, 'late failure')).not.toThrow()
    await expect(pending).resolves.toEqual({ ok: true })
  })

  it('send 永不 reject：失败全部收进 outcome', async () => {
    const adapter = new ElectronNotificationAdapter()
    const pending = sendTracked(adapter, { title: 'T', body: 'B' })

    await vi.waitFor(() => expect(FakeNotification.instances).toHaveLength(1))
    FakeNotification.instances[0].emit('failed', {}, new Error('构造出的错误对象'))

    // 即使适配器拿到的是 Error 对象而不是字符串，也要收成 ok:false 而不是 reject。
    const out = await pending
    expect(out.ok).toBe(false)
  })
})

import { Notification } from 'electron'

import type {
  NotificationOutcome,
  NotificationPort,
  NotificationRequest
} from './notification-port'

/** Windows 通知 adapter。
 *
 *  Windows 上通知要显示应用名
 *  adapter 只负责：发出去、探明真实结果。
 */
export class ElectronNotificationAdapter implements NotificationPort {
  async send(request: NotificationRequest): Promise<NotificationOutcome> {
    if (!Notification.isSupported()) {
      return { ok: false, reason: '当前系统不支持 Electron Notification' }
    }
    // TODO(你填): 发送通知并探明真实结果。这是本 TASK 的命名交付物
    // 「Windows notification.send adapter」的本体。
    //
    // 契约（验收测试 windows-notification.test.ts 用假 electron 模块逐条钉住）：
    // 1. new Notification({ title: request.title, body: request.body })，然后 show()。
    // 2. 只有 'show' 事件到达（通知确实展示了）才 resolve { ok: true }。
    //    在 show() 调用后、'show' 事件前 resolve 就是伪造成功。
    // 3. 'failed' 事件（Windows 专有，参数 (event, error)）到达时
    //    resolve { ok: false, reason: ... }，reason 必须带上 error 信息——
    //    它会原样落进 reminders.failure_reason。
    // 4. 两个事件都用 once 语义注册（或手动保证只 resolve 一次）：
    //    谁先到谁生效，后到的不能再动同一个 promise。
    // 5. 返回的 promise 不允许 reject（Port 契约：失败收进 outcome），
    //    也不允许永远 pending——show/failed 二者必达其一。
    return new Promise<NotificationOutcome>((resolve) => {
      let settled = false
      let notification: Notification | undefined
      const finish = (outcome: NotificationOutcome): void => {
        if (settled) return
        settled = true

        if (notification) {
          notification.removeAllListeners('show')
          notification.removeAllListeners('failed')
        }

        resolve(outcome)
      }

      try {
        notification = new Notification({
          title: request.title,
          body: request.body
        })
        notification.once('show', () => {
          finish({ ok: true })
        })
        notification.once('failed', (_event, error) => {
          finish({ ok: false, reason: `Electron Notification failed: ${error}` })
        })
        notification.show()
      } catch (error) {
        finish({
          ok: false,
          reason: `Electron Notification failed to create: ${error instanceof Error ? error.message : String(error)}`
        })
      }
    })
  }
}

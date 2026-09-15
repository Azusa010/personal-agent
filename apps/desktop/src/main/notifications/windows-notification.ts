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

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type {
  PermissionDecision,
  PermissionNotice,
  SetModelSettingsInput
} from '../shared/ipc-contract'

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('personalAgent', {
      runtimeStatus: () => {
        return ipcRenderer.invoke('personal-agent:runtime-status')
      },
      listPdfs: (rootId: 'downloads') => {
        return ipcRenderer.invoke('personal-agent:list-pdfs', rootId)
      },
      indexedPdfs: () => {
        return ipcRenderer.invoke('personal-agent:indexed-pdfs')
      },
      listTasks: () => {
        return ipcRenderer.invoke('personal-agent:list-tasks')
      },
      runTask: (goal: string) => {
        return ipcRenderer.invoke('personal-agent:run-task', goal)
      },
      getTimeline: (taskId: string | null) => {
        return ipcRenderer.invoke('personal-agent:get-timeline', taskId)
      },
      respondPermission: (permissionId: string, decision: PermissionDecision) => {
        return ipcRenderer.invoke('personal-agent:permission-respond', permissionId, decision)
      },
      listPermissions: (taskId: string) => {
        return ipcRenderer.invoke('personal-agent:list-permissions', taskId)
      },
      getModelSettings: () => {
        return ipcRenderer.invoke('personal-agent:get-model-settings')
      },
      setModelSettings: (input: SetModelSettingsInput) => {
        return ipcRenderer.invoke('personal-agent:set-model-settings', input)
      },
      // 唯一一个 main → renderer 的推送通道。返回的函数取消订阅，
      // removeListener 必须传同一个包装引用：传原始 listener 取消不掉。
      onPermissionNotice: (listener: (notice: PermissionNotice) => void) => {
        const wrapped = (_event: IpcRendererEvent, notice: PermissionNotice): void => {
          listener(notice)
        }
        ipcRenderer.on('personal-agent:permission-notice', wrapped)
        return () => {
          ipcRenderer.removeListener('personal-agent:permission-notice', wrapped)
        }
      }
    })
  } catch (error) {
    console.error('IPC错误', error)
  }
}

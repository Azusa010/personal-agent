import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type {
  A2UIFormSubmitParams,
  A2UIRenderNotice,
  AgentStreamNotice,
  PermissionDecision,
  PermissionNotice,
  SetAgentProfileInput,
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
      listConversations: () => {
        return ipcRenderer.invoke('personal-agent:list-conversations')
      },
      getConversation: (conversationId: string) => {
        return ipcRenderer.invoke('personal-agent:get-conversation', conversationId)
      },
      sendMessage: (input: { conversationId: string | null; text: string }) => {
        return ipcRenderer.invoke('personal-agent:send-message', input)
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
      },
      onAgentStream: (listener: (notice: AgentStreamNotice) => void) => {
        const wrapped = (_event: IpcRendererEvent, notice: AgentStreamNotice): void => {
          listener(notice)
        }
        ipcRenderer.on('personal-agent:agent-stream', wrapped)
        return () => {
          ipcRenderer.removeListener('personal-agent:agent-stream', wrapped)
        }
      },
      getAgentProfile: () => {
        return ipcRenderer.invoke('personal-agent:get-agent-profile')
      },
      setAgentProfile: (input: SetAgentProfileInput) => {
        return ipcRenderer.invoke('personal-agent:set-agent-profile', input)
      },
      runWorkflow: (workflowId: string, inputs?: Record<string, unknown>) => {
        return ipcRenderer.invoke('personal-agent:run-workflow', { workflowId, inputs })
      },
      resetCircuitBreaker: (taskId: string, reason?: string) => {
        return ipcRenderer.invoke('personal-agent:reset-circuit-breaker', taskId, reason)
      },
      submitA2UIForm: (params: A2UIFormSubmitParams) => {
        return ipcRenderer.invoke('personal-agent:a2ui-form-submit', params)
      },
      onA2UIRender: (listener: (notice: A2UIRenderNotice) => void) => {
        const wrapped = (_event: IpcRendererEvent, notice: A2UIRenderNotice): void => {
          listener(notice)
        }
        ipcRenderer.on('personal-agent:a2ui-render-notice', wrapped)
        return () => {
          ipcRenderer.removeListener('personal-agent:a2ui-render-notice', wrapped)
        }
      },
      setTitleBarTheme: (theme: string) => {
        return ipcRenderer.invoke('personal-agent:set-title-bar-theme', theme)
      }
    })
  } catch (error) {
    console.error('IPC错误', error)
  }
}

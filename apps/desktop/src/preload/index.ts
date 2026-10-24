import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type {
  A2UIFormSubmitParams,
  A2UIRenderNotice,
  AgentStreamNotice,
  AppearanceView,
  PermissionDecision,
  PermissionNotice,
  SetAgentProfileInput,
  SetAppearanceInput,
  SetModelSettingsInput,
  CreateBotInput,
  UpdateBotInput,
  LogsGroupParams,
  LogsListParams,
  LogsReportInput
} from '../shared/ipc-contract'
import { parseThemeArgv } from '../shared/theme'

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('personalAgent', {
      runtimeStatus: () => {
        return ipcRenderer.invoke('personal-agent:runtime-status')
      },
      listPdfs: (rootId: 'workspace') => {
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
      sendMessage: (input: {
        conversationId: string | null
        text: string
        botId?: string | null
      }) => {
        return ipcRenderer.invoke('personal-agent:send-message', input)
      },
      listBots: () => {
        return ipcRenderer.invoke('personal-agent:list-bots')
      },
      getBot: (botId: string) => {
        return ipcRenderer.invoke('personal-agent:get-bot', botId)
      },
      createBot: (input: CreateBotInput) => {
        return ipcRenderer.invoke('personal-agent:create-bot', input)
      },
      updateBot: (input: UpdateBotInput) => {
        return ipcRenderer.invoke('personal-agent:update-bot', input)
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
      getWorkspace: () => {
        return ipcRenderer.invoke('personal-agent:workspace-get')
      },
      chooseWorkspace: () => {
        return ipcRenderer.invoke('personal-agent:workspace-choose')
      },
      switchWorkspace: (dir: string) => {
        return ipcRenderer.invoke('personal-agent:workspace-switch', dir)
      },
      removeWorkspaceBookmark: (dir: string) => {
        return ipcRenderer.invoke('personal-agent:workspace-remove-bookmark', dir)
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
      // 首帧主题：主进程用 additionalArguments 注入，同步可取。
      // 走 IPC 是异步的，等它回来时首屏已经按错误主题画完了。
      initialTheme: parseThemeArgv(process.argv) ?? 'light',
      getAppearance: () => {
        return ipcRenderer.invoke('personal-agent:get-appearance')
      },
      setAppearance: (input: SetAppearanceInput) => {
        return ipcRenderer.invoke('personal-agent:set-appearance', input)
      },
      onAppearanceChanged: (listener: (appearance: AppearanceView) => void) => {
        const wrapped = (_event: IpcRendererEvent, appearance: AppearanceView): void => {
          listener(appearance)
        }
        ipcRenderer.on('personal-agent:appearance-changed', wrapped)
        return () => {
          ipcRenderer.removeListener('personal-agent:appearance-changed', wrapped)
        }
      },
      listLogs: (params?: LogsListParams) => {
        return ipcRenderer.invoke('personal-agent:logs:list', params)
      },
      groupLogs: (params?: LogsGroupParams) => {
        return ipcRenderer.invoke('personal-agent:logs:groups', params)
      },
      exportLogs: (params?: { days?: number }) => {
        return ipcRenderer.invoke('personal-agent:logs:export', params)
      },
      clearLogs: () => {
        return ipcRenderer.invoke('personal-agent:logs:clear')
      },
      openLogsDir: () => {
        return ipcRenderer.invoke('personal-agent:logs:open-dir')
      },
      reportError: (input: LogsReportInput) => {
        return ipcRenderer.invoke('personal-agent:logs:report', input)
      }
    })
  } catch (error) {
    console.error('IPC错误', error)
  }
}

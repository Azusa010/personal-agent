import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  startRuntime,
  stopRuntime,
  getRuntimeStatus,
  requestRuntime,
  restartRuntime,
  createModelSettingsStore
} from './runtime/runtime-host'
import {
  FilesystemListParams,
  FilesystemListResult,
  ERROR_CODE,
  AGENT_RESET_CIRCUIT_BREAKER,
  ResetCircuitBreakerResult,
  A2UIFormSubmitParams
} from '@personal-agent/protocol'
import { RUNTIME_ERROR_CODE } from './runtime/error-code'
import type {
  GetModelSettingsResult,
  IpcErrorCode,
  ListPdfsResult,
  ListTasksResult,
  IndexedPdfsResult,
  PermissionListResult,
  PermissionNotice,
  PermissionRespondResult,
  SetModelSettingsResult,
  TimelineIpcResult,
  ConversationSummary,
  GetConversationResult,
  ListConversationsResult,
  SendMessageIpcResult,
  AgentStreamNotice,
  GetAgentProfileResult,
  SetAgentProfileResult,
  RunWorkflowInput,
  RunWorkflowIpcResult,
  A2UIFormSubmitIpcResult,
  A2UIRenderNotice
} from '../shared/ipc-contract'
import {
  formatA2UIFormSubmission,
  getA2UIRender,
  onA2UIRender,
  submitA2UIForm
} from './capabilities/plugins/a2ui'
import { getDb, closeDb } from './db/database'
import { getPgPool, closePgPool } from './db/postgres'
import { fetchActiveMemories } from './db/user-memory-repository'
import { assembleWorkingMemoryPrompt } from './tasks/memory-context'
import { upsertMany, findAll } from './db/pdf-repository'
import { getStore, closeStore, type SqliteDatabase } from './product-state/database'
import { SqliteTaskRepository } from './product-state/task-repository'
import { SqlitePlanRepository } from './product-state/plan-repository'
import { SqliteEventRepository } from './product-state/event-repository'
import { SqlitePermissionRepository } from './product-state/permission-repository'
import { SqliteToolExecutionRepository } from './product-state/tool-execution-repository'
import { SqliteReminderRepository } from './product-state/reminder-repository'
import { createPermissionBroker, type PermissionBroker } from './permission/permission-broker'
import { listTaskPermissions, respondToPermission } from './permission/permission-ipc'
import { getModelSettingsView, setModelSettings } from './settings/settings-ipc'
import { runTask, RunTaskDeps } from './tasks/run-task'
import { runWorkflow, RunWorkflowDeps } from './tasks/run-workflow'
import { getTimeline } from './tasks/get-timeline'
import { reconcileOrphanTasks } from './tasks/reconcile'
import { realVerificationPorts } from './verification/ports'
import { verifyTaskCompletion } from './verification/verify-task'
import icon from '../../resources/icon.png?asset'
import { configureHostExecutor, executeCapability } from './capabilities/host-executor'
import { ElectronNotificationAdapter } from './notifications/windows-notification'
import { fireReminder, type FireOutcome } from './scheduler/fire-reminder'
import { recoverReminders } from './scheduler/recover-reminders'
import { ReminderTimerService } from './scheduler/reminder-timer'
import type { ReminderRecord } from '../shared/domain'
import { SqliteConversationRepository } from './product-state/conversation-repository'
import { SqliteMessageRepository } from './product-state/message-repository'
import { getConversation } from './tasks/get-conversation'
import { buildHistory } from './tasks/history'
import { sendMessage, SendMessageInput } from './tasks/send-message'
import { onAgentStream } from './runtime/stream-fanout'
import { AGENT_PROFILE_FILE_NAME, createAgentProfileStore } from './settings/agent-profile'
import { getAgentProfileView, setAgentProfile } from './settings/agent-profile-ipc'
import { initVikingStore, resolveVikingStoreRoot } from './viking/viking-store'

const PRELOAD_PATH = join(__dirname, '../preload/index.js')

// 批准通道的三个通道名。respond 与 list 是 renderer 发起的 invoke，
// notice 是 main 主动推的——preload 里唯一一个 ipcRenderer.on。
const PERMISSION_RESPOND_CHANNEL = 'personal-agent:permission-respond'
const PERMISSION_LIST_CHANNEL = 'personal-agent:list-permissions'
const PERMISSION_NOTICE_CHANNEL = 'personal-agent:permission-notice'

// 设置面板的两个通道（TASK-030）。get 只回「配没配」，Key 明文不出主进程（SEC-008）。
const MODEL_SETTINGS_GET_CHANNEL = 'personal-agent:get-model-settings'
const MODEL_SETTINGS_SET_CHANNEL = 'personal-agent:set-model-settings'

const AGENT_STREAM_CHANNEL = 'personal-agent:agent-stream'

const AGENT_PROFILE_GET_CHANNEL = 'personal-agent:get-agent-profile'
const AGENT_PROFILE_SET_CHANNEL = 'personal-agent:set-agent-profile'

const A2UI_RENDER_NOTICE_CHANNEL = 'personal-agent:a2ui-render-notice'
const A2UI_FORM_SUBMIT_CHANNEL = 'personal-agent:a2ui-form-submit'

// null = 库没打开，批准通道不可用。
let permissionBroker: PermissionBroker | null = null
let reminderTimer: ReminderTimerService | null = null

// 推给所有窗口。当前只有一个窗口；多窗口时每个都会收到同一条 notice，
function broadcastPermissionNotice(notice: PermissionNotice): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(PERMISSION_NOTICE_CHANNEL, notice)
    }
  }
}

function broadcastAgentStream(notice: AgentStreamNotice): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(AGENT_STREAM_CHANNEL, notice)
    }
  }
}

function broadcastA2UIRender(notice: A2UIRenderNotice): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(A2UI_RENDER_NOTICE_CHANNEL, notice)
    }
  }
}

function createWindow(): void {
  // Create the browser window.
  // 隐藏原生标题栏:窗口顶栏由渲染层自绘(纸感顶栏 + 拖拽区)。
  // Windows 上启用 titleBarOverlay,系统窗控钮(最小化/最大化/关闭)仍由 OS 绘制,
  // 配色与纸感主题一致,且保留 Win11 悬停贴靠布局;macOS 的红绿灯随 hidden 自动保留。
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    minWidth: 720,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(process.platform === 'win32'
      ? { titleBarOverlay: { color: '#efe9dd', symbolColor: '#6e675a', height: 40 } }
      : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    console.log('[main] ready-to-show event fired, showing mainWindow')
    mainWindow.show()
    mainWindow.focus()
  })

  setTimeout(() => {
    if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.warn('[main] ready-to-show fallback triggered: forcing mainWindow.show()')
      mainWindow.show()
      mainWindow.focus()
    }
  }, 3000)

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] webContents did-finish-load')
  })

  mainWindow.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL) => {
    console.error('[main] webContents did-fail-load:', errorCode, errorDescription, validatedURL)
  })

  mainWindow.webContents.on('render-process-gone', (_, details) => {
    console.error('[main] render-process-gone:', details)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  // 与 electron-builder.yml 的 appId 一致：Windows 通知按 AUMID 匹配开始菜单快捷方式，
  // 两处不一致时开发态看着正常、安装版反而弹不出通知。
  electronApp.setAppUserModelId('com.personalagent.app')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const agentProfileStore = createAgentProfileStore({
    filePath: join(app.getPath('userData'), AGENT_PROFILE_FILE_NAME)
  })

  function runTaskDeps(store: SqliteDatabase): RunTaskDeps {
    return {
      db: store,
      tasks: new SqliteTaskRepository(store),
      plans: new SqlitePlanRepository(store),
      events: new SqliteEventRepository(store),
      profile: () => agentProfileStore.load(),
      workingMemory: async () => {
        try {
          const pool = getPgPool()
          const cards = await fetchActiveMemories(pool, { limit: 15 })
          return assembleWorkingMemoryPrompt(cards)
        } catch {
          return ''
        }
      },
      send: requestRuntime,
      verify: (input) =>
        verifyTaskCompletion(
          {
            tasks: new SqliteTaskRepository(store),
            plans: new SqlitePlanRepository(store),
            events: new SqliteEventRepository(store),
            permissions: new SqlitePermissionRepository(store),
            executions: new SqliteToolExecutionRepository(store),
            reminders: new SqliteReminderRepository(store),
            ...realVerificationPorts
          },
          input
        )
    }
  }

  function runWorkflowDeps(store: SqliteDatabase): RunWorkflowDeps {
    return {
      db: store,
      tasks: new SqliteTaskRepository(store),
      plans: new SqlitePlanRepository(store),
      events: new SqliteEventRepository(store),
      send: requestRuntime
    }
  }

  // 收尸必须在注册任何 IPC handler 之前：否则 Renderer 可能先读到一个僵尸 running。
  // 失败不中断启动 —— PDF 列表走的是另一个库（db/database），不该被 product-state 连累。
  try {
    const store = getStore()
    const orphans = reconcileOrphanTasks({
      db: store,
      tasks: new SqliteTaskRepository(store),
      events: new SqliteEventRepository(store)
    })
    if (orphans > 0) console.warn(`[product-state] 启动时收成 ${orphans} 个孤儿任务`)
  } catch (err) {
    console.error('[product-state] 启动收尸失败', err)
  }

  try {
    const store = getStore()
    permissionBroker = createPermissionBroker({
      permissions: new SqlitePermissionRepository(store),
      events: new SqliteEventRepository(store),
      notify: broadcastPermissionNotice
    })
  } catch (err) {
    console.error('[permission] broker 构造失败，批准通道不可用', err)
  }

  // 提醒链路与 WRITE 能力的生产接线（TASK-024/025 的组件在 TASK-028 接到启动路径上）。
  //
  // 一次做完三件事：通知端口 → 定时器与启动恢复 → 把权限/幂等/调度三组依赖交给
  // host-executor。少了最后一环，agent 那条的 WRITE 能力会永远停在
  // PERMISSION_REQUIRED——组件都在，只是没人把它们接上。
  try {
    const store = getStore()
    const reminders = new SqliteReminderRepository(store)
    const events = new SqliteEventRepository(store)
    const notifications = new ElectronNotificationAdapter()
    // timer 到点与启动补发共用同一个「发送一次并记录结果」编排（fire-reminder.ts）。
    const fire = (reminder: ReminderRecord): Promise<FireOutcome> =>
      fireReminder(reminder, { db: store, reminders, events, notifications })
    reminderTimer = new ReminderTimerService({ fire })
    const timer = reminderTimer

    configureHostExecutor({
      // broker 为 null（库没打开）时整组不接：那时 WRITE 会被拒，
      // 与「批准面板不可用」是同一种看得见的失败，不静默放行。
      permission:
        permissionBroker === null
          ? undefined
          : { gate: permissionBroker, tasks: new SqliteTaskRepository(store) },
      idempotency: { executions: new SqliteToolExecutionRepository(store) },
      scheduler: {
        db: store,
        reminders,
        events,
        notifications,
        armTimer: (reminder) => timer.arm(reminder)
      },
      knowledge: {
        search: (args) =>
          requestRuntime('knowledge.search', args) as Promise<Record<string, unknown>>
      },
      memory: {
        search: (args) =>
          requestRuntime('user_memory.search', args) as Promise<Record<string, unknown>>
      }
    })

    // 初始化 Viking 维基存储骨架（目录与 5 大核心分类 L0/L1 模板）
    void initVikingStore(resolveVikingStoreRoot()).catch((err) =>
      console.error('[viking] 初始化维基存储目录失败', err)
    )

    // 启动恢复：扫 reminders 按四状态分流（重挂未来的 / 补发错过的 / 有发送证据只补记 /
    // 终态原样保留）。失败不中断启动——它只影响提醒，不该挡住窗口。
    void recoverReminders({ reminders, events, arm: (r) => timer.arm(r), fire }).then(
      (outcomes) => {
        const acted = outcomes.filter((o) => o.kind !== 'skipped')
        if (acted.length > 0) {
          console.warn(`[scheduler] 启动恢复处置了 ${acted.length} 条 Reminder`)
        }
      },
      (err) => console.error('[scheduler] 启动恢复失败', err)
    )
  } catch (err) {
    console.error('[scheduler] 提醒链路接线失败，Reminder 不会触发', err)
  }

  // IPC test
  ipcMain.handle('personal-agent:runtime-status', () => getRuntimeStatus())

  ipcMain.handle(
    'personal-agent:list-pdfs',
    async (_e, rootId: unknown): Promise<ListPdfsResult> => {
      const params = FilesystemListParams.safeParse({ rootId })
      if (!params.success) {
        return {
          ok: false,
          code: ERROR_CODE.PROTOCOL_INVALID_REQUEST,
          message: `rootId 非法: ${String(rootId)}`
        }
      }

      const outcome = await executeCapability('filesystem_list', { rootId: params.data.rootId })
      if (outcome['ok'] !== true) {
        return {
          ok: false,
          code: String(outcome['code']) as IpcErrorCode,
          message: String(outcome['reason'])
        }
      }
      const result = FilesystemListResult.safeParse(outcome)
      if (!result.success) {
        return {
          ok: false,
          code: RUNTIME_ERROR_CODE.RESPONSE_INVALID,
          message: 'executor 输出不符合 FilesystemListResult'
        }
      }

      try {
        upsertMany(getDb(), params.data.rootId, result.data.entries, new Date().toISOString())
      } catch (dbErr) {
        console.error('[db] 落库失败', dbErr)
      }
      return { ok: true, entries: result.data.entries }
    }
  )

  ipcMain.handle('personal-agent:indexed-pdfs', async (): Promise<IndexedPdfsResult> => {
    try {
      return { ok: true, entries: findAll(getDb()) }
    } catch (err) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODE.DB_FAILED,
        message: err instanceof Error ? err.message : String(err)
      }
    }
  })
  // 侧栏历史会话列表的数据源。只读，不写库；排序交给 Renderer 按 createdAt 分组。
  ipcMain.handle('personal-agent:list-tasks', (): ListTasksResult => {
    let store: SqliteDatabase
    try {
      store = getStore()
    } catch (err) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODE.DB_FAILED,
        message: err instanceof Error ? err.message : String(err)
      }
    }
    try {
      return { ok: true, tasks: new SqliteTaskRepository(store).findAll() }
    } catch (err) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODE.DB_FAILED,
        message: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle('personal-agent:list-conversations', (): ListConversationsResult => {
    let store: SqliteDatabase
    try {
      store = getStore()
    } catch (err) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODE.DB_FAILED,
        message: err instanceof Error ? err.message : String(err)
      }
    }
    try {
      const rows = new SqliteConversationRepository(store).list()
      const conversations: ConversationSummary[] = rows.map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt
      }))
      return { ok: true, conversations }
    } catch (err) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODE.DB_FAILED,
        message: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle(
    'personal-agent:get-conversation',
    (_e, conversationId: unknown): Promise<GetConversationResult> => {
      let store: SqliteDatabase
      try {
        store = getStore()
      } catch (err) {
        return Promise.resolve({
          ok: false,
          code: RUNTIME_ERROR_CODE.DB_FAILED,
          message: err instanceof Error ? err.message : String(err)
        })
      }
      return getConversation(conversationId as string, {
        messages: new SqliteMessageRepository(store),
        tasks: new SqliteTaskRepository(store),
        plans: new SqlitePlanRepository(store),
        events: new SqliteEventRepository(store)
      })
    }
  )

  ipcMain.handle(
    'personal-agent:send-message',
    async (_e, input: unknown): Promise<SendMessageIpcResult> => {
      let store: SqliteDatabase
      try {
        store = getStore()
      } catch (err) {
        return {
          ok: false,
          code: RUNTIME_ERROR_CODE.DB_FAILED,
          message: err instanceof Error ? err.message : String(err),
          conversationId: ''
        }
      }
      return sendMessage(input as SendMessageInput, {
        conversations: new SqliteConversationRepository(store),
        messages: new SqliteMessageRepository(store),
        buildHistory,
        runTask: (goal, history) => runTask(goal, runTaskDeps(store), history)
      })
    }
  )

  ipcMain.handle(
    'personal-agent:run-workflow',
    async (_e, input: unknown): Promise<RunWorkflowIpcResult> => {
      let store: SqliteDatabase
      try {
        store = getStore()
      } catch (err) {
        return {
          ok: false,
          code: RUNTIME_ERROR_CODE.DB_FAILED,
          message: err instanceof Error ? err.message : String(err)
        }
      }
      return runWorkflow(input as RunWorkflowInput, runWorkflowDeps(store))
    }
  )

  ipcMain.handle(
    'personal-agent:reset-circuit-breaker',
    async (_e, taskId: unknown, reason?: unknown): Promise<ResetCircuitBreakerResult> => {
      if (typeof taskId !== 'string' || !taskId) {
        return {
          ok: false,
          state: 'OPEN',
          message: 'taskId 必须为非空字符串'
        }
      }
      try {
        const response = await requestRuntime(AGENT_RESET_CIRCUIT_BREAKER, {
          taskId,
          reason: typeof reason === 'string' ? reason : undefined
        })
        const parsed = ResetCircuitBreakerResult.safeParse(response)
        if (parsed.success) {
          return parsed.data
        }
        return {
          ok: true,
          state: 'HALF_OPEN',
          message: '熔断器已复位为半开状态'
        }
      } catch (err) {
        return {
          ok: false,
          state: 'OPEN',
          message: err instanceof Error ? err.message : String(err)
        }
      }
    }
  )
  // 只读通道：不写库，因此不需要事务。
  // getTimeline 同样永不抛，库层面的失败由它自己转成 ok:false。
  ipcMain.handle('personal-agent:get-timeline', (_e, taskId: unknown): TimelineIpcResult => {
    let store: SqliteDatabase
    try {
      store = getStore()
    } catch (err) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODE.DB_FAILED,
        message: err instanceof Error ? err.message : String(err)
      }
    }
    return getTimeline(taskId, {
      tasks: new SqliteTaskRepository(store),
      events: new SqliteEventRepository(store),
      plans: new SqlitePlanRepository(store)
    })
  })

  // 批准面板的「批准 / 拒绝」。respondToPermission 永不抛，入参收窄与错误码映射都在里面。
  ipcMain.handle(
    PERMISSION_RESPOND_CHANNEL,
    (_e, permissionId: unknown, decision: unknown, reason?: unknown): PermissionRespondResult => {
      if (permissionBroker === null) {
        return {
          ok: false,
          code: RUNTIME_ERROR_CODE.DB_FAILED,
          message: '批准通道未就绪：product-state 库没打开'
        }
      }
      return respondToPermission({ permissionId, decision, reason }, { broker: permissionBroker })
    }
  )

  // 诊断面板的权限记录观察区。走 broker.listForTask，state 是含 expired 的投影值。
  ipcMain.handle(PERMISSION_LIST_CHANNEL, (_e, taskId: unknown): PermissionListResult => {
    if (permissionBroker === null) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODE.DB_FAILED,
        message: '批准通道未就绪：product-state 库没打开'
      }
    }
    return listTaskPermissions(taskId, { broker: permissionBroker })
  })
  // 设置面板：Key / Model / Base URL。逻辑都在 settings-ipc（纯函数 + 注入 deps），
  // 这里只接线真实存储（userData + safeStorage）与真实重启端口。
  const modelSettingsStore = createModelSettingsStore()
  const initialModelSettings = modelSettingsStore.load()
  if (initialModelSettings?.tavilyApiKey && !process.env.TAVILY_API_KEY) {
    process.env.TAVILY_API_KEY = initialModelSettings.tavilyApiKey
  }
  if (initialModelSettings?.tavilyEndpoint && !process.env.TAVILY_ENDPOINT) {
    process.env.TAVILY_ENDPOINT = initialModelSettings.tavilyEndpoint
  }

  ipcMain.handle(MODEL_SETTINGS_GET_CHANNEL, (): GetModelSettingsResult =>
    getModelSettingsView({ store: modelSettingsStore, runtime: { restart: restartRuntime } })
  )
  ipcMain.handle(
    MODEL_SETTINGS_SET_CHANNEL,
    (_e, input: unknown): Promise<SetModelSettingsResult> =>
      setModelSettings(input, {
        store: modelSettingsStore,
        runtime: { restart: restartRuntime }
      })
  )

  ipcMain.handle(AGENT_PROFILE_GET_CHANNEL, (): GetAgentProfileResult =>
    getAgentProfileView({ store: agentProfileStore })
  )
  ipcMain.handle(AGENT_PROFILE_SET_CHANNEL, (_e, input: unknown): Promise<SetAgentProfileResult> =>
    setAgentProfile(input, { store: agentProfileStore })
  )

  onAgentStream(broadcastAgentStream)
  onA2UIRender(broadcastA2UIRender)

  ipcMain.handle(
    A2UI_FORM_SUBMIT_CHANNEL,
    async (_e, rawParams: unknown): Promise<A2UIFormSubmitIpcResult> => {
      const parsed = A2UIFormSubmitParams.safeParse(rawParams)
      if (!parsed.success) {
        return {
          ok: false,
          code: ERROR_CODE.INVALID_ARGUMENT,
          message: `表单提交参数不合法: ${parsed.error.message}`
        }
      }
      const { renderId, actionId, formData } = parsed.data
      if (!renderId) {
        return {
          ok: false,
          code: ERROR_CODE.INVALID_ARGUMENT,
          message: 'renderId 不能为空'
        }
      }
      const render = getA2UIRender(renderId)
      if (!render) {
        return {
          ok: false,
          code: ERROR_CODE.INVALID_ARGUMENT,
          message: `未找到渲染记录: ${renderId}`
        }
      }

      let store: SqliteDatabase
      try {
        store = getStore()
      } catch (err) {
        return {
          ok: false,
          code: RUNTIME_ERROR_CODE.DB_FAILED,
          message: err instanceof Error ? err.message : String(err)
        }
      }

      const events = new SqliteEventRepository(store)
      submitA2UIForm(renderId, actionId, formData, events)

      // 回流闭环 (Bug 17)：将表单提交结果格式化为 Agent 继续执行的输入，并发送至会话
      const continuationPrompt = formatA2UIFormSubmission(render.document, formData, actionId)
      const messagesRepo = new SqliteMessageRepository(store)
      const matchingMessage = messagesRepo.findByTaskId(render.taskId)
      const conversationId = matchingMessage ? matchingMessage.conversationId : null

      void sendMessage(
        { conversationId, text: continuationPrompt },
        {
          conversations: new SqliteConversationRepository(store),
          messages: messagesRepo,
          buildHistory,
          runTask: (goal, history) => runTask(goal, runTaskDeps(store), history)
        }
      )

      return {
        ok: true,
        actionId,
        formData,
        accepted: true
      }
    }
  )

  const THEME_TITLEBAR_OVERLAYS: Record<string, { color: string; symbolColor: string }> = {
    classic: { color: '#efe9dd', symbolColor: '#6e675a' },
    'paper-warm': { color: '#ede9e0', symbolColor: '#736d63' },
    'paper-dark': { color: '#252420', symbolColor: '#e6e2dc' }
  }

  ipcMain.handle('personal-agent:set-title-bar-theme', (_e, theme: unknown) => {
    if (process.platform !== 'win32') return { ok: true }
    const themeKey = typeof theme === 'string' ? theme : 'classic'
    const overlay = THEME_TITLEBAR_OVERLAYS[themeKey] ?? THEME_TITLEBAR_OVERLAYS.classic
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try {
          win.setTitleBarOverlay({
            color: overlay.color,
            symbolColor: overlay.symbolColor,
            height: 40
          })
        } catch (err) {
          console.warn('[main] setTitleBarOverlay update failed:', err)
        }
      }
    }
    return { ok: true }
  })

  createWindow()

  void startRuntime()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
let isQuitting = false
app.on('before-quit', (event) => {
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true
  reminderTimer?.dispose()
  void stopRuntime()
    .finally(() => permissionBroker?.dispose())
    .finally(() => closeDb())
    .finally(() => closeStore())
    .finally(() => closePgPool())
    .finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

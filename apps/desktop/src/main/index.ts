import { app, shell, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
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
  AppearanceView,
  GetAppearanceResult,
  GetModelSettingsResult,
  IpcErrorCode,
  ListPdfsResult,
  ListTasksResult,
  IndexedPdfsResult,
  PermissionListResult,
  PermissionNotice,
  PermissionRespondResult,
  SetAppearanceResult,
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
  A2UIRenderNotice,
  A2UIUpdateNotice,
  ListBotsResult,
  GetBotResult,
  CreateBotInput,
  CreateBotResult,
  UpdateBotInput,
  UpdateBotResult
} from '../shared/ipc-contract'
import {
  formatA2UIFormSubmission,
  getA2UIRender,
  onA2UIRender,
  onA2UIRenderUpdate,
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
import type { LogsReportInput } from '../shared/ipc-contract'
import { SqliteConversationRepository } from './product-state/conversation-repository'
import { SqliteMessageRepository } from './product-state/message-repository'
import { getConversation } from './tasks/get-conversation'
import { buildHistory } from './tasks/history'
import { sendMessage, SendMessageInput } from './tasks/send-message'
import { onAgentStream } from './runtime/stream-fanout'
import { AGENT_PROFILE_FILE_NAME, createAgentProfileStore } from './settings/agent-profile'
import { getAgentProfileView, setAgentProfile } from './settings/agent-profile-ipc'
import {
  ensureWorkspaceState,
  loadWorkspaceState,
  WORKSPACE_FILE_NAME
} from './settings/workspace-store'
import {
  chooseWorkspace,
  getWorkspaceView,
  removeWorkspaceBookmark,
  switchWorkspace,
  type WorkspaceIpcDeps
} from './settings/workspace-ipc'
import { APPEARANCE_FILE_NAME, createAppearanceStore } from './settings/appearance'
import { applySystemAppearance, getAppearanceView, setThemePreference } from './theme/theme-ipc'
import {
  THEME_ARGV_PREFIX,
  TITLE_BAR_OVERLAYS,
  WINDOW_BACKGROUNDS,
  toAppearanceView,
  type EffectiveTheme
} from '../shared/theme'
import { initVikingStore, resolveVikingStoreRoot } from './viking/viking-store'
import { SqliteBotRepository } from './product-state/bot-repository'
import { createBotHandler, getBotHandler, listBotsHandler, updateBotHandler } from './tasks/bot-ipc'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { JsonlSink } from './observability/jsonl-sink'
import { Logger } from './observability/logger'
import { LOGS_CHANNELS, clearLogs, exportLogs, groupLogs, listLogs } from './observability/logs-ipc'
import { installConsoleBridge } from './observability/console-bridge'
import { installCrashGuard } from './observability/crash-guard'
import { installAppLogger } from './observability/app-logger'
import { createNodeLogStore, nodeFileSystem } from './observability/node-fs'
import { resolveLogDir } from './observability/log-paths'

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

// 外观（主题）：get/set 由 renderer 发起，changed 是 main 主动推的
// （用户在设置页切换，或 system 偏好下操作系统换了主题）。
const APPEARANCE_GET_CHANNEL = 'personal-agent:get-appearance'
const APPEARANCE_SET_CHANNEL = 'personal-agent:set-appearance'
const APPEARANCE_CHANGED_CHANNEL = 'personal-agent:appearance-changed'

const A2UI_RENDER_NOTICE_CHANNEL = 'personal-agent:a2ui-render-notice'
const A2UI_RENDER_UPDATE_CHANNEL = 'personal-agent:a2ui-render-update'
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

function broadcastA2UIRenderUpdate(notice: A2UIUpdateNotice): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(A2UI_RENDER_UPDATE_CHANNEL, notice)
    }
  }
}

function broadcastAppearance(appearance: AppearanceView): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(APPEARANCE_CHANGED_CHANNEL, appearance)
    }
  }
}

// 系统窗控钮与窗口底色跟着主题走：这两个是 OS 绘制的部分，CSS 管不到。
// 单个窗口失败只影响观感，不让它冒泡打断切换流程。
function applyThemeToWindows(theme: EffectiveTheme): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.setBackgroundColor(WINDOW_BACKGROUNDS[theme])
      if (process.platform === 'win32') {
        win.setTitleBarOverlay({ ...TITLE_BAR_OVERLAYS[theme], height: 40 })
      }
    } catch (err) {
      console.warn('[main] 应用窗口主题失败:', err)
    }
  }
}

/** 应用并广播：窗口层（底色 + 窗控钮）与渲染层（class + token）必须同帧对齐。 */
function applyAppearance(appearance: AppearanceView): void {
  // themeSource 只影响原生控件（对话框、滚动条、系统菜单）与 prefers-color-scheme；
  // 渲染层的配色由 .dark class 决定。两处取值同源，不会互相打脸。
  nativeTheme.themeSource = appearance.preference
  applyThemeToWindows(appearance.effective)
  broadcastAppearance(appearance)
}

function createWindow(theme: EffectiveTheme): void {
  // Create the browser window.
  // 隐藏原生标题栏:窗口顶栏由渲染层自绘。
  // Windows 上启用 titleBarOverlay,系统窗控钮(最小化/最大化/关闭)仍由 OS 绘制,
  // 配色必须与当前主题一致,且保留 Win11 悬停贴靠布局;macOS 的红绿灯随 hidden 自动保留。
  //
  // backgroundColor 与首帧主题同值：窗口先于 renderer 首帧显示，底色不同会白闪一下。
  // additionalArguments 把主题带进 preload（CSP 禁内联脚本，首帧没法从 HTML 注入）。
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    backgroundColor: WINDOW_BACKGROUNDS[theme],
    ...(process.platform === 'win32'
      ? { titleBarOverlay: { ...TITLE_BAR_OVERLAYS[theme], height: 40 } }
      : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`${THEME_ARGV_PREFIX}${theme}`]
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

  // 日志系统必须早于其它初始化：App 启动阶段的崩溃/启动失败也要能被记录。
  const logDir = resolveLogDir(app.getPath('userData'))
  const logSink = new JsonlSink({
    dir: logDir,
    fs: nodeFileSystem,
    onError: (error) => {
      // 不能用 console.error：它已被 bridge 接管，写盘失败会形成回环。
      process.stderr.write(`[logs] 写入失败: ${String(error)}\n`)
    }
  })
  const appLogger = new Logger({ sink: logSink, sessionId: randomUUID() })
  installAppLogger(appLogger)
  installCrashGuard({ logger: appLogger, process })
  installConsoleBridge(appLogger)
  app.on('before-quit', () => {
    logSink.close()
  })

  const prunedLogs = logSink.prune()
  if (prunedLogs.deleted.length > 0) {
    appLogger.info({
      source: 'main',
      event: 'logs.retention.pruned',
      message: `清理过期日志 ${prunedLogs.deleted.length} 个`,
      context: { deleted: prunedLogs.deleted.length, dir: logDir }
    })
    appLogger.flush()
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const agentProfileStore = createAgentProfileStore({
    filePath: join(app.getPath('userData'), AGENT_PROFILE_FILE_NAME)
  })

  // 工作区选择：启动时读 workspace.json（缺失则落 ~/.saki-bot 家目录），
  // 并写进本进程 env——resolveRoot 每次调用都实时读它，Python 由 spawn 继承。
  const workspaceFilePath = join(app.getPath('userData'), WORKSPACE_FILE_NAME)
  ensureWorkspaceState(workspaceFilePath)
  process.env.PERSONAL_AGENT_WORKSPACE_DIR = loadWorkspaceState(workspaceFilePath)?.current

  const workspaceIpcDeps: WorkspaceIpcDeps = {
    filePath: workspaceFilePath,
    hasActiveTask: () => {
      try {
        const tasks = new SqliteTaskRepository(getStore()).findAll()
        return tasks.some((t) => t.status === 'running' || t.status === 'waiting_permission')
      } catch {
        // 库打不开时宁可挡住切换，也不冒中途换根的风险
        return true
      }
    },
    pickDir: async () => {
      const picked = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory']
      })
      return picked.canceled ? null : (picked.filePaths[0] ?? null)
    },
    restartRuntime: async () => {
      await restartRuntime()
    }
  }

  const appearanceStore = createAppearanceStore({
    filePath: join(app.getPath('userData'), APPEARANCE_FILE_NAME)
  })

  const themeDeps = {
    store: appearanceStore,
    systemPrefersDark: () => nativeTheme.shouldUseDarkColors,
    apply: applyAppearance
  }

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
  const logsDeps = { store: createNodeLogStore(logDir), dir: logDir }

  ipcMain.handle(LOGS_CHANNELS.list, (_event, params: unknown) => listLogs(params, logsDeps))
  ipcMain.handle(LOGS_CHANNELS.groups, (_event, params: unknown) => groupLogs(params, logsDeps))
  ipcMain.handle(LOGS_CHANNELS.export, (_event, params: unknown) => {
    const result = exportLogs(params, logsDeps)
    if (!result.ok) return result
    try {
      mkdirSync(logDir, { recursive: true })
      const target = join(app.getPath('downloads'), `personal-agent-logs-${Date.now()}.json`)
      writeFileSync(target, result.bundle, 'utf8')
      return { ok: true as const, path: target }
    } catch (err) {
      return {
        ok: false as const,
        code: 'OBSERVABILITY_EXPORT_FAILED',
        message: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle(LOGS_CHANNELS.clear, () => clearLogs(logsDeps))
  ipcMain.handle(LOGS_CHANNELS.openDir, async () => {
    mkdirSync(logDir, { recursive: true })
    return shell.openPath(logDir)
  })

  // renderer 上报：5s 窗口内最多 10 条，超出的直接丢弃（渲染错误容易成灾）。
  let reportWindowStart = 0
  let reportCount = 0
  ipcMain.handle('personal-agent:logs:report', (_event, input: unknown) => {
    const payload = (input ?? {}) as Partial<LogsReportInput>
    const nowMs = Date.now()
    if (nowMs - reportWindowStart >= 5000) {
      reportWindowStart = nowMs
      reportCount = 0
    }
    if (reportCount >= 10) return { ok: true as const, dropped: true }
    reportCount += 1

    const level = payload.level
    appLogger.log({
      level:
        level === 'debug' || level === 'info' || level === 'warn' || level === 'fatal'
          ? level
          : 'error',
      source: 'renderer',
      event:
        typeof payload.event === 'string' && payload.event !== ''
          ? payload.event
          : 'renderer.error',
      message:
        typeof payload.message === 'string' && payload.message !== ''
          ? payload.message
          : '未命名渲染错误',
      ...(typeof payload.stack === 'string' ? { stack: payload.stack } : {}),
      ...(typeof payload.taskId === 'string' ? { taskId: payload.taskId } : {}),
      ...(payload.context === undefined ? {} : { context: payload.context })
    })
    return { ok: true as const }
  })

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

  // 工作区：读视图 / 选择并切换 / 书签直切 / 删书签。切换含 running 拒切、env 更新与 runtime 重启。
  ipcMain.handle('personal-agent:workspace-get', () => getWorkspaceView(workspaceIpcDeps))
  ipcMain.handle('personal-agent:workspace-choose', () => chooseWorkspace(workspaceIpcDeps))
  ipcMain.handle('personal-agent:workspace-switch', (_e, dir: unknown) =>
    switchWorkspace(workspaceIpcDeps, dir)
  )
  ipcMain.handle('personal-agent:workspace-remove-bookmark', (_e, dir: unknown) =>
    removeWorkspaceBookmark(workspaceIpcDeps, dir)
  )

  ipcMain.handle(AGENT_PROFILE_GET_CHANNEL, (): GetAgentProfileResult =>
    getAgentProfileView({ store: agentProfileStore })
  )
  ipcMain.handle(AGENT_PROFILE_SET_CHANNEL, (_e, input: unknown): Promise<SetAgentProfileResult> =>
    setAgentProfile(input, { store: agentProfileStore })
  )

  ipcMain.handle(APPEARANCE_GET_CHANNEL, (): GetAppearanceResult => getAppearanceView(themeDeps))
  ipcMain.handle(APPEARANCE_SET_CHANNEL, (_e, input: unknown): SetAppearanceResult =>
    setThemePreference(input, themeDeps)
  )

  // 系统主题变化：只有 preference=system 时才跟随；手动模式不动。
  nativeTheme.on('updated', () => applySystemAppearance(themeDeps))

  onAgentStream(broadcastAgentStream)
  onA2UIRender(broadcastA2UIRender)
  onA2UIRenderUpdate(broadcastA2UIRenderUpdate)

  ipcMain.handle('personal-agent:list-bots', (): ListBotsResult => {
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
      const bots = listBotsHandler({
        bots: new SqliteBotRepository(store),
        convs: new SqliteConversationRepository(store)
      })
      if (bots.ok) {
        return bots
      }
      return {
        ok: false,
        code: RUNTIME_ERROR_CODE.DB_FAILED,
        message: bots.message
      }
    } catch (error) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODE.DB_FAILED,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('personal-agent:get-bot', (_e, botId: string): GetBotResult => {
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
      const bot = getBotHandler(botId, {
        bots: new SqliteBotRepository(store),
        convs: new SqliteConversationRepository(store)
      })
      if (bot.ok) {
        return {
          ok: true,
          bot: bot.bot
        }
      }
      return {
        ok: false,
        code: RUNTIME_ERROR_CODE.DB_FAILED,
        message: bot.message
      }
    } catch (error) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODE.DB_FAILED,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('personal-agent:create-bot', (_e, input: CreateBotInput): CreateBotResult => {
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
      const bot = createBotHandler(input, {
        bots: new SqliteBotRepository(store),
        convs: new SqliteConversationRepository(store)
      })
      if (bot.ok) {
        return {
          ok: true,
          bot: bot.bot
        }
      }
      return {
        ok: false,
        code: RUNTIME_ERROR_CODE.DB_FAILED,
        message: bot.message
      }
    } catch (error) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODE.DB_FAILED,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('personal-agent:update-bot', (_e, input: UpdateBotInput): UpdateBotResult => {
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
      const result = updateBotHandler(input, {
        bots: new SqliteBotRepository(store),
        convs: new SqliteConversationRepository(store)
      })
      if (result.ok) {
        return {
          ok: true,
          bot: result.bot
        }
      }
      return {
        ok: false,
        code: RUNTIME_ERROR_CODE.DB_FAILED,
        message: result.message
      }
    } catch (error) {
      return {
        ok: false,
        code: RUNTIME_ERROR_CODE.DB_FAILED,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })

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

  // 首帧主题：落盘偏好 + 系统偏好合成一次，窗口创建、窗控钮、preload 参数共用这一个值。
  // nativeTheme.themeSource 设成同一值，让原生对话框与系统控件也跟随（class 策略只管 CSS）。
  const initialAppearance = toAppearanceView(
    appearanceStore.load(),
    nativeTheme.shouldUseDarkColors
  )
  nativeTheme.themeSource = initialAppearance.preference

  createWindow(initialAppearance.effective)

  void startRuntime()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      // 重新建窗口时按「当下」的偏好算，不能沿用启动时快照。
      const current = toAppearanceView(appearanceStore.load(), nativeTheme.shouldUseDarkColors)
      createWindow(current.effective)
    }
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

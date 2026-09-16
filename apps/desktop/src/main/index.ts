import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { startRuntime, stopRuntime, getRuntimeStatus, requestRuntime } from './runtime/runtime-host'
import { FilesystemListParams, FilesystemListResult, ERROR_CODE } from '@personal-agent/protocol'
import { RUNTIME_ERROR_CODE } from './runtime/error-code'
import type {
  IpcErrorCode,
  ListPdfsResult,
  ListTasksResult,
  IndexedPdfsResult,
  PermissionListResult,
  PermissionNotice,
  PermissionRespondResult,
  RunTaskIpcResult,
  TimelineIpcResult
} from '../shared/ipc-contract'
import { getDb, closeDb } from './db/database'
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
import { runTask } from './tasks/run-task'
import { getTimeline } from './tasks/get-timeline'
import { reconcileOrphanTasks } from './tasks/reconcile'
import { realVerificationPorts } from './verification/ports'
import { verifyTaskCompletion } from './verification/verify-task'
import icon from '../../resources/icon.png?asset'
import { executeCapability } from './capabilities/host-executor'

const PRELOAD_PATH = join(__dirname, '../preload/index.js')

// 批准通道的三个通道名。respond 与 list 是 renderer 发起的 invoke，
// notice 是 main 主动推的——preload 里唯一一个 ipcRenderer.on。
const PERMISSION_RESPOND_CHANNEL = 'personal-agent:permission-respond'
const PERMISSION_LIST_CHANNEL = 'personal-agent:list-permissions'
const PERMISSION_NOTICE_CHANNEL = 'personal-agent:permission-notice'

// null = 库没打开，批准通道不可用。
let permissionBroker: PermissionBroker | null = null

// 推给所有窗口。当前只有一个窗口；多窗口时每个都会收到同一条 notice，
function broadcastPermissionNotice(notice: PermissionNotice): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(PERMISSION_NOTICE_CHANNEL, notice)
  }
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    minWidth: 720,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
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
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

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

      const outcome = await executeCapability('filesystem.list', { rootId: params.data.rootId })
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
  ipcMain.handle(
    'personal-agent:run-task',
    async (_e, goal: unknown): Promise<RunTaskIpcResult> => {
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
      // runTask 的契约是永不抛、总返回 RunTaskIpcResult：
      // 任务失败（包括 runtime 未启动、超时、Python 回错）都是 ok:true + status:'failed'。
      return runTask(goal, {
        db: store,
        tasks: new SqliteTaskRepository(store),
        plans: new SqlitePlanRepository(store),
        events: new SqliteEventRepository(store),
        send: requestRuntime,
        // 完成判定（TASK-026）：completed 的唯一闸口。判定表要读真库、真 PDF、
        // 真文件系统，所以每次调用重建一遍依赖，与上面几条 IPC 的写法一致。
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
      })
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
    (_e, permissionId: unknown, decision: unknown): PermissionRespondResult => {
      if (permissionBroker === null) {
        return {
          ok: false,
          code: RUNTIME_ERROR_CODE.DB_FAILED,
          message: '批准通道未就绪：product-state 库没打开'
        }
      }
      return respondToPermission({ permissionId, decision }, { broker: permissionBroker })
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
  void stopRuntime()
    .finally(() => permissionBroker?.dispose())
    .finally(() => closeDb())
    .finally(() => closeStore())
    .finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

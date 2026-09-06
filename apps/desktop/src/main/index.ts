import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { startRuntime, stopRuntime, getRuntimeStatus, requestRuntime } from './runtime/runtime-host'
import { FilesystemListParams, FilesystemListResult, ERROR_CODE } from '@personal-agent/protocol'
import { RuntimeError } from './runtime/python-supervisor'
import { RUNTIME_ERROR_CODE } from './runtime/error-code'
import type { IpcErrorCode, ListPdfsResult } from '../shared/ipc-contract'
import icon from '../../resources/icon.png?asset'

const PRELOAD_PATH = join(__dirname, '../preload/index.js')

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
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

      try {
        const raw = await requestRuntime('filesystem.list', params.data)
        const result = FilesystemListResult.safeParse(raw)
        if (!result.success) {
          return {
            ok: false,
            code: RUNTIME_ERROR_CODE.RESPONSE_INVALID,
            message: 'Python 响应不符合 FilesystemListResult'
          }
        }
        return { ok: true, entries: result.data.entries }
      } catch (err) {
        const code = (
          err instanceof RuntimeError ? err.code : RUNTIME_ERROR_CODE.CRASHED
        ) as IpcErrorCode
        return { ok: false, code, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )
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
  void stopRuntime().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

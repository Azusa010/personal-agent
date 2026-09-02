import { contextBridge, ipcRenderer } from 'electron'

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('personalAgent', {
      runtimeStatus: () => {
        return ipcRenderer.invoke('personal-agent:runtime-status')
      },
      listPdfs: (_rootId: string) => {
        throw new Error('NOT_IMPLEMENTED')
      }
    })
  } catch (error) {
    console.error('IPC错误', error)
  }
}

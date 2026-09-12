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
      listPdfs: (rootId: 'downloads') => {
        return ipcRenderer.invoke('personal-agent:list-pdfs', rootId)
      },
      indexedPdfs: () => {
        return ipcRenderer.invoke('personal-agent:indexed-pdfs')
      },
      runTask: (goal: string) => {
        return ipcRenderer.invoke('personal-agent:run-task', goal)
      }
    })
  } catch (error) {
    console.error('IPC错误', error)
  }
}

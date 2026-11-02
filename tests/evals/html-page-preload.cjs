const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('evalHost', {
  submit: (value) => ipcRenderer.send('eval-submission', value),
  ask: (value) => ipcRenderer.send('eval-question', value)
})

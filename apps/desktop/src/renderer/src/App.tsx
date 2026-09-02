import { useState } from 'react'

function App(): React.JSX.Element {
  const [status, setStatus] = useState('Empty')
  const ipcHandle = async (): Promise<void> => {
    const response = await window.personalAgent.runtimeStatus()
    setStatus(JSON.stringify(response, null, 2))
  }

  return (
    <>
      <div>
        <h1>Personal Agent</h1>
        <button onClick={ipcHandle}>Send IPC</button>
        <div id="response">{status}</div>
      </div>
    </>
  )
}

export default App

import { useState } from 'react'
import type { ListPdfsResult } from '../../shared/ipc-contract'
function App(): React.JSX.Element {
  const [status, setStatus] = useState('Empty')
  const ipcHandle = async (): Promise<void> => {
    const response = await window.personalAgent.runtimeStatus()
    setStatus(JSON.stringify(response, null, 2))
  }

  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfResult, setPdfResult] = useState<ListPdfsResult | null>(null)

  const handleListPdfs = async (): Promise<void> => {
    setPdfLoading(true)
    setPdfResult(null)
    try {
      setPdfResult(await window.personalAgent.listPdfs('downloads'))
    } catch (err) {
      setPdfResult({
        ok: false,
        code: 'RUNTIME_CRASHED',
        message: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setPdfLoading(false)
    }
  }

  return (
    <>
      <div>
        <h1>Personal Agent</h1>
        <button onClick={ipcHandle}>Send IPC</button>
        <div id="response">{status}</div>
        <h2>PDF 列表</h2>
        <button onClick={handleListPdfs} disabled={pdfLoading}>
          {pdfLoading ? '加载中…' : '列出 PDF'}
        </button>

        {pdfResult !== null && !pdfResult.ok && (
          <p>
            [{pdfResult.code}] {pdfResult.message}
          </p>
        )}

        {pdfResult !== null && pdfResult.ok && pdfResult.entries.length === 0 && (
          <p>~/Downloads 里没有 PDF</p>
        )}

        {pdfResult !== null && pdfResult.ok && pdfResult.entries.length > 0 && (
          <ul>
            {pdfResult.entries.map((entry) => (
              <li key={entry.absolutePath}>
                <div>{entry.name}</div>
                <div>
                  {entry.modifiedAt} · {Math.round(entry.sizeBytes / 1024)} KB
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

export default App

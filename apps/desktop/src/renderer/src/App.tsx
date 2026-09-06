import { useState } from 'react'
import type { ListPdfsResult, IndexedPdfsResult } from '../../shared/ipc-contract'
function App(): React.JSX.Element {
  const [status, setStatus] = useState('Empty')
  const ipcHandle = async (): Promise<void> => {
    const response = await window.personalAgent.runtimeStatus()
    setStatus(JSON.stringify(response, null, 2))
  }

  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfResult, setPdfResult] = useState<ListPdfsResult | null>(null)
  const [dbResult, setDbResult] = useState<IndexedPdfsResult | null>(null)
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

  const handleReadDb = async (): Promise<void> => {
    setDbResult(await window.personalAgent.indexedPdfs())
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
        <h2>库里的索引</h2>
        <button onClick={handleReadDb}>从库读</button>

        {dbResult !== null && !dbResult.ok && (
          <p>
            [{dbResult.code}] {dbResult.message}
          </p>
        )}

        {dbResult !== null && dbResult.ok && (
          <p>共 {dbResult.entries.length} 条（先点上面「列出 PDF」才会有数据）</p>
        )}

        {dbResult !== null && dbResult.ok && (
          <ul>
            {dbResult.entries.map((row) => (
              <li key={row.absolutePath}>
                <div>{row.name}</div>
                <div>
                  首次入库 {row.firstSeenAt} · 最近见到 {row.lastSeenAt}
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

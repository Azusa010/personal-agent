// 设计稿预览服务器:静态托管本目录 + 保存文件时通过 SSE 通知浏览器自动刷新
// 用法: node preview-server.mjs   →  http://localhost:8899/
// 纯 Node 内置模块,用完即可删除。
import { createServer } from 'node:http'
import { readFile, watch } from 'node:fs'
import { extname, join, dirname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = 8899
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

const clients = new Set()
let timer
watch(ROOT).on('change', () => {
  clearTimeout(timer)
  timer = setTimeout(() => {
    for (const res of clients) res.write('data: reload\n\n')
  }, 120)
})

const RELOAD_SNIPPET =
  '<script>new EventSource("/__reload").onmessage=e=>{if(e.data==="reload")location.reload()}</script>'

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/__reload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write('retry: 1000\n\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  const rel = url.pathname === '/' ? 'linear-agent-workspace.html' : decodeURIComponent(url.pathname.slice(1))
  const file = normalize(join(ROOT, rel))
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end()
    return
  }
  readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('404 not found: ' + rel)
      return
    }
    const type = MIME[extname(file)] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(type.startsWith('text/html') ? buf + RELOAD_SNIPPET : buf)
  })
}).listen(PORT, () => {
  console.log(`design preview: http://localhost:${PORT}/`)
})

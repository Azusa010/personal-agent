import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * 全 wiki 锚点校验（改动后必跑）。
 *
 * 查四类问题（生成器历史上都产出过）：
 *   1. 越界：`end` 超过文件真实行数 + 1（+1 是生成器对「整文件引用」的惯例）；
 *   2. 缺失：目标文件在仓库里不存在；
 *   3. 畸形：片段不是 `L起-L止`（例如漏写第二个 L 的 `#L1-245`、`#LL`、中文数字）；
 *   4. 显示文本与目标行号不一致（读者看到的行号与跳转结果对不上）。
 *
 * 显示文本用短名（runtime.py）而目标写全路径是本 wiki 的既有风格，不作问题。
 */
const repo = fileURLToPath(new URL('../../', import.meta.url))
const root = fileURLToPath(new URL('../zh/content/', import.meta.url))

const ANCHOR = /\[([^\]]*?):(\d+)-(\d+)\]\(file:\/\/([^)#]+)#L(\d+)-L(\d+)\)/g
const ANY_LINK = /\]\(file:\/\/([^)#]*)#([^)\s]+)\)/g
const WELL_FORMED = /^L\d+(-L\d+)?$/

const wcCache = new Map()
function totalLines(relPath) {
  if (wcCache.has(relPath)) return wcCache.get(relPath)
  let lines
  try {
    // wc -l 口径：以换行符计数，末尾空元素不计
    lines = readFileSync(join(repo, relPath), 'utf8').split('\n').length - 1
  } catch {
    lines = null
  }
  wcCache.set(relPath, lines)
  return lines
}

const outOfRange = []
const missing = []
const malformed = []
const mismatched = []
let anchors = 0

for (const file of walk(root)) {
  const source = readFileSync(file, 'utf8')
  source.split('\n').forEach((line, index) => {
    const where = `${file.replace(repo, '')}:${index + 1}`

    for (const m of line.matchAll(ANCHOR)) {
      anchors += 1
      const [, , dFrom, dTo, targetPath, tFrom, tTo] = m
      if (dFrom !== tFrom || dTo !== tTo) {
        mismatched.push(`${where} 显示 ${dFrom}-${dTo} vs 目标 ${tFrom}-${tTo}`)
      }
      const total = totalLines(targetPath)
      if (total === null) {
        missing.push(`${where} ${targetPath}`)
        continue
      }
      if (Number(tTo) > total + 1 || Number(tFrom) < 1 || Number(tTo) < Number(tFrom)) {
        outOfRange.push(`${where} ${targetPath} 共 ${total} 行，锚点 ${tFrom}-${tTo}`)
      }
    }

    for (const m of line.matchAll(ANY_LINK)) {
      if (!WELL_FORMED.test(m[2])) malformed.push(`${where} #${m[2]}`)
    }
  })
}

console.log(`锚点 ${anchors} 条`)
console.log(
  `越界 ${outOfRange.length} / 缺失 ${missing.length} / 畸形 ${malformed.length} / 行号不一致 ${mismatched.length}`
)
for (const line of [...outOfRange, ...missing, ...malformed].slice(0, 30)) console.log(' -', line)
for (const line of mismatched.slice(0, 15)) console.log(' ~', line)

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (name.endsWith('.md')) yield path
  }
}
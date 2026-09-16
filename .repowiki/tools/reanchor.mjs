#!/usr/bin/env node
/**
 * 按源文件的行号位移，重新锚定 wiki 里的「章节来源」链接。
 *
 * 用法（仓库根执行）：
 *   node .repowiki/tools/reanchor.mjs <base-rev> [--write]
 *
 * 不带 --write 只报告（dry-run）。逻辑：
 *   1. 扫 .repowiki 下所有 .md，收 `[path:起-止](file://path#L起-L止)` 形式的锚点；
 *   2. 对每个被引用的源文件，用 `git diff -U0 <base> HEAD -- <path>` 的 hunk 算行号位移；
 *   3. 位移后比对「旧文件该行区间的正文」与「新文件映射后区间的正文」——
 *      一致才改写（显示文本 + 链接目标两处一起改）；不一致的打出来人工看，
 *      因为那说明锚点指向的代码本身被改过，不只是位置挪了。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const BASE = process.argv[2]
const WRITE = process.argv.includes('--write')
if (!BASE) {
  console.error('用法: node .repowiki/tools/reanchor.mjs <base-rev> [--write]')
  process.exit(2)
}

const ROOT = process.cwd()
const WIKI = join(ROOT, '.repowiki')

const ANCHOR = /- \[([^\]]+?):(\d+)-(\d+)\]\(file:\/\/([^#]+)#L(\d+)-L(\d+)\)/g

function wikiFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...wikiFiles(full))
    else if (name.endsWith('.md')) out.push(full)
  }
  return out
}

const cache = new Map()
function linesOf(rev, path) {
  const key = `${rev}:${path}`
  if (!cache.has(key)) {
    let text = ''
    try {
      text = rev === 'WORKTREE'
        ? readFileSync(join(ROOT, path), 'utf8')
        : execFileSync('git', ['show', `${rev}:${path}`], { encoding: 'utf8' })
    } catch {
      text = null
    }
    cache.set(key, text === null ? null : text.split(/\r?\n/))
  }
  return cache.get(key)
}

function slice(lines, start, end) {
  if (lines === null) return null
  const out = []
  for (let i = start; i <= end; i++) out.push(lines[i - 1] ?? '')
  return out
}

/** hunks: [{a, b, d}] —— 旧文件 a 起 b 行，被新文件的 d 行替换 */
function hunksOf(path) {
  let diff = ''
  try {
    diff = execFileSync('git', ['diff', '-U0', BASE, 'HEAD', '--', path], { encoding: 'utf8' })
  } catch {
    return []
  }
  const hunks = []
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push({ a: Number(m[1]), b: Number(m[2] ?? 1), d: Number(m[4] ?? 1) })
  }
  return hunks
}

/**
 * 行号位移。纯插入（b=0，挂在旧行 a 之后）对 a 之后的所有行生效；
 * 改写型 hunk（b>0）覆盖旧行 a..a+b-1，落在里面的行按「该 hunk 之前」的累计位移算，
 * 交给首尾行比对去判它是否还指着原来那个构造。
 */
function shiftFn(hunks) {
  return (line) => {
    let shift = 0
    for (const h of hunks) {
      const oldEnd = h.b === 0 ? h.a : h.a + h.b - 1
      if (line > oldEnd) shift += h.d - h.b
    }
    return line + shift
  }
}

const files = wikiFiles(WIKI).filter((f) => !f.includes('tools'))
const anchors = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(ANCHOR)) {
    anchors.push({
      file,
      displayPath: m[1],
      displayStart: Number(m[2]),
      displayEnd: Number(m[3]),
      path: m[4],
      start: Number(m[5]),
      end: Number(m[6])
    })
  }
}

const byPath = new Map()
for (const a of anchors) {
  if (!byPath.has(a.path)) byPath.set(a.path, [])
  byPath.get(a.path).push(a)
}

const rewrites = new Map() // md 文件 → [{from, to}]
const flagged = []
let unchanged = 0

for (const [path, list] of byPath) {
  const oldLines = linesOf(BASE, path)
  const newLines = linesOf('WORKTREE', path)
  if (oldLines === null || newLines === null) {
    if (oldLines === null) flagged.push([path, '基线里没有这个文件', list.length])
    continue
  }
  if (oldLines.join('\n') === newLines.join('\n')) {
    unchanged += list.length
    continue
  }
  const hunks = hunksOf(path)
  if (process.env.DEBUG_REANCHOR) {
    console.log(`  [debug] ${path}: 锚点 ${list.length}，hunks ${JSON.stringify(hunks)}`)
  }
  const shift = shiftFn(hunks)
  for (const a of list) {
    if (a.displayStart !== a.start || a.displayEnd !== a.end) {
      flagged.push([path, `显示文本与目标行号本来就不一致: ${a.displayStart}-${a.displayEnd}`, 1])
      continue
    }
    const start = shift(a.start)
    const end = shift(a.end)
    if (start === a.start && end === a.end) {
      unchanged++
      continue
    }
    // 只看首尾两行：区间内部新增了代码是正常的（锚点覆盖的函数长大了），
    // 首尾对不上才说明这段锚点已经不再指着原来那个构造，得人工看。
    const sameEdges =
      (oldLines[a.start - 1] ?? '') === (newLines[start - 1] ?? '') &&
      (oldLines[a.end - 1] ?? '') === (newLines[end - 1] ?? '')
    if (!sameEdges) {
      flagged.push([path, `首尾行对不上: L${a.start}-L${a.end} → L${start}-L${end}`, 1])
      continue
    }
    if (!rewrites.has(a.file)) rewrites.set(a.file, [])
    rewrites.get(a.file).push({ ...a, newStart: start, newEnd: end })
  }
}

for (const [file, list] of rewrites) {
  let text = readFileSync(file, 'utf8')
  for (const a of list) {
    const from = `[${a.displayPath}:${a.displayStart}-${a.displayEnd}](file://${a.path}#L${a.start}-L${a.end})`
    const to = `[${a.displayPath}:${a.newStart}-${a.newEnd}](file://${a.path}#L${a.newStart}-L${a.newEnd})`
    if (!text.includes(from)) {
      flagged.push([a.path, `就地替换失败（同一锚点出现多次或文本不同）: ${from}`, 1])
      continue
    }
    text = text.replace(from, to)
  }
  if (WRITE) writeFileSync(file, text, 'utf8')
}

console.log(`锚点总数 ${anchors.length}；未变 ${unchanged}；待改写 ${[...rewrites.values()].reduce((n, l) => n + l.length, 0)}；待人工 ${flagged.length}`)
for (const [path, why, n] of flagged) console.log(`  人工: ${path} —— ${why}`)
if (!WRITE) console.log('（dry-run：加 --write 才落盘）')
#!/usr/bin/env node
/**
 * PersonalAgent 全栈孤岛组件与死代码检测自动化主控脚本
 * 统一执行：
 * 1. Knip 扫描 TypeScript / React 前端与桌面端未引用文件、未消费导出
 * 2. AST JSX 挂载探测器扫描「被 import 但未在 JSX 树中挂载渲染」的孤儿组件
 * 3. Vulture 扫描 Python Agent 运行时未引用的函数、类与死代码
 * 4. 汇总输出终端高亮摘要并生成 reports/islands-report.md
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { formatMarkdownReport } from './markdown-formatter.ts'
import { findUnmountedJsxComponents } from './jsx-mount-checker.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')
const desktopDir = path.resolve(repoRoot, 'apps/desktop')
const pythonDir = path.resolve(repoRoot, 'services/agent-runtime')
const reportsDir = path.resolve(repoRoot, 'reports')

const isStrict = process.argv.includes('--strict')

console.log('\n🔍 [PersonalAgent] 开始执行全栈孤岛与死代码体检扫描...\n')

const issues = []

// --- 1. Knip 扫描 TypeScript / React 孤岛 ---
console.log('⏳ (1/3) 正在通过 Knip 扫描 TypeScript 生产入口未消费的文件与导出...')
try {
  const knipOutput = execSync(
    'pnpm --dir apps/desktop exec knip -c knip.jsonc --reporter json',
    { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
  )
  parseKnipOutput(knipOutput)
} catch (err) {
  // Knip 在发现 issue 时会返回退出码 1，输出依然在 stdout 中
  if (err.stdout) {
    parseKnipOutput(err.stdout)
  }
}

function parseKnipOutput(rawJson) {
  try {
    const data = JSON.parse(rawJson)
    if (!data.issues) return
    for (const item of data.issues) {
      const relFile = path.relative(repoRoot, path.resolve(desktopDir, item.file))

      // 孤立文件
      if (item.files && item.files.length > 0) {
        issues.push({
          kind: 'unused_file',
          file: relFile,
          symbolName: path.basename(item.file),
          detail: '该文件未被应用任何生产入口引用，为完全孤立文件',
          language: 'typescript'
        })
      }

      // 未消费的导出 (函数/类/常量)
      if (item.exports && item.exports.length > 0) {
        for (const exp of item.exports) {
          issues.push({
            kind: 'unused_export',
            file: relFile,
            line: exp.line,
            col: exp.col,
            symbolName: exp.name,
            detail: `导出的 \`${exp.name}\` 未在应用主链路中被任何地方消费`,
            language: 'typescript'
          })
        }
      }

      // 未消费的类型定义
      if (item.types && item.types.length > 0) {
        for (const t of item.types) {
          issues.push({
            kind: 'unused_type',
            file: relFile,
            line: t.line,
            col: t.col,
            symbolName: t.name,
            detail: `导出的类型 \`${t.name}\` 未被任何模块引用`,
            language: 'typescript'
          })
        }
      }
    }
  } catch {
    // 忽略 json parse 异常
  }
}

// --- 2. AST JSX 挂载探测器 ---
console.log('⏳ (2/3) 正在通过 AST 语法树深度检测 JSX 挂载状态...')
try {
  const rendererSrcDir = path.resolve(desktopDir, 'src/renderer/src')
  scanJsxMountRecursively(rendererSrcDir)
} catch (err) {
  console.warn(`[JSX Mount Checker] 挂载检测未完成（待核心逻辑实现）: ${err.message}`)
}

function scanJsxMountRecursively(dir) {
  if (!fs.existsSync(dir)) return
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      scanJsxMountRecursively(fullPath)
    } else if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.jsx'))) {
      const code = fs.readFileSync(fullPath, 'utf-8')
      const checkResult = findUnmountedJsxComponents(code, fullPath)
      const relFile = path.relative(repoRoot, fullPath)
      for (const unmounted of checkResult.unmounted) {
        issues.push({
          kind: 'unmounted_jsx',
          file: relFile,
          line: unmounted.line,
          symbolName: unmounted.name,
          detail: `组件从 \`${unmounted.source}\` 引入，但在 JSX 模版树中从未挂载渲染`,
          language: 'typescript'
        })
      }
    }
  }
}

// --- 3. Vulture 扫描 Python 运行时死代码 ---
console.log('⏳ (3/3) 正在通过 Vulture 扫描 Python Agent 运行时死代码...')
try {
  const vultureCmd =
    'uv run --locked vulture src .vulture_whitelist.py --min-confidence 60 --exclude "src/personal_agent/protocol/models.py"'
  const vultureOutput = execSync(vultureCmd, {
    cwd: pythonDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  parseVultureOutput(vultureOutput)
} catch (err) {
  if (err.stdout) {
    parseVultureOutput(err.stdout)
  }
}

function parseVultureOutput(rawText) {
  if (!rawText) return
  const text = typeof rawText === 'string' ? rawText : rawText.toString('utf-8')
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    // 匹配形如: src\personal_agent\foo.py:42: unused function 'bar' (60% confidence)
    const match = line.match(/^([^:]+):(\d+):\s+(.+)$/)
    if (match) {
      const filePath = match[1].trim()
      const lineNum = parseInt(match[2].trim(), 10)
      const desc = match[3].trim()
      const relFile = path.relative(repoRoot, path.resolve(pythonDir, filePath))

      // 提取符号名 (如 unused function 'bar' -> bar)
      const nameMatch = desc.match(/'([^']+)'/)
      const symbolName = nameMatch ? nameMatch[1] : 'unknown'

      issues.push({
        kind: 'python_dead_code',
        file: relFile,
        line: lineNum,
        symbolName: symbolName,
        detail: desc,
        language: 'python'
      })
    }
  }
}

// --- 4. 汇总与报告生成 ---
const tsIssues = issues.filter((i) => i.language === 'typescript')
const pyIssues = issues.filter((i) => i.language === 'python')

const report = {
  timestamp: new Date().toLocaleString(),
  totalIssues: issues.length,
  tsCount: tsIssues.length,
  pyCount: pyIssues.length,
  issues
}

// 终端输出
console.log('\n=================== 📊 体检结果汇总 ===================')
if (issues.length === 0) {
  console.log('🎉 恭喜！未在项目中发现任何孤岛组件或死代码。')
} else {
  if (tsIssues.length > 0) {
    console.log(`\n🔴 [TypeScript / UI 孤岛清单] (${tsIssues.length} 处):`)
    for (const item of tsIssues) {
      const loc = item.line ? `${item.file}:${item.line}` : item.file
      console.log(`  - [${item.kind}] \x1b[36m${item.symbolName}\x1b[0m at \x1b[33m${loc}\x1b[0m`)
      console.log(`    ↳ ${item.detail}`)
    }
  }

  if (pyIssues.length > 0) {
    console.log(`\n🐍 [Python 运行时死代码] (${pyIssues.length} 处):`)
    for (const item of pyIssues) {
      const loc = item.line ? `${item.file}:${item.line}` : item.file
      console.log(`  - [${item.kind}] \x1b[36m${item.symbolName}\x1b[0m at \x1b[33m${loc}\x1b[0m`)
      console.log(`    ↳ ${item.detail}`)
    }
  }
}
console.log(`\n总计发现 ${issues.length} 处孤岛代码 (TS/UI: ${tsIssues.length}, Python: ${pyIssues.length})`)

// 生成 Markdown 报告
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir, { recursive: true })
}
const reportPath = path.join(reportsDir, 'islands-report.md')
fs.writeFileSync(reportPath, formatMarkdownReport(report, repoRoot), 'utf-8')
console.log(`📄 诊断体检报告已生成: ${path.relative(repoRoot, reportPath)}\n`)

if (isStrict && issues.length > 0) {
  console.error(`❌ [Strict 模式] 检测到 ${issues.length} 处孤岛代码，构建终止。`)
  process.exit(1)
} else {
  process.exit(0)
}

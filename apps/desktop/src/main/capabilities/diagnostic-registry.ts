import ts from 'typescript'

export interface LanguageProbeCli {
  /** 可执行程序名或命令，如 'ruff' | 'npx' | 'cargo' | 'go' | 'shellcheck' | 'clang' */
  readonly command: string
  /** 构造单文件参数 */
  readonly buildArgs: (filePath: string, workspaceRoot: string) => string[]
  /** 解析标准输出/错误，提取至多 5 条紧凑诊断 */
  readonly parseOutput: (stdout: string, stderr: string, exitCode?: number) => string[]
}

export interface LanguageProbe {
  readonly name: string
  readonly extensions: readonly string[]
  /** Tier 0: 零开销纯内存快速语法校验 (< 5ms) */
  fastSyntaxCheck?(content: string, filePath: string): string[] | null
  /** Tier 1: CLI 单文件扫描 (带超时与静默降级) */
  readonly cli?: LanguageProbeCli
}

/**
 * 格式化紧凑文本行（过滤空白并截取前 limit 条）
 */
export function compactLines(raw: string, filterKeyword?: string, limit = 5): string[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  const filtered = filterKeyword
    ? lines.filter((l) => l.toLowerCase().includes(filterKeyword.toLowerCase()))
    : lines

  return (filtered.length > 0 ? filtered : lines).slice(0, limit)
}

/**
 * 语言与文件类型即时探针注册表
 */
export const LANGUAGE_PROBES: readonly LanguageProbe[] = [
  // 1. JSON / JSONC
  {
    name: 'json',
    extensions: ['.json', '.jsonc'],
    fastSyntaxCheck(content: string) {
      if (!content || !content.trim()) return []
      try {
        JSON.parse(content)
        return []
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return [`JSON Syntax Error: ${msg}`]
      }
    }
  },

  // 2. TypeScript / JavaScript
  {
    name: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    fastSyntaxCheck(content: string, filePath: string) {
      if (!content || !content.trim()) return []
      const isJsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      )
      const diagnostics =
        (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics || []
      if (diagnostics.length === 0) return []

      return diagnostics.slice(0, 5).map((diag) => {
        const pos =
          diag.start !== undefined ? sourceFile.getLineAndCharacterOfPosition(diag.start) : null
        const lineInfo = pos ? ` (line ${pos.line + 1}, col ${pos.character + 1})` : ''
        const msg =
          typeof diag.messageText === 'string' ? diag.messageText : diag.messageText.messageText
        return `TypeScript Syntax Error${lineInfo}: ${msg}`
      })
    },
    cli: {
      command: 'npx',
      buildArgs: (filePath) => ['--no-install', 'eslint', '--format', 'compact', filePath],
      parseOutput: (stdout, stderr) => {
        const out = stdout || stderr
        return compactLines(out, 'error')
      }
    }
  },

  // 3. Python
  {
    name: 'python',
    extensions: ['.py'],
    cli: {
      command: 'ruff',
      buildArgs: (filePath) => ['check', '--output-format=concise', filePath],
      parseOutput: (stdout, stderr) => {
        const out = stdout || stderr
        return compactLines(out)
      }
    }
  },

  // 4. Rust
  {
    name: 'rust',
    extensions: ['.rs'],
    cli: {
      command: 'cargo',
      buildArgs: () => ['check', '--message-format=short'],
      parseOutput: (stdout, stderr) => {
        const out = stderr || stdout
        return compactLines(out, 'error')
      }
    }
  },

  // 5. Go
  {
    name: 'go',
    extensions: ['.go'],
    cli: {
      command: 'go',
      buildArgs: (filePath) => ['vet', filePath],
      parseOutput: (stdout, stderr) => {
        const out = stderr || stdout
        return compactLines(out)
      }
    }
  },

  // 6. Shell / Bash
  {
    name: 'shell',
    extensions: ['.sh', '.bash'],
    cli: {
      command: 'shellcheck',
      buildArgs: (filePath) => ['-f', 'gcc', filePath],
      parseOutput: (stdout, stderr) => {
        const out = stdout || stderr
        return compactLines(out)
      }
    }
  },

  // 7. C / C++
  {
    name: 'c_cpp',
    extensions: ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp'],
    cli: {
      command: 'clang',
      buildArgs: (filePath) => ['-fsyntax-only', filePath],
      parseOutput: (stdout, stderr) => {
        const out = stderr || stdout
        return compactLines(out, 'error')
      }
    }
  }
]

/**
 * 根据文件路径后缀检索匹配的语言探针
 */
export function findProbe(filePath: string): LanguageProbe | undefined {
  const dotIndex = filePath.lastIndexOf('.')
  if (dotIndex === -1) return undefined
  const ext = filePath.slice(dotIndex).toLowerCase()
  return LANGUAGE_PROBES.find((probe) => probe.extensions.includes(ext))
}

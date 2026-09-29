import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  runDiagnosticProbe,
  type ExecFileLike
} from '../../../src/main/capabilities/diagnostic-probe'
import { findProbe } from '../../../src/main/capabilities/diagnostic-registry'

type MockCallback = (error: unknown, stdout: string, stderr: string) => void

function createMockExec(handler: (callback: MockCallback) => void): ExecFileLike {
  return ((_cmd: string, _args: readonly string[], _opts: unknown, callback: MockCallback) => {
    handler(callback)
  }) as unknown as ExecFileLike
}

describe('diagnostic-probe: 诊断探针与语言注册表测试', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pa-diag-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('1. 探针注册表查找 (findProbe)', () => {
    it('正确识别各主流语言扩展名', () => {
      expect(findProbe('file.json')?.name).toBe('json')
      expect(findProbe('component.tsx')?.name).toBe('typescript')
      expect(findProbe('script.py')?.name).toBe('python')
      expect(findProbe('main.rs')?.name).toBe('rust')
      expect(findProbe('server.go')?.name).toBe('go')
      expect(findProbe('deploy.sh')?.name).toBe('shell')
      expect(findProbe('native.cpp')?.name).toBe('c_cpp')
    })

    it('未知扩展名或无扩展名返回 undefined', () => {
      expect(findProbe('notes.txt')).toBeUndefined()
      expect(findProbe('Dockerfile')).toBeUndefined()
      expect(findProbe('README')).toBeUndefined()
    })
  })

  describe('2. Tier 0: 原生纯内存快速语法校验', () => {
    it('JSON: 合法 JSON 不返回任何诊断警告', async () => {
      const file = join(tempDir, 'valid.json')
      const content = JSON.stringify({ name: 'PersonalAgent', version: 1 })
      await writeFile(file, content, 'utf8')

      const result = await runDiagnosticProbe(tempDir, file, content)
      expect(result.diagnostics).toEqual([])
    })

    it('JSON: 非法 JSON 立即返回包含行列或原因的语法错误', async () => {
      const file = join(tempDir, 'invalid.json')
      const badContent = '{\n  "name": "PersonalAgent",\n  "broken": \n}'
      await writeFile(file, badContent, 'utf8')

      const result = await runDiagnosticProbe(tempDir, file, badContent)
      expect(result.diagnostics.length).toBeGreaterThan(0)
      expect(result.diagnostics[0]).toContain('JSON Syntax Error')
    })

    it('TypeScript: 语法完全合法时返回空诊断', async () => {
      const file = join(tempDir, 'valid.ts')
      const content = 'export const add = (a: number, b: number): number => a + b;\n'
      await writeFile(file, content, 'utf8')

      const result = await runDiagnosticProbe(tempDir, file, content)
      expect(result.diagnostics).toEqual([])
    })

    it('TypeScript: 缺失表达式或语法残缺时返回快速解析诊断', async () => {
      const file = join(tempDir, 'invalid.ts')
      const badContent = 'const x: number = ;\nconst y = 2;'
      await writeFile(file, badContent, 'utf8')

      const result = await runDiagnosticProbe(tempDir, file, badContent)
      expect(result.diagnostics.length).toBeGreaterThan(0)
      expect(result.diagnostics[0]).toContain('TypeScript Syntax Error')
      expect(result.diagnostics[0]).toContain('line 1')
    })
  })

  describe('3. Tier 1: CLI 单文件探针执行与输出提纯', () => {
    it('Python: 模拟 ruff 检测到错误时提取紧凑格式诊断', async () => {
      const file = join(tempDir, 'sample.py')
      await writeFile(file, 'import os\n', 'utf8')

      const mockExec = createMockExec((callback) => {
        // ruff 发现 issue 时通常 exit code 1 并输出 issue 行
        const err = new Error('ruff exit 1') as Error & { code: number; stdout: string }
        err.code = 1
        err.stdout = 'sample.py:1:8: F401 `os` imported but unused\nFound 1 error.\n'
        callback(err, err.stdout, '')
      })

      const result = await runDiagnosticProbe(tempDir, file, 'import os\n', {
        execFileFn: mockExec
      })

      expect(result.diagnostics).toEqual([
        'sample.py:1:8: F401 `os` imported but unused',
        'Found 1 error.'
      ])
    })

    it('Rust: 模拟 cargo check 提取错误输出', async () => {
      const file = join(tempDir, 'main.rs')
      await writeFile(file, 'fn main() { let x = ; }', 'utf8')

      const mockExec = createMockExec((callback) => {
        const err = new Error('cargo check error') as Error & { code: number; stderr: string }
        err.code = 101
        err.stderr = 'error: expected expression, found `;`\n --> src/main.rs:1:21\n'
        callback(err, '', err.stderr)
      })

      const result = await runDiagnosticProbe(tempDir, file, undefined, {
        execFileFn: mockExec
      })

      expect(result.diagnostics.length).toBeGreaterThan(0)
      expect(result.diagnostics[0]).toContain('error: expected expression, found `;`')
    })

    it('Go: 模拟 go vet 提取诊断行', async () => {
      const file = join(tempDir, 'main.go')
      await writeFile(file, 'package main', 'utf8')

      const mockExec = createMockExec((callback) => {
        const err = new Error('go vet error') as Error & { stderr: string }
        err.stderr = './main.go:3:2: fmt.Printf format %s reads arg #1, but call has only 0 args\n'
        callback(err, '', err.stderr)
      })

      const result = await runDiagnosticProbe(tempDir, file, undefined, {
        execFileFn: mockExec
      })

      expect(result.diagnostics.length).toBe(1)
      expect(result.diagnostics[0]).toContain('fmt.Printf format %s')
    })

    it('Shell: 模拟 shellcheck 提取诊断行', async () => {
      const file = join(tempDir, 'run.sh')
      await writeFile(file, '#!/bin/bash\necho $foo', 'utf8')

      const mockExec = createMockExec((callback) => {
        const stdout = 'run.sh:2:6: note: foo is referenced but not assigned. [SC2154]\n'
        callback(null, stdout, '')
      })

      const result = await runDiagnosticProbe(tempDir, file, undefined, {
        execFileFn: mockExec
      })

      expect(result.diagnostics.length).toBe(1)
      expect(result.diagnostics[0]).toContain('foo is referenced but not assigned')
    })
  })

  describe('4. 边界与异常：Fail-Open 优雅降级与熔断机制', () => {
    it('工具未安装 (ENOENT) 时静默放行，返回空诊断且不抛错', async () => {
      const file = join(tempDir, 'test.py')
      await writeFile(file, 'print(1)', 'utf8')

      const mockExec = createMockExec((callback) => {
        const err = new Error('spawn ruff ENOENT') as Error & { code: string }
        err.code = 'ENOENT'
        callback(err, '', '')
      })

      const result = await runDiagnosticProbe(tempDir, file, undefined, {
        execFileFn: mockExec
      })

      expect(result.diagnostics).toEqual([])
    })

    it('探针执行超时 (ETIMEDOUT / killed) 时静默熔断，返回空诊断', async () => {
      const file = join(tempDir, 'test.py')
      await writeFile(file, 'print(1)', 'utf8')

      const mockExec = createMockExec((callback) => {
        const err = new Error('timed out') as Error & { killed: boolean; signal: string }
        err.killed = true
        err.signal = 'SIGTERM'
        callback(err, '', '')
      })

      const result = await runDiagnosticProbe(tempDir, file, undefined, {
        execFileFn: mockExec
      })

      expect(result.diagnostics).toEqual([])
    })

    it('探针未知内部异常时绝对不上浮，安全兜底返回空诊断', async () => {
      const file = join(tempDir, 'test.py')

      const mockExec = createMockExec(() => {
        throw new Error('Fatal host explosion')
      })

      const result = await runDiagnosticProbe(tempDir, file, undefined, {
        execFileFn: mockExec
      })

      expect(result.diagnostics).toEqual([])
    })

    it('未受支持的文件类型直接返回空诊断，不调任何子进程', async () => {
      const file = join(tempDir, 'data.csv')
      await writeFile(file, 'a,b,c', 'utf8')

      let called = false
      const mockExec = createMockExec((callback) => {
        called = true
        callback(null, '', '')
      })

      const result = await runDiagnosticProbe(tempDir, file, undefined, {
        execFileFn: mockExec
      })

      expect(result.diagnostics).toEqual([])
      expect(called).toBe(false)
    })
  })
})

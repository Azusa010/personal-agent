import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { writeFileAtomic } from '../../../src/main/capabilities/file-write'
import { editFileStrict } from '../../../src/main/capabilities/file-edit'
import { readFileWithLineNumbers } from '../../../src/main/capabilities/file-read'
import { ROOT_ENV } from '../../../src/main/capabilities/roots'

describe('Coding Agent E2E: 真实工作区编程、语法探针与即时自愈闭环', () => {
  let workspaceDir: string

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'pa-coding-e2e-'))
    vi.stubEnv(ROOT_ENV['workspace'], workspaceDir)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(workspaceDir, { recursive: true, force: true })
  })

  it('1. TypeScript 代码编写 -> 语法探针告警 -> 局部编辑自愈 -> 行号读取验证', async () => {
    const tsFile = join(workspaceDir, 'src', 'calculator.ts')

    // 步骤 A: 初始写入存在残缺语法的 TypeScript 代码
    const brokenCode = [
      'export function multiply(a: number, b: number): number {',
      '  return a * ;',
      '}'
    ].join('\n')

    const writeOutcome = await writeFileAtomic(tsFile, brokenCode)

    // 断言 A: 物理落盘成功，但 Tier 0 探针捕获了语法错误并返回 diagnostics
    expect(writeOutcome.ok).toBe(true)
    if (writeOutcome.ok) {
      expect(writeOutcome.path).toBe(tsFile)
      expect(writeOutcome.diagnostics).toBeDefined()
      expect(writeOutcome.diagnostics?.length).toBeGreaterThan(0)
      expect(writeOutcome.diagnostics?.[0]).toContain('TypeScript Syntax Error')
      expect(writeOutcome.diagnostics?.[0]).toContain('line 2')
    }

    // 步骤 B: 模拟模型依据返回的 diagnostics 定位到 line 2，发起精准局部自愈
    const editOutcome = await editFileStrict(tsFile, '  return a * ;', '  return a * b;')

    // 断言 B: 局部编辑成功，缺陷被消除，探针重新检验返回空诊断
    expect(editOutcome.ok).toBe(true)
    if (editOutcome.ok) {
      expect(editOutcome.replacements).toBe(1)
      expect(editOutcome.diagnostics).toBeUndefined()
    }

    // 步骤 C: 读取自愈后的代码，验证带行号的内容呈现
    const readOutcome = await readFileWithLineNumbers(tsFile)
    expect(readOutcome.ok).toBe(true)
    if (readOutcome.ok) {
      expect(readOutcome.totalLines).toBe(3)
      expect(readOutcome.content).toContain('2:   return a * b;')
    }

    // 步骤 D: 验证磁盘真实物理文件内容
    const onDiskContent = await readFile(tsFile, 'utf8')
    expect(onDiskContent).toContain('return a * b;')
  })

  it('2. JSON 配置文件编写 -> 语法解析错误告警 -> 符号闭合自愈', async () => {
    const jsonFile = join(workspaceDir, 'config', 'settings.json')

    // 步骤 A: 写入漏了闭合双引号与键值的破损 JSON
    const brokenJson = '{\n  "appName": "PersonalAgent",\n  "port": \n}'
    const writeOutcome = await writeFileAtomic(jsonFile, brokenJson)

    expect(writeOutcome.ok).toBe(true)
    if (writeOutcome.ok) {
      expect(writeOutcome.diagnostics).toBeDefined()
      expect(writeOutcome.diagnostics?.length).toBeGreaterThan(0)
      expect(writeOutcome.diagnostics?.[0]).toContain('JSON Syntax Error')
    }

    // 步骤 B: 通过 file_edit 自愈补全缺漏的键值
    const editOutcome = await editFileStrict(jsonFile, '  "port": \n', '  "port": 8080\n')

    expect(editOutcome.ok).toBe(true)
    if (editOutcome.ok) {
      expect(editOutcome.diagnostics).toBeUndefined()
    }

    // 步骤 C: 验证自愈后的文件能被合法 parse
    const fixedContent = await readFile(jsonFile, 'utf8')
    const parsed = JSON.parse(fixedContent)
    expect(parsed.appName).toBe('PersonalAgent')
    expect(parsed.port).toBe(8080)
  })

  it('3. 多模块协同编程自愈：接口定义与模块实现', async () => {
    // 步骤 A: 编写 types.ts (完全合法)
    const typesFile = join(workspaceDir, 'types.ts')
    const typesCode = 'export interface User { id: string; name: string; }\n'
    const typesRes = await writeFileAtomic(typesFile, typesCode)
    expect(typesRes.ok).toBe(true)
    if (typesRes.ok) {
      expect(typesRes.diagnostics).toBeUndefined()
    }

    // 步骤 B: 编写 service.ts (初始引入语法错误)
    const serviceFile = join(workspaceDir, 'service.ts')
    const badService = "import { User } from './types'\nconst getUser = (): User => ;\n"
    const serviceRes = await writeFileAtomic(serviceFile, badService)
    expect(serviceRes.ok).toBe(true)
    if (serviceRes.ok) {
      expect(serviceRes.diagnostics?.length).toBeGreaterThan(0)
      expect(serviceRes.diagnostics?.[0]).toContain('TypeScript Syntax Error')
    }

    // 步骤 C: 自愈修复 service.ts
    const goodService = "const getUser = (): User => ({ id: '1', name: 'Alice' });\n"
    const healRes = await editFileStrict(
      serviceFile,
      'const getUser = (): User => ;\n',
      goodService
    )
    expect(healRes.ok).toBe(true)
    if (healRes.ok) {
      expect(healRes.diagnostics).toBeUndefined()
    }
  })
})

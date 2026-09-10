import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CapabilityFailure,
  DocumentExtractPdfOutcome,
  ERROR_CODE,
  FilesystemListResult,
  HostExecuteToolResult,
  type HostExecuteToolParams
} from '@personal-agent/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createExecutor } from './executor'
import { buildCorruptPdf, buildEncryptedPdf, buildPdf } from './pdf-fixtures'
import type { AuthorizeDenialCode, ToolRetriever } from './retriever'
import { readOnlyScope } from './scope'

const ENV_NAME = 'PERSONAL_AGENT_DOWNLOADS_DIR'

let dir: string
let run: (params: HostExecuteToolParams) => Promise<Record<string, unknown>>

function params(
  capability: HostExecuteToolParams['capability'],
  args: Record<string, unknown>
): HostExecuteToolParams {
  return { callId: 'tc-9f3a', capability, arguments: args }
}

/** 拒绝一切的 retriever。用来证明 authorize 在分发之前。 */
function denyRetriever(code: AuthorizeDenialCode): ToolRetriever {
  return {
    listVisible: () => [],
    authorize: (_scope, name) => ({
      allowed: false,
      code,
      name,
      reason: `测试拒绝: ${name}`
    })
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-exec-'))
  vi.stubEnv(ENV_NAME, dir)
  run = createExecutor(readOnlyScope('task-1'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

describe('executor：authorize 是唯一关口（TEST-005）', () => {
  it('Scope 外的 WRITE 能力回 CAPABILITY_OUT_OF_SCOPE，而不是 NOT_IMPLEMENTED', async () => {
    // 四个 WRITE 能力在 registry 里都有描述符但都没有执行体。
    // 若 authorize 不在分发之前，这里会落到 default 分支返回 NOT_IMPLEMENTED。
    // 用码的区别证明顺序，比 spy 更直接。
    const out = await run(params('filesystem.move', { from: 'a', to: 'b' }))
    expect(out['code']).toBe(ERROR_CODE.CAPABILITY_OUT_OF_SCOPE)
  })

  it('readOnlyScope 放行两个 READ 能力', async () => {
    // 空目录，filesystem.list 成功返回空 entries。
    const out = await run(params('filesystem.list', { rootId: 'downloads' }))
    expect(out['ok']).toBe(true)
  })

  it('被 authorize 拒绝时执行体没有运行', async () => {
    // 根指向不存在的目录：若执行体跑了会返回 FILESYSTEM_ROOT_UNAVAILABLE。
    // 返回 CAPABILITY_OUT_OF_SCOPE 就证明 listPdfs 一次都没被调用。
    vi.stubEnv(ENV_NAME, join(dir, 'nope'))
    const denied = createExecutor(readOnlyScope('task-1'), denyRetriever('CAPABILITY_OUT_OF_SCOPE'))
    const out = await denied(params('filesystem.list', { rootId: 'downloads' }))
    expect(out['code']).toBe(ERROR_CODE.CAPABILITY_OUT_OF_SCOPE)
  })

  it('未注册能力回 CAPABILITY_NOT_REGISTERED', async () => {
    // 两个拒绝码必须分开：NOT_REGISTERED 说明模型幻觉出一个不存在的工具，
    // OUT_OF_SCOPE 说明工具存在但这个任务不许用。混成一个码之后
    // RISK-005 的"错工具"和"越权"在日志里分不开。
    const denied = createExecutor(
      readOnlyScope('task-1'),
      denyRetriever('CAPABILITY_NOT_REGISTERED')
    )
    const out = await denied(params('filesystem.list', { rootId: 'downloads' }))
    expect(out['code']).toBe(ERROR_CODE.CAPABILITY_NOT_REGISTERED)
  })
})

describe('executor：arguments 二次校验', () => {
  it('rootId 不在白名单 -> INVALID_ARGUMENT', async () => {
    // envelope 层的 arguments 是 z.record(z.string(), z.unknown())，
    // 什么都能过。收窄只能在这里做。
    const out = await run(params('filesystem.list', { rootId: 'system32' }))
    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.INVALID_ARGUMENT)
  })

  it('缺 rootId -> INVALID_ARGUMENT', async () => {
    const out = await run(params('filesystem.list', {}))
    expect(out['code']).toBe(ERROR_CODE.INVALID_ARGUMENT)
  })

  it('rootId 类型错 -> INVALID_ARGUMENT', async () => {
    const out = await run(params('filesystem.list', { rootId: 123 }))
    expect(out['code']).toBe(ERROR_CODE.INVALID_ARGUMENT)
  })

  it('path 为空 -> INVALID_ARGUMENT', async () => {
    const out = await run(params('document.extract_pdf', { path: '' }))
    expect(out['code']).toBe(ERROR_CODE.INVALID_ARGUMENT)
  })

  it('缺 path -> INVALID_ARGUMENT', async () => {
    const out = await run(params('document.extract_pdf', {}))
    expect(out['code']).toBe(ERROR_CODE.INVALID_ARGUMENT)
  })

  it('INVALID_ARGUMENT 是单数拼写', () => {
    // 钉值。写成复数 INVALID_ARGUMENTS 的话，与 errors.ts 里的键不一致，
    // TS 会在编译期报 undefined 属性，但 Python 侧 engine 的码表匹配是
    // 字符串比较，漂移只会表现为"未知错误码"。
    expect(ERROR_CODE.INVALID_ARGUMENT).toBe('INVALID_ARGUMENT')
  })
})

describe('executor：filesystem.list', () => {
  it('成功时 ok 是 boolean true', async () => {
    await writeFile(join(dir, 'a.pdf'), 'A')
    const out = await run(params('filesystem.list', { rootId: 'downloads' }))

    // toBe 是严格相等：ok 写成字符串 'true' 的话这里就红。
    // 契约里 HostExecuteToolResult 钉的是 z.boolean()。
    expect(out['ok']).toBe(true)
    expect(Array.isArray(out['entries'])).toBe(true)
  })

  it('成功输出同时过 envelope 层与 payload 层契约', async () => {
    await writeFile(join(dir, 'a.pdf'), 'A')
    const out = await run(params('filesystem.list', { rootId: 'downloads' }))

    // 两层各管一件事：HostExecuteToolResult 钉 ok 是 boolean，
    // FilesystemListResult 钉 entries 形状。只过其中一层证明不了 wire 合法
    //（z.object 会把 ok strip 掉）。
    expect(() => HostExecuteToolResult.parse(out)).not.toThrow()
    expect(() => FilesystemListResult.parse(out)).not.toThrow()
  })

  it('根目录不存在 -> FILESYSTEM_ROOT_UNAVAILABLE', async () => {
    vi.stubEnv(ENV_NAME, join(dir, 'nope'))
    const out = await run(params('filesystem.list', { rootId: 'downloads' }))
    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.FILESYSTEM_ROOT_UNAVAILABLE)
    // reason 里要带原始 errno，否则"目录不存在"和"没权限"分不开。
    expect(String(out['reason'])).toContain('ENOENT')
  })

  it('根是文件而不是目录 -> FILESYSTEM_ROOT_UNAVAILABLE', async () => {
    const filePath = join(dir, 'not-a-dir')
    await writeFile(filePath, 'x')
    vi.stubEnv(ENV_NAME, filePath)
    const out = await run(params('filesystem.list', { rootId: 'downloads' }))
    expect(out['code']).toBe(ERROR_CODE.FILESYSTEM_ROOT_UNAVAILABLE)
    expect(String(out['reason'])).toContain('ENOTDIR')
  })

  it('失败输出过 CapabilityFailure 契约', async () => {
    vi.stubEnv(ENV_NAME, join(dir, 'nope'))
    const out = await run(params('filesystem.list', { rootId: 'downloads' }))
    expect(() => CapabilityFailure.parse(out)).not.toThrow()
  })
})

describe('executor：document.extract_pdf', () => {
  it('真 PDF 返回 pages 且过判别联合契约', async () => {
    const pdfPath = join(dir, 'report.pdf')
    await writeFile(pdfPath, buildPdf(['page one text', 'page two text']))

    const out = await run(params('document.extract_pdf', { path: pdfPath }))
    expect(out['ok']).toBe(true)
    expect(() => DocumentExtractPdfOutcome.parse(out)).not.toThrow()

    const parsed = DocumentExtractPdfOutcome.parse(out)
    if (parsed.ok) {
      expect(parsed.pages).toHaveLength(2)
      expect(parsed.pages[0]).toEqual({ pageNumber: 1, text: 'page one text' })
    } else {
      throw new Error('期望成功分支')
    }
  })

  it('根外绝对路径 -> PATH_OUT_OF_ROOT', async () => {
    const outside = join(tmpdir(), 'pa-outside-secret.pdf')
    await writeFile(outside, buildPdf(['secret']))
    try {
      const out = await run(params('document.extract_pdf', { path: outside }))
      expect(out['ok']).toBe(false)
      expect(out['code']).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
    } finally {
      await rm(outside, { force: true })
    }
  })

  it('.. 逃逸 -> PATH_OUT_OF_ROOT', async () => {
    // 模型给出的路径不可信（SEC-006）。resolve 会吃掉 '..'，
    // 所以先 resolve 再前缀比较才挡得住。
    const out = await run(
      params('document.extract_pdf', { path: join(dir, '..', '..', 'secret.pdf') })
    )
    expect(out['code']).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
  })

  it('同名前缀的兄弟目录 -> PATH_OUT_OF_ROOT', async () => {
    // 不补分隔符时 startsWith 会误判通过（实测 'D:/pa-root-evil/x'
    // .startsWith('D:/pa-root') === true）。
    const evilDir = `${dir}-evil`
    await mkdir(evilDir, { recursive: true })
    await writeFile(join(evilDir, 'x.pdf'), buildPdf(['x']))
    try {
      const out = await run(params('document.extract_pdf', { path: join(evilDir, 'x.pdf') }))
      expect(out['code']).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
    } finally {
      await rm(evilDir, { recursive: true, force: true })
    }
  })

  it('根内不存在的文件 -> FILE_UNREADABLE', async () => {
    const out = await run(params('document.extract_pdf', { path: join(dir, 'ghost.pdf') }))
    expect(out['ok']).toBe(false)
    expect(out['code']).toBe(ERROR_CODE.FILE_UNREADABLE)
    expect(String(out['reason'])).toContain('ENOENT')
  })

  it('拿根目录当文件 -> FILE_UNREADABLE', async () => {
    // path-guard 放行 candidate === root（不算越界），
    // readFile 抛 EISDIR，必须被接住而不是冒泡成 HOST_HANDLER_FAILED。
    const out = await run(params('document.extract_pdf', { path: dir }))
    expect(out['code']).toBe(ERROR_CODE.FILE_UNREADABLE)
    expect(String(out['reason'])).toContain('EISDIR')
  })

  it('PDF 业务失败原样透传，不改码', async () => {
    // extractPdf 自己返回 PDF_EMPTY / PDF_CORRUPT / PDF_ENCRYPTED /
    // PDF_NO_TEXT。executor 不能把它们改写成别的码，否则
    // document-extract-pdf.test.ts 钉的稳定码在这一层就丢了。
    const cases: { name: string; bytes: Uint8Array; code: string }[] = [
      { name: 'empty.pdf', bytes: new Uint8Array(0), code: 'PDF_EMPTY' },
      { name: 'corrupt.pdf', bytes: buildCorruptPdf(), code: 'PDF_CORRUPT' },
      { name: 'encrypted.pdf', bytes: buildEncryptedPdf(), code: 'PDF_ENCRYPTED' }
    ]
    for (const c of cases) {
      const full = join(dir, c.name)
      await writeFile(full, c.bytes)
      const out = await run(params('document.extract_pdf', { path: full }))
      expect(out['ok'], c.name).toBe(false)
      expect(out['code'], c.name).toBe(c.code)
      expect(() => CapabilityFailure.parse(out), c.name).not.toThrow()
    }
  })
})

describe('executor：永不 throw', () => {
  it('所有失败输入都返回 ok:false，没有一条冒泡成异常', async () => {
    // 冒泡的话 supervisor 的 catch 会把 code 写死成 HOST_HANDLER_FAILED，
    // 精确码全丢。这里直接 await：抛了测试就红。
    vi.stubEnv(ENV_NAME, join(dir, 'nope'))
    const inputs: HostExecuteToolParams[] = [
      params('filesystem.list', { rootId: 'downloads' }),
      params('filesystem.list', { rootId: 'nope' }),
      params('filesystem.list', {}),
      params('document.extract_pdf', { path: '' }),
      params('document.extract_pdf', { path: 'C:/Windows/win.ini' }),
      params('document.extract_pdf', { path: join(dir, 'ghost.pdf') }),
      params('filesystem.move', { from: 'a', to: 'b' }),
      params('scheduler.create', {}),
      params('notification.send', {})
    ]
    for (const input of inputs) {
      const out = await run(input)
      expect(out['ok'], input.capability).toBe(false)
      expect(typeof out['code'], input.capability).toBe('string')
      expect(() => CapabilityFailure.parse(out), input.capability).not.toThrow()
    }
  })

  it('未实现的能力回 NOT_IMPLEMENTED', async () => {
    // 只有 scope 放行了却没有执行体时才走到这里。用假 retriever 放行一切。
    const allowAll: ToolRetriever = {
      listVisible: () => [],
      authorize: (_scope, name) => ({
        allowed: true,
        capability: { name, kind: 'WRITE', description: 'test' }
      })
    }
    const permissive = createExecutor(readOnlyScope('task-1'), allowAll)
    const out = await permissive(params('scheduler.create', {}))
    expect(out['code']).toBe(ERROR_CODE.NOT_IMPLEMENTED)
  })
})

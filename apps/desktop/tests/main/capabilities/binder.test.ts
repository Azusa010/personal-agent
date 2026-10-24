import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ERROR_CODE } from '@personal-agent/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineBinder } from '../../../src/main/capabilities/binder'
import { toPosix } from '../../../src/main/capabilities/roots'

let workspaceDir: string
let realWorkspaceRoot: string

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'pa-binder-ws-'))
  realWorkspaceRoot = toPosix(await realpath(workspaceDir))

  vi.stubEnv('PERSONAL_AGENT_WORKSPACE_DIR', workspaceDir)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(workspaceDir, { recursive: true, force: true })
})

describe('defineBinder：无路径参数能力绑定', () => {
  const Schema = z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().optional().default(10)
  })

  const binder = defineBinder('test_search', Schema)

  it('合法参数正常绑定并剥离多余字段，paths 为空', async () => {
    const res = await binder({ query: 'hello', limit: 5, extraNoise: 'ignore me' })
    expect(res).toEqual({
      ok: true,
      bound: {
        args: { query: 'hello', limit: 5 },
        paths: {}
      }
    })
  })

  it('使用 Schema 默认值', async () => {
    const res = await binder({ query: 'only_query' })
    expect(res).toEqual({
      ok: true,
      bound: {
        args: { query: 'only_query', limit: 10 },
        paths: {}
      }
    })
  })

  it('参数契约不满足时返回 INVALID_ARGUMENT 且说明能力名与原因', async () => {
    const res = await binder({ query: '' })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe(ERROR_CODE.INVALID_ARGUMENT)
      expect(res.reason).toContain('test_search')
      expect(res.reason).toContain('参数不符合契约')
    }
  })
})

describe('defineBinder：单必填路径参数能力绑定', () => {
  const Schema = z.object({
    path: z.string().min(1)
  })

  const binder = defineBinder('file_read', Schema, [{ field: 'path', root: 'workspace' }])

  it('根内合法相对/绝对路径规范化并绑定进 bound.paths.path', async () => {
    const file = join(workspaceDir, 'notes.txt')
    await writeFile(file, 'sample')

    const res = await binder({ path: 'notes.txt' })
    expect(res).toEqual({
      ok: true,
      bound: {
        args: { path: 'notes.txt' },
        paths: { path: `${realWorkspaceRoot}/notes.txt` }
      }
    })
  })

  it('父级目录 .. 越界被 Path-Guard 拦截为 PATH_OUT_OF_ROOT', async () => {
    const res = await binder({ path: '../outside.txt' })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('PATH_OUT_OF_ROOT')
    }
  })

  it('Windows 保留设备名 (如 con.txt) 被拦截为 PATH_DEVICE_NAME_FORBIDDEN', async () => {
    const res = await binder({ path: 'con.txt' })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('PATH_DEVICE_NAME_FORBIDDEN')
    }
  })

  it('Symlink 穿透授权根被拦截为 PATH_ESCAPES_ROOT_VIA_LINK', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pa-binder-out-'))
    try {
      await writeFile(join(outside, 'secret.pdf'), 'secret')
      await symlink(outside, join(workspaceDir, 'link_out'), 'junction')

      const res = await binder({ path: 'link_out/secret.pdf' })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.code).toBe('PATH_ESCAPES_ROOT_VIA_LINK')
      }
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('defineBinder：可选路径参数与自定义别名 destKey', () => {
  const Schema = z.object({
    pattern: z.string(),
    relativeRoot: z.string().optional()
  })

  const binder = defineBinder('file_search', Schema, [
    {
      field: 'relativeRoot',
      root: 'workspace',
      optional: true,
      destKey: 'searchDir'
    }
  ])

  it('当可选路径未传入时放行，paths 中不包含该键', async () => {
    const res = await binder({ pattern: '*.pdf' })
    expect(res).toEqual({
      ok: true,
      bound: {
        args: { pattern: '*.pdf' },
        paths: {}
      }
    })
  })

  it('当可选路径合法传入时，绑定到 destKey 指定的名称', async () => {
    const res = await binder({ pattern: '*.pdf', relativeRoot: 'invoices' })
    expect(res).toEqual({
      ok: true,
      bound: {
        args: { pattern: '*.pdf', relativeRoot: 'invoices' },
        paths: { searchDir: `${realWorkspaceRoot}/invoices` }
      }
    })
  })

  it('当可选路径传入越界值时，依然触发 Path-Guard 拦截', async () => {
    const res = await binder({ pattern: '*.pdf', relativeRoot: '../../windows' })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('PATH_OUT_OF_ROOT')
    }
  })
})

describe('defineBinder：动态根函数 (Dynamic Root)', () => {
  const Schema = z.object({
    rootId: z.enum(['workspace']),
    path: z.string().optional()
  })

  const binder = defineBinder('filesystem_list', Schema, [
    {
      field: 'path',
      root: (args) => String(args.rootId),
      optional: true,
      destKey: 'targetDir'
    }
  ])

  it('根据 rootId="workspace" 动态绑定到 workspace 根', async () => {
    const res = await binder({ rootId: 'workspace', path: 'src/main.ts' })
    expect(res).toEqual({
      ok: true,
      bound: {
        args: { rootId: 'workspace', path: 'src/main.ts' },
        paths: { targetDir: `${realWorkspaceRoot}/src/main.ts` }
      }
    })
  })
})

describe('defineBinder：多路径参数能力绑定 (如 filesystem_move)', () => {
  const Schema = z.object({
    sourcePath: z.string().min(1),
    destinationPath: z.string().min(1)
  })

  const binder = defineBinder('filesystem_move', Schema, [
    { field: 'sourcePath', root: 'workspace' },
    { field: 'destinationPath', root: 'workspace' }
  ])

  it('两个合法路径同时校验成功并写入 bound.paths', async () => {
    const res = await binder({
      sourcePath: 'a.pdf',
      destinationPath: 'archive/a.pdf'
    })
    expect(res).toEqual({
      ok: true,
      bound: {
        args: { sourcePath: 'a.pdf', destinationPath: 'archive/a.pdf' },
        paths: {
          sourcePath: `${realWorkspaceRoot}/a.pdf`,
          destinationPath: `${realWorkspaceRoot}/archive/a.pdf`
        }
      }
    })
  })

  it('任一路径越界则整体验证失败', async () => {
    const res = await binder({
      sourcePath: 'a.pdf',
      destinationPath: '../outside/a.pdf'
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('PATH_OUT_OF_ROOT')
    }
  })
})

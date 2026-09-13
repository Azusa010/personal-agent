import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ERROR_CODE } from '@personal-agent/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { toPosix } from '../capabilities/roots'
import { bindArguments } from './argument-binders'

const ENV_NAME = 'PERSONAL_AGENT_DOWNLOADS_DIR'

let dir: string
let realRoot: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-bind-'))
  realRoot = toPosix(await realpath(dir))
  vi.stubEnv(ENV_NAME, dir)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(dir, { recursive: true, force: true })
})

describe('bindArguments：filesystem.list', () => {
  it('合法 rootId -> args 原样带过，paths 为空', async () => {
    // rootId 是白名单枚举里的一项，不是用户给的路径，所以不该出现在 paths 里：
    // paths 的每个值都会被 TASK-018 拿去算 Canonical Arguments Hash，
    // 混一个非路径进去，hash 的含义就不清了。
    const out = await bindArguments('filesystem.list', { rootId: 'downloads' })

    expect(out).toEqual({
      ok: true,
      bound: { args: { rootId: 'downloads' }, paths: {} }
    })
  })

  it('rootId 不在白名单 -> INVALID_ARGUMENT', async () => {
    const out = await bindArguments('filesystem.list', { rootId: 'system32' })

    expect(out.ok).toBe(false)
    expect(!out.ok && out.code).toBe(ERROR_CODE.INVALID_ARGUMENT)
  })

  it('缺 rootId / 类型错 -> INVALID_ARGUMENT', async () => {
    for (const args of [{}, { rootId: 123 }, { rootId: null }]) {
      const out = await bindArguments('filesystem.list', args)
      expect(out.ok, JSON.stringify(args)).toBe(false)
      expect(!out.ok && out.code, JSON.stringify(args)).toBe(ERROR_CODE.INVALID_ARGUMENT)
    }
  })

  it('多余字段被剥掉：绑出来的 args 只有契约里的键', async () => {
    // z.object 默认 strip。留着多余字段的话，TASK-018 的 hash 会跟着模型
    // 塞进来的垃圾一起变，同一个操作两次批准算出两个 hash。
    const out = await bindArguments('filesystem.list', { rootId: 'downloads', rmrf: '/' })

    expect(out.ok && out.bound.args).toEqual({ rootId: 'downloads' })
  })

  it('reason 里点名是哪个能力的参数不对', async () => {
    const out = await bindArguments('filesystem.list', { rootId: 'system32' })

    expect(!out.ok && out.reason).toContain('filesystem.list')
  })
})

describe('bindArguments：document.extract_pdf', () => {
  it('根内真实文件 -> paths.path 是 realpath 后的绝对路径', async () => {
    await writeFile(join(dir, 'a.pdf'), 'A')

    const out = await bindArguments('document.extract_pdf', { path: join(dir, 'a.pdf') })

    expect(out).toEqual({
      ok: true,
      bound: { args: { path: join(dir, 'a.pdf') }, paths: { path: `${realRoot}/a.pdf` } }
    })
  })

  it('args 保留模型给的原始 path，paths 放规范化后的真身', async () => {
    // 两个都要：原始值是审计线索（模型到底说了什么），
    // 真身是执行与 hash 的依据。只留一个都会在出事时缺一半证据。
    const inner = join(dir, 'inner')
    await mkdir(inner)
    await writeFile(join(inner, 'a.pdf'), 'A')
    // junction 指向子目录而不是 dir 自己：自指的链接遇上递归删除，
    // 一旦哪个环节跟着链接走，删的就是真身。
    await symlink(inner, join(dir, 'alias'), 'junction')
    const viaAlias = join(dir, 'alias', 'a.pdf')

    const out = await bindArguments('document.extract_pdf', { path: viaAlias })

    expect(out.ok && out.bound.args['path']).toBe(viaAlias)
    expect(out.ok && out.bound.paths['path']).toBe(`${realRoot}/inner/a.pdf`)
  })

  it('根外绝对路径 -> PATH_OUT_OF_ROOT', async () => {
    const out = await bindArguments('document.extract_pdf', { path: 'C:/Windows/win.ini' })

    expect(out.ok).toBe(false)
    expect(!out.ok && out.code).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
  })

  it('.. 逃逸 -> PATH_OUT_OF_ROOT', async () => {
    const out = await bindArguments('document.extract_pdf', {
      path: join(dir, '..', '..', 'secret.pdf')
    })

    expect(!out.ok && out.code).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
  })

  it('根内 junction 指向根外 -> PATH_ESCAPES_ROOT_VIA_LINK', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pa-bind-outside-'))
    try {
      await writeFile(join(outside, 'secret.pdf'), 'S')
      await symlink(outside, join(dir, 'escape'), 'junction')

      const out = await bindArguments('document.extract_pdf', {
        path: join(dir, 'escape', 'secret.pdf')
      })

      expect(!out.ok && out.code).toBe(ERROR_CODE.PATH_ESCAPES_ROOT_VIA_LINK)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('UNC -> PATH_UNC_NOT_ALLOWED', async () => {
    const out = await bindArguments('document.extract_pdf', {
      path: '\\\\evil-server\\share\\x.pdf'
    })

    expect(!out.ok && out.code).toBe(ERROR_CODE.PATH_UNC_NOT_ALLOWED)
  })

  it('空 path / 缺 path -> INVALID_ARGUMENT', async () => {
    for (const args of [{ path: '' }, {}]) {
      const out = await bindArguments('document.extract_pdf', args)
      expect(out.ok, JSON.stringify(args)).toBe(false)
      expect(!out.ok && out.code, JSON.stringify(args)).toBe(ERROR_CODE.INVALID_ARGUMENT)
    }
  })

  it('根内不存在的目标仍然绑定成功', async () => {
    // 「不存在」不等于「越界」。这里拒了的话，下游 readFile 的 FILE_UNREADABLE
    // 就永远出不来，UI 上只会看到一句莫名其妙的路径错误。
    const out = await bindArguments('document.extract_pdf', { path: join(dir, 'ghost.pdf') })

    expect(out).toEqual({
      ok: true,
      bound: { args: { path: join(dir, 'ghost.pdf') }, paths: { path: `${realRoot}/ghost.pdf` } }
    })
  })

  it('授权根跟着环境变量走，不是写死的', async () => {
    // 绑定的根必须与执行体 resolveRoot 拿到的是同一个值，
    // 否则「校验时用的根」与「读取时用的根」会分叉。
    const other = await mkdtemp(join(tmpdir(), 'pa-bind-other-'))
    try {
      vi.stubEnv(ENV_NAME, other)
      const out = await bindArguments('document.extract_pdf', { path: join(dir, 'a.pdf') })

      expect(!out.ok && out.code).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('授权根不存在 -> PATH_OUT_OF_ROOT，而不是绑定成功', async () => {
    vi.stubEnv(ENV_NAME, join(dir, 'nope'))

    const out = await bindArguments('document.extract_pdf', {
      path: join(dir, 'nope', 'a.pdf')
    })

    expect(out.ok).toBe(false)
    expect(!out.ok && out.code).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
  })
})

describe('bindArguments：没有绑定器的能力', () => {
  it('registry 里有、执行体没有 -> NOT_IMPLEMENTED', async () => {
    // 与 INVALID_ARGUMENT 分开：前者是「我们还没写」，后者是「你说错了」。
    // 混成一个码之后，TASK-020 落地前 UI 上会把缺功能显示成参数错误。
    for (const name of ['filesystem.create_dir', 'filesystem.move', 'scheduler.create']) {
      const out = await bindArguments(name, {})
      expect(out.ok, name).toBe(false)
      expect(!out.ok && out.code, name).toBe(ERROR_CODE.NOT_IMPLEMENTED)
      expect(!out.ok && out.reason, name).toContain(name)
    }
  })

  it('幻觉出来的名字也是 NOT_IMPLEMENTED', async () => {
    // 生产路径上这种名字在策略第①关就被 CAPABILITY_NOT_REGISTERED 拦掉了，
    // 走不到这里。留这条只是钉住：绑定器自己不猜、不兜、不抛。
    const out = await bindArguments('nope.nope', {})

    expect(!out.ok && out.code).toBe(ERROR_CODE.NOT_IMPLEMENTED)
  })

  it('任何输入都不抛异常', async () => {
    // 抛出去的话 supervisor 会把 code 写死成 HOST_HANDLER_FAILED，精确码全丢。
    await mkdir(join(dir, 'sub'), { recursive: true })
    const inputs: [string, Record<string, unknown>][] = [
      ['filesystem.list', { rootId: 'downloads' }],
      ['filesystem.list', { rootId: 'nope' }],
      ['document.extract_pdf', { path: dir }],
      ['document.extract_pdf', { path: join(dir, 'sub') }],
      ['document.extract_pdf', { path: join(dir, 'ghost.pdf') }],
      ['filesystem.move', { from: 'a', to: 'b' }],
      ['nope.nope', {}]
    ]

    for (const [name, args] of inputs) {
      const out = await bindArguments(name, args)
      expect(typeof out.ok, name).toBe('boolean')
      if (!out.ok) expect(typeof out.code, name).toBe('string')
    }
  })
})

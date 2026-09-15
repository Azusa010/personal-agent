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

describe('bindArguments：filesystem.create_dir', () => {
  it('根内还不存在的目录 -> 绑定成功，paths.path 是规范化后的绝对路径', async () => {
    // 要建的目录当然还不存在，guard 必须能处理这种输入，
    // 否则 create_dir 永远绑不成功。
    const out = await bindArguments('filesystem.create_dir', { path: join(dir, 'Reading') })

    expect(out).toEqual({
      ok: true,
      bound: { args: { path: join(dir, 'Reading') }, paths: { path: `${realRoot}/Reading` } }
    })
  })

  it('多层不存在的目录也过：guard 只管边界，不管深度', async () => {
    const out = await bindArguments('filesystem.create_dir', { path: join(dir, 'a', 'b', 'c') })

    expect(out.ok && out.bound.paths['path']).toBe(`${realRoot}/a/b/c`)
  })

  it('根内已存在的目录也绑定成功：是否已存在归执行体判', async () => {
    await mkdir(join(dir, 'exists'))

    const out = await bindArguments('filesystem.create_dir', { path: join(dir, 'exists') })

    expect(out.ok && out.bound.paths['path']).toBe(`${realRoot}/exists`)
  })

  it('根外 -> PATH_OUT_OF_ROOT', async () => {
    const out = await bindArguments('filesystem.create_dir', { path: 'C:/Windows/Temp/evil' })

    expect(out.ok).toBe(false)
    expect(!out.ok && out.code).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
  })

  it('.. 逃逸 -> PATH_OUT_OF_ROOT', async () => {
    const out = await bindArguments('filesystem.create_dir', { path: join(dir, '..', 'escaped') })

    expect(!out.ok && out.code).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
  })

  it('根内 junction 指向根外 -> PATH_ESCAPES_ROOT_VIA_LINK', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pa-bind-cd-outside-'))
    try {
      await symlink(outside, join(dir, 'escape'), 'junction')

      const out = await bindArguments('filesystem.create_dir', {
        path: join(dir, 'escape', 'sub')
      })

      expect(!out.ok && out.code).toBe(ERROR_CODE.PATH_ESCAPES_ROOT_VIA_LINK)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('空 path / 缺 path / 类型错 -> INVALID_ARGUMENT', async () => {
    for (const args of [{ path: '' }, {}, { path: 123 }]) {
      const out = await bindArguments('filesystem.create_dir', args)
      expect(out.ok, JSON.stringify(args)).toBe(false)
      expect(!out.ok && out.code, JSON.stringify(args)).toBe(ERROR_CODE.INVALID_ARGUMENT)
    }
  })

  it('多余字段被剔掉：绑出来的 args 只有 path', async () => {
    // Permission 的 hash 基于这个 args 算。混进模型塞的垃圾，
    // 同一个操作两次批准会算出两个 hash。
    const out = await bindArguments('filesystem.create_dir', {
      path: join(dir, 'Reading'),
      recursive: true,
      mode: 511
    })

    expect(out.ok && out.bound.args).toEqual({ path: join(dir, 'Reading') })
  })
})

describe('bindArguments：filesystem.move', () => {
  it('根内真实文件 -> 根内不存在的目标：两个路径都规范化', async () => {
    await writeFile(join(dir, 'a.pdf'), 'A')

    const out = await bindArguments('filesystem.move', {
      source: join(dir, 'a.pdf'),
      target: join(dir, 'Reading', 'a.pdf')
    })

    expect(out).toEqual({
      ok: true,
      bound: {
        args: { source: join(dir, 'a.pdf'), target: join(dir, 'Reading', 'a.pdf') },
        paths: { source: `${realRoot}/a.pdf`, target: `${realRoot}/Reading/a.pdf` }
      }
    })
  })

  it('source 越界 -> PATH_OUT_OF_ROOT，reason 点名 source', async () => {
    const out = await bindArguments('filesystem.move', {
      source: 'C:/Windows/win.ini',
      target: join(dir, 'a.pdf')
    })

    expect(!out.ok && out.code).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
    expect(!out.ok && out.reason).toContain('source 参数')
  })

  it('target 越界 -> PATH_OUT_OF_ROOT，reason 点名 target', async () => {
    // 只校验 source 的话，这一条就是「从合法位置搬到根外」，正是要拦的。
    await writeFile(join(dir, 'a.pdf'), 'A')

    const out = await bindArguments('filesystem.move', {
      source: join(dir, 'a.pdf'),
      target: 'C:/Windows/Temp/a.pdf'
    })

    expect(!out.ok && out.code).toBe(ERROR_CODE.PATH_OUT_OF_ROOT)
    expect(!out.ok && out.reason).toContain('target 参数')
  })

  it('source 经 junction 逃出根 -> PATH_ESCAPES_ROOT_VIA_LINK', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'pa-bind-mv-src-'))
    try {
      await writeFile(join(outside, 'secret.pdf'), 'S')
      await symlink(outside, join(dir, 'escape'), 'junction')

      const out = await bindArguments('filesystem.move', {
        source: join(dir, 'escape', 'secret.pdf'),
        target: join(dir, 'moved.pdf')
      })

      expect(!out.ok && out.code).toBe(ERROR_CODE.PATH_ESCAPES_ROOT_VIA_LINK)
      expect(!out.ok && out.reason).toContain('source 参数')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('target 经 junction 逃出根 -> PATH_ESCAPES_ROOT_VIA_LINK', async () => {
    // 写入侧的逃逸比读取侧严重：它会把文件落在根外，而且落完就不在授权范围内了。
    const outside = await mkdtemp(join(tmpdir(), 'pa-bind-mv-dst-'))
    try {
      await writeFile(join(dir, 'a.pdf'), 'A')
      await symlink(outside, join(dir, 'escape'), 'junction')

      const out = await bindArguments('filesystem.move', {
        source: join(dir, 'a.pdf'),
        target: join(dir, 'escape', 'a.pdf')
      })

      expect(!out.ok && out.code).toBe(ERROR_CODE.PATH_ESCAPES_ROOT_VIA_LINK)
      expect(!out.ok && out.reason).toContain('target 参数')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('target 是 UNC -> PATH_UNC_NOT_ALLOWED', async () => {
    const out = await bindArguments('filesystem.move', {
      source: join(dir, 'a.pdf'),
      target: '\\\\evil-server\\share\\a.pdf'
    })

    expect(!out.ok && out.code).toBe(ERROR_CODE.PATH_UNC_NOT_ALLOWED)
  })

  it('缺 target / 空 source / 用旧字段名 from-to -> INVALID_ARGUMENT', async () => {
    for (const args of [
      { source: join(dir, 'a.pdf') },
      { source: '', target: join(dir, 'b.pdf') },
      { from: join(dir, 'a.pdf'), to: join(dir, 'b.pdf') }
    ]) {
      const out = await bindArguments('filesystem.move', args)
      expect(out.ok, JSON.stringify(args)).toBe(false)
      expect(!out.ok && out.code, JSON.stringify(args)).toBe(ERROR_CODE.INVALID_ARGUMENT)
    }
  })

  it('source === target 不拦：无效操作不是越权，归执行体判', async () => {
    await writeFile(join(dir, 'a.pdf'), 'A')
    const same = join(dir, 'a.pdf')

    const out = await bindArguments('filesystem.move', { source: same, target: same })

    expect(out.ok).toBe(true)
  })

  it('多余字段被剔掉：绑出来的 args 只有 source 与 target', async () => {
    const out = await bindArguments('filesystem.move', {
      source: join(dir, 'a.pdf'),
      target: join(dir, 'b.pdf'),
      overwrite: true
    })

    expect(out.ok && out.bound.args).toEqual({
      source: join(dir, 'a.pdf'),
      target: join(dir, 'b.pdf')
    })
  })
})

describe('bindArguments：scheduler.create', () => {
  const FUTURE = '2099-01-01T00:00:00.000Z'

  it('合法 ISO 时间 -> remindAt 规范化成 UTC 毫秒串，paths 为空', async () => {
    const out = await bindArguments('scheduler.create', { remindAt: FUTURE, message: '该读书了' })

    expect(out).toEqual({
      ok: true,
      bound: { args: { remindAt: FUTURE, message: '该读书了' }, paths: {} }
    })
  })

  it('带时区偏移的时间被归一到 UTC：批准面板与落库是同一个串', async () => {
    // 「今晚八点」在东八区解析出来是 +08:00 结尾。规范化前两种写法 hash 不同，
    // 规范化后是同一个时刻同一个串——用户确认的就是落库的。
    const out = await bindArguments('scheduler.create', {
      remindAt: '2099-01-01T20:00:00+08:00',
      message: '该读书了'
    })

    expect(out.ok && out.bound.args['remindAt']).toBe('2099-01-01T12:00:00.000Z')
  })

  it('无法解析的时间 -> INVALID_ARGUMENT，reason 带上原值', async () => {
    // 契约层（SchedulerCreateParams）只钉非空字符串，「今晚八点」这种没解析成
    // 具体时间的字面值在这里被拦：模型跳过了它该做的那步解析。
    const out = await bindArguments('scheduler.create', { remindAt: '今晚八点', message: 'x' })

    expect(!out.ok && out.code).toBe(ERROR_CODE.INVALID_ARGUMENT)
    expect(!out.ok && out.reason).toContain('今晚八点')
  })

  it('过去的时刻 -> REMINDER_TIME_IN_PAST', async () => {
    const out = await bindArguments('scheduler.create', {
      remindAt: '1999-01-01T00:00:00.000Z',
      message: 'x'
    })

    expect(!out.ok && out.code).toBe(ERROR_CODE.REMINDER_TIME_IN_PAST)
  })

  it('恰好等于当前时刻也拒：一次性提醒必须在未来', async () => {
    const nowIso = new Date().toISOString()
    const out = await bindArguments('scheduler.create', { remindAt: nowIso, message: 'x' })

    expect(!out.ok && out.code).toBe(ERROR_CODE.REMINDER_TIME_IN_PAST)
  })

  it('缺字段 / 空串 / 类型错 -> INVALID_ARGUMENT', async () => {
    for (const args of [
      {},
      { remindAt: FUTURE },
      { message: 'x' },
      { remindAt: '', message: 'x' },
      { remindAt: FUTURE, message: '' },
      { remindAt: 123, message: 'x' }
    ]) {
      const out = await bindArguments('scheduler.create', args)
      expect(out.ok, JSON.stringify(args)).toBe(false)
      expect(!out.ok && out.code, JSON.stringify(args)).toBe(ERROR_CODE.INVALID_ARGUMENT)
    }
  })

  it('多余字段被剥掉：hash 不跟着模型塞进来的垃圾变', async () => {
    const out = await bindArguments('scheduler.create', {
      remindAt: FUTURE,
      message: 'x',
      repeat: 'daily'
    })

    expect(out.ok && out.bound.args).toEqual({ remindAt: FUTURE, message: 'x' })
  })
})

describe('bindArguments：没有绑定器的能力', () => {
  it('registry 里有、执行体没有 -> NOT_IMPLEMENTED', async () => {
    // 与 INVALID_ARGUMENT 分开：前者是「我们还没写」，后者是「你说错了」。
    // 混成一个码之后，TASK-020 落地前 UI 上会把缺功能显示成参数错误。
    // scheduler.create 在 TASK-023 有了绑定器，这里只剩 notification.send（TASK-024）。
    for (const name of ['notification.send']) {
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
      ['filesystem.create_dir', { path: '' }],
      ['filesystem.create_dir', { path: join(dir, 'sub', 'deep') }],
      ['filesystem.move', { source: 'a', target: 'b' }],
      ['filesystem.move', { from: 'a', to: 'b' }],
      ['scheduler.create', { remindAt: '今晚八点', message: 'x' }],
      ['scheduler.create', { remindAt: '1999-01-01T00:00:00.000Z', message: 'x' }],
      ['nope.nope', {}]
    ]

    for (const [name, args] of inputs) {
      const out = await bindArguments(name, args)
      expect(typeof out.ok, name).toBe('boolean')
      if (!out.ok) expect(typeof out.code, name).toBe('string')
    }
  })
})

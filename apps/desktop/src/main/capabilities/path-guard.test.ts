import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveWithinRoot, resolveWithinRootReal, splitExisting } from './path-guard'
import { toPosix } from './roots'

// 纯字符串运算，不要求路径真实存在。用 D: 下的假路径是因为项目目标
// 平台是 Windows（TEST-015），而这些用例钉的正是 Windows 特有的语义：
// 反斜杠、大小写不敏感、盘符。
const ROOT = 'D:/pa-root'

describe('resolveWithinRoot：放行', () => {
  it('根内文件返回正斜杠绝对路径', () => {
    expect(resolveWithinRoot(ROOT, 'D:/pa-root/a.pdf')).toBe('D:/pa-root/a.pdf')
  })

  it('深层嵌套放行', () => {
    expect(resolveWithinRoot(ROOT, 'D:/pa-root/sub/deep/a.pdf')).toBe('D:/pa-root/sub/deep/a.pdf')
  })

  it('反斜杠 candidate 被转正', () => {
    expect(resolveWithinRoot(ROOT, 'D:\\pa-root\\a.pdf')).toBe('D:/pa-root/a.pdf')
  })

  it('根写成反斜杠也能匹配', () => {
    expect(resolveWithinRoot('D:\\pa-root', 'D:/pa-root/a.pdf')).toBe('D:/pa-root/a.pdf')
  })

  it('根带尾斜杠时不会拼成双斜杠而全部拒掉', () => {
    // resolve 会吃掉尾斜杠。不吃的话 base + '/' 变成 'D:/pa-root//'，
    // 任何 candidate 都匹配不上，表现为"所有 PDF 都越界"。
    expect(resolveWithinRoot('D:/pa-root/', 'D:/pa-root/a.pdf')).toBe('D:/pa-root/a.pdf')
  })

  it('candidate 等于根本身放行', () => {
    // 不算越界。后面 readFile 会抛 EISDIR，由 executor 转成 FILE_UNREADABLE。
    expect(resolveWithinRoot(ROOT, 'D:/pa-root')).toBe('D:/pa-root')
  })

  it('大小写不同的同一根放行', () => {
    // Windows 路径大小写不敏感。用 toLocaleLowerCase 的话土耳其语 locale
    // 下 'I' 会变成 'ı'，判定就错了。
    expect(resolveWithinRoot('d:/PA-Root', 'D:/pa-root/A.PDF')).toBe('D:/pa-root/A.PDF')
  })

  it('根里的 .. 被规范化后仍能匹配', () => {
    expect(resolveWithinRoot('D:/pa-root/sub/..', 'D:/pa-root/a.pdf')).toBe('D:/pa-root/a.pdf')
  })
})

describe('resolveWithinRoot：拒绝', () => {
  it('同名前缀的兄弟目录被拒', () => {
    // 这是不补分隔符时的经典漏洞：实测
    // 'D:/pa-root-evil/x.pdf'.startsWith('D:/pa-root') === true。
    expect(resolveWithinRoot(ROOT, 'D:/pa-root-evil/x.pdf')).toBeNull()
  })

  it('.. 逃逸被拒', () => {
    // 顺序必须是先 resolve 再比较。反过来 '..' 还在字符串里，
    // 'D:/pa-root/../../etc/passwd' 的 startsWith 检查会通过。
    expect(resolveWithinRoot(ROOT, 'D:/pa-root/../../etc/passwd')).toBeNull()
  })

  it('根外的绝对路径被拒', () => {
    expect(resolveWithinRoot(ROOT, 'C:/Windows/system32/x.pdf')).toBeNull()
  })

  it('相对路径落到 cwd 时被拒', () => {
    // resolve('a.pdf') 以 cwd 为基准，测试进程的 cwd 不在假根内。
    expect(resolveWithinRoot(ROOT, 'a.pdf')).toBeNull()
  })

  it('空字符串被拒', () => {
    // DocumentExtractPdfParams 的 min(1) 已经挡住空 path，这里是第二道：
    // resolve('') 得到 cwd，不拒的话就等于把整个 cwd 当成授权根。
    expect(resolveWithinRoot(ROOT, '')).toBeNull()
  })

  it('根是自己前缀的更短路径被拒', () => {
    expect(resolveWithinRoot('D:/pa-root/sub', 'D:/pa-root/a.pdf')).toBeNull()
  })
})

describe('resolveWithinRoot：返回值可直接喂给 fs', () => {
  it('返回值再 resolve 一次不变', () => {
    // 幂等性。executor 拿到返回值直接 readFile，若它还不是规范形式，
    // 下游再做一次 resolve 会得到不同字符串，日志和错误信息就对不上。
    const out = resolveWithinRoot(ROOT, 'D:/pa-root/a.pdf')
    expect(out).not.toBeNull()
    expect(toPosix(resolve(out as string))).toBe(out)
  })
})

describe('splitExisting：最近存在祖先', () => {
  let dir: string
  let realRoot: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pa-split-'))
    realRoot = toPosix(await realpath(dir))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('目标存在时 rest 为空', async () => {
    await writeFile(join(dir, 'a.pdf'), 'A')

    expect(await splitExisting(`${realRoot}/a.pdf`)).toEqual({
      existing: `${realRoot}/a.pdf`,
      rest: []
    })
  })

  it('目标不存在时，未创建的段全留在 rest 里', async () => {
    expect(await splitExisting(`${realRoot}/a/b/c.pdf`)).toEqual({
      existing: realRoot,
      rest: ['a', 'b', 'c.pdf']
    })
  })

  it('existing 一定存在，且拼上 rest 能还原成原路径', async () => {
    // 不变量。盘符回退那一支需要一台没有某个盘符的机器才能造出来，
    // 写死盘符换机器就红，所以改成钉「无论退到哪一级，这两条都成立」。
    await mkdir(join(dir, 'real'))
    const candidates = [realRoot, `${realRoot}/real`, `${realRoot}/ghost.pdf`, `${realRoot}/x/y/z`]

    for (const abs of candidates) {
      const { existing, rest } = await splitExisting(abs)
      expect(existsSync(existing), abs).toBe(true)
      expect(rest.length === 0 ? existing : `${existing}/${rest.join('/')}`, abs).toBe(abs)
    }
  })
})

describe('resolveWithinRootReal：TEST-004 授权根边界（真文件系统）', () => {
  let dir: string
  let realRoot: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pa-guard-'))
    // 断言一律与 realpath 后的根比：tmpdir 本身在某些机器上就是链接，
    // 直接拿 dir 拼期望值会把「解链接」这件事测成假阳性。
    realRoot = toPosix(await realpath(dir))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('根内真实文件放行，返回 realpath 形式', async () => {
    await writeFile(join(dir, 'a.pdf'), 'A')

    expect(await resolveWithinRootReal(dir, join(dir, 'a.pdf'))).toEqual({
      ok: true,
      path: `${realRoot}/a.pdf`
    })
  })

  it('大小写不同的同一路径放行（Windows 不敏感）', async () => {
    await writeFile(join(dir, 'a.pdf'), 'A')

    const out = await resolveWithinRootReal(dir.toUpperCase(), join(dir, 'A.PDF'))

    expect(out.ok).toBe(true)
    // realpath 会把大小写还原成文件系统上的真身，所以能与 realRoot 比。
    expect(out.ok && out.path).toBe(`${realRoot}/a.pdf`)
  })

  it('.. 逃逸 -> PATH_OUT_OF_ROOT', async () => {
    const out = await resolveWithinRootReal(dir, join(dir, '..', 'secret.pdf'))

    expect(out.ok).toBe(false)
    expect(!out.ok && out.code).toBe('PATH_OUT_OF_ROOT')
  })

  it('根外绝对路径 -> PATH_OUT_OF_ROOT', async () => {
    const out = await resolveWithinRootReal(dir, 'C:/Windows/win.ini')

    expect(!out.ok && out.code).toBe('PATH_OUT_OF_ROOT')
  })

  it('同名前缀的兄弟目录 -> PATH_OUT_OF_ROOT', async () => {
    const evil = `${dir}-evil`
    await mkdir(evil, { recursive: true })
    try {
      const out = await resolveWithinRootReal(dir, join(evil, 'x.pdf'))
      expect(!out.ok && out.code).toBe('PATH_OUT_OF_ROOT')
    } finally {
      await rm(evil, { recursive: true, force: true })
    }
  })

  it('UNC 路径 -> PATH_UNC_NOT_ALLOWED', async () => {
    // 词法上它连盘符都没有，前缀比较对它无意义，所以必须在 resolve 之后
    // 立刻用 '//' 前缀拦掉，而不是丢给 realpath。
    const out = await resolveWithinRootReal(dir, '\\\\evil-server\\share\\x.pdf')

    expect(!out.ok && out.code).toBe('PATH_UNC_NOT_ALLOWED')
  })

  it('设备路径 -> PATH_UNC_NOT_ALLOWED', async () => {
    for (const candidate of ['\\\\?\\C:\\Windows\\win.ini', '\\\\.\\C:\\Windows\\win.ini']) {
      const out = await resolveWithinRootReal(dir, candidate)
      expect(out.ok, candidate).toBe(false)
      expect(!out.ok && out.code, candidate).toBe('PATH_UNC_NOT_ALLOWED')
    }
  })

  it('授权根不存在 -> PATH_OUT_OF_ROOT，reason 说清是根坏了', async () => {
    const gone = join(dir, 'nope')

    const out = await resolveWithinRootReal(gone, join(gone, 'a.pdf'))

    expect(out.ok).toBe(false)
    expect(!out.ok && out.code).toBe('PATH_OUT_OF_ROOT')
    expect(!out.ok && out.reason).toContain('授权根不可用')
  })

  it('根内不存在的目标放行：不存在不等于越界', async () => {
    // TASK-020 的 create_dir / move 目标在调用时还不存在。
    // 这里若报 PATH_OUT_OF_ROOT，那两个能力永远拿不到授权。
    expect(await resolveWithinRootReal(dir, join(dir, 'ghost.pdf'))).toEqual({
      ok: true,
      path: `${realRoot}/ghost.pdf`
    })
  })

  it('多层未创建的目标放行，未存在的段原样接在真身祖先后面', async () => {
    expect(await resolveWithinRootReal(dir, join(dir, 'a', 'b', 'c.pdf'))).toEqual({
      ok: true,
      path: `${realRoot}/a/b/c.pdf`
    })
  })

  it('根自己是 junction 时，用真身做边界判定', async () => {
    const inner = join(dir, 'inner')
    await mkdir(inner)
    await writeFile(join(inner, 'a.pdf'), 'A')
    const linkRoot = join(dir, 'link-root')
    await symlink(inner, linkRoot, 'junction')

    const out = await resolveWithinRootReal(linkRoot, join(linkRoot, 'a.pdf'))
    const realInner = toPosix(await realpath(inner))

    expect(out).toEqual({ ok: true, path: `${realInner}/a.pdf` })
  })

  it('根内 junction 指向根外 -> PATH_ESCAPES_ROOT_VIA_LINK', async () => {
    // 这条是 resolveWithinRoot 挡不住、只有 realpath 才挡得住的那一类：
    // 词法上 'escape/secret.pdf' 明明在根内。
    const outside = await mkdtemp(join(tmpdir(), 'pa-outside-'))
    try {
      await writeFile(join(outside, 'secret.pdf'), 'S')
      await symlink(outside, join(dir, 'escape'), 'junction')

      const out = await resolveWithinRootReal(dir, join(dir, 'escape', 'secret.pdf'))

      expect(out.ok).toBe(false)
      expect(!out.ok && out.code).toBe('PATH_ESCAPES_ROOT_VIA_LINK')
      expect(resolveWithinRoot(dir, join(dir, 'escape', 'secret.pdf'))).not.toBeNull()
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('根内 junction 指向根内 -> 放行，且返回解链接后的真身路径', async () => {
    const inner = join(dir, 'inner')
    await mkdir(inner)
    await writeFile(join(inner, 'a.pdf'), 'A')
    await symlink(inner, join(dir, 'alias'), 'junction')

    const out = await resolveWithinRootReal(dir, join(dir, 'alias', 'a.pdf'))

    expect(out).toEqual({ ok: true, path: `${realRoot}/inner/a.pdf` })
    // 返回 alias 的话，TASK-018 算出的 Canonical Arguments Hash 会绑在一个
    // 随时可能改指向的别名上，幂等判定就失效了。
    expect(out.ok && out.path).not.toContain('alias')
  })

  it('返回值是稳定形式：拿它再喂一次得到同一个结果', async () => {
    await writeFile(join(dir, 'a.pdf'), 'A')
    const first = await resolveWithinRootReal(dir, join(dir, 'a.pdf'))
    if (!first.ok) throw new Error('期望放行')

    expect(await resolveWithinRootReal(dir, first.path)).toEqual(first)
  })
})

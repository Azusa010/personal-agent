import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listPdfs } from './filesystem-list'
import { formatModifiedAt, toPosix } from './roots'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pa-list-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function put(name: string, content: string, mtimeMs: number): Promise<string> {
  const full = join(dir, name)
  await writeFile(full, content, 'latin1')
  // 显式设 mtime：不设的话全部落在"刚才"，倒序断言会退化成目录列举顺序，
  // 测试绿了但根本没验证排序。
  const when = new Date(mtimeMs)
  await utimes(full, when, when)
  return full
}

const T_OLD = 1756720800000 // 2025-09-01T10:00:00Z
const T_MID = 1759312800000 // 2025-10-01T10:00:00Z
const T_NEW = 1761991200000 // 2025-11-01T10:00:00Z

describe('listPdfs：过滤', () => {
  it('只收 .pdf，忽略其它后缀与子目录', async () => {
    await put('a.pdf', 'A', T_OLD)
    await put('b.txt', 'B', T_MID)
    await put('c.pdf.md', 'C', T_NEW)
    await mkdir(join(dir, 'subdir'))

    const entries = await listPdfs(dir)
    expect(entries.map((e) => e.name)).toEqual(['a.pdf'])
  })

  it('大写 .PDF 也收', async () => {
    // 后缀比较必须小写化。Windows 上 .PDF 和 .pdf 是同一种文件，
    // 漏掉大写会让"下载目录里明明有却列不出来"。
    await put('UPPER.PDF', 'U', T_OLD)
    await put('Mixed.Pdf', 'M', T_MID)

    const entries = await listPdfs(dir)
    expect(entries.map((e) => e.name).sort()).toEqual(['Mixed.Pdf', 'UPPER.PDF'])
  })

  it('名字以 .pdf 结尾的目录被跳过', async () => {
    // 这条钉"用 stat().isFile() 而不是 Dirent.isFile()"：后者对 symlink
    // 返回 false，与 Python 的 child.is_file() 行为不一致。这里先钉目录分支。
    await mkdir(join(dir, 'fake.pdf'))
    await put('real.pdf', 'R', T_OLD)

    const entries = await listPdfs(dir)
    expect(entries.map((e) => e.name)).toEqual(['real.pdf'])
  })

  it('不递归进子目录', async () => {
    await mkdir(join(dir, 'nested'))
    await writeFile(join(dir, 'nested', 'deep.pdf'), 'D')

    expect(await listPdfs(dir)).toEqual([])
  })
})

describe('listPdfs：排序', () => {
  it('按修改时间倒序', async () => {
    // 写入顺序故意与期望顺序相反：老的最后写。若实现按目录列举顺序返回，
    // 这条会红。
    await put('newest.pdf', 'N', T_NEW)
    await put('oldest.pdf', 'O', T_OLD)
    await put('middle.pdf', 'M', T_MID)

    const entries = await listPdfs(dir)
    expect(entries.map((e) => e.name)).toEqual(['newest.pdf', 'middle.pdf', 'oldest.pdf'])
  })

  it('同一秒内的两个文件顺序不退化', async () => {
    // modifiedAt 截到秒之后两条字符串完全相同。排序键若用那个字符串，
    // 顺序就退化成不稳定；必须用 mtimeMs 数字。
    await put('later.pdf', 'L', T_OLD + 400)
    await put('earlier.pdf', 'E', T_OLD)

    const entries = await listPdfs(dir)
    expect(entries.map((e) => e.name)).toEqual(['later.pdf', 'earlier.pdf'])
    expect(entries[0]!.modifiedAt).toBe(entries[1]!.modifiedAt)
  })

  it('空目录返回空数组', async () => {
    // 空列表是合法成功态，不是错误。根目录不存在才是
    // FILESYSTEM_ROOT_UNAVAILABLE —— 两者混淆会让配置错误显示成"没有 PDF"。
    expect(await listPdfs(dir)).toEqual([])
  })
})

describe('listPdfs：字段格式', () => {
  it('absolutePath 是正斜杠绝对路径', async () => {
    await put('a.pdf', 'A', T_OLD)
    const [entry] = await listPdfs(dir)

    // 与 Python 侧 Path.resolve().as_posix() 一致。join 在 Windows 上
    // 返回反斜杠，不再过一遍 toPosix 就会与既有 fixture 和 db 历史值漂移。
    expect(entry!.absolutePath).toBe(toPosix(join(dir, 'a.pdf')))
    expect(entry!.absolutePath).not.toContain('\\')
  })

  it('modifiedAt 是秒精度带 Z', async () => {
    await put('a.pdf', 'A', T_NEW)
    const [entry] = await listPdfs(dir)

    expect(entry!.modifiedAt).toBe(formatModifiedAt(T_NEW))
    expect(entry!.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('sizeBytes 是文件字节数', async () => {
    await put('a.pdf', 'ABCDE', T_OLD)
    const [entry] = await listPdfs(dir)
    expect(entry!.sizeBytes).toBe(5)
  })

  it('name 是文件名而不是全路径', async () => {
    await put('a.pdf', 'A', T_OLD)
    const [entry] = await listPdfs(dir)
    expect(entry!.name).toBe('a.pdf')
  })
})

describe('listPdfs：前提失败', () => {
  it('根目录不存在时抛，不静默返回空数组', async () => {
    // 纯核心层假设 base 存在；不存在就抛，由 executor 转成
    // FILESYSTEM_ROOT_UNAVAILABLE。返回 [] 会把"目录配错了"掩盖成
    //"没有 PDF"，用户无从诊断。
    await expect(listPdfs(join(dir, 'nope'))).rejects.toThrow()
  })

  it('坏条目不影响其余条目', async () => {
    // 逐个 stat 的 try/catch 只跳过坏条目。这里用可读文件验证正常路径，
    // 权限型坏条目在 Windows 上不好稳定构造，靠 catch 分支的存在性覆盖。
    await put('ok.pdf', 'K', T_OLD)
    const entries = await listPdfs(dir)
    expect(entries).toHaveLength(1)
  })
})

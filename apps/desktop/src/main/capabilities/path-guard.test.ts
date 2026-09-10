import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolveWithinRoot } from './path-guard'
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

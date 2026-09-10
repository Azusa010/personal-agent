import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ROOT_ENV, formatModifiedAt, resolveRoot, toPosix } from './roots'

// 钉值：这个名字必须与 Python 侧 tools/filesystem.py 的 _ROOT_ENV 一致
//（2d-1c 删掉那个文件之后，它是 runtime-host spawn 时传的环境变量名）。
// 故意重复字面量而不从别处 import —— 钉值测试重复才有意义，否则改了
// 源码测试跟着改，漂移永远抓不到。
const ENV_NAME = 'PERSONAL_AGENT_DOWNLOADS_DIR'

const fallbackRoot = toPosix(resolve(join(homedir(), 'Downloads')))

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ROOT_ENV', () => {
  it('downloads 的环境变量名与 Python 侧一致', () => {
    expect(ROOT_ENV['downloads']).toBe(ENV_NAME)
  })

  it('只有 downloads 一个逻辑根', () => {
    // filesystem.list 的 RootId enum 目前只有 downloads。这里多出一个键
    // 说明有人加了没走契约的根，两边会各自演化。
    expect(Object.keys(ROOT_ENV)).toEqual(['downloads'])
  })
})

describe('resolveRoot', () => {
  it('环境变量优先', () => {
    vi.stubEnv(ENV_NAME, 'D:/pa-test/downloads')
    expect(resolveRoot('downloads')).toBe('D:/pa-test/downloads')
  })

  it('反斜杠环境变量被转成正斜杠', () => {
    // Windows 上用户配环境变量时写反斜杠是常态。不转的话 wire 上会
    // 同时出现两种分隔符，与 fixture 和 db 里的历史值漂移。
    vi.stubEnv(ENV_NAME, 'D:\\pa-test\\downloads')
    expect(resolveRoot('downloads')).toBe('D:/pa-test/downloads')
  })

  it('尾斜杠被吃掉', () => {
    // path-guard 拼的是 base + '/'，尾斜杠留着就成了 '//'，前缀永远不匹配。
    vi.stubEnv(ENV_NAME, 'D:/pa-test/downloads/')
    expect(resolveRoot('downloads')).toBe('D:/pa-test/downloads')
  })

  it('相对路径被绝对化到 cwd', () => {
    // 不 resolve 的话根跟着 cwd 跑，而 path-guard 那边的 root 是 resolve
    // 过的，两边基准不一致：同一个文件在一处判越界、另一处判合法。
    vi.stubEnv(ENV_NAME, 'rel-downloads')
    expect(resolveRoot('downloads')).toBe(toPosix(resolve('rel-downloads')))
  })

  it('环境变量未设时 fallback 到 homedir/Downloads', () => {
    vi.stubEnv(ENV_NAME, undefined)
    expect(resolveRoot('downloads')).toBe(fallbackRoot)
  })

  it('环境变量为空字符串时同样 fallback', () => {
    // 空字符串是"设了但无效"，走的是同一个真值判断分支。
    // 用 !== undefined 判的话这里会返回空串，后面 readdir('') 抛 ENOENT，
    // 报成 FILESYSTEM_ROOT_UNAVAILABLE，诊断方向完全错。
    vi.stubEnv(ENV_NAME, '')
    expect(resolveRoot('downloads')).toBe(fallbackRoot)
  })

  it('白名单外的 rootId 抛', () => {
    // 这个 throw 是防御性的：RootId enum 已经在上游挡住。真被调到说明
    // 有人绕过契约直接调 resolveRoot，此时静默 fallback 比抛更危险。
    expect(() => resolveRoot('desktop')).toThrow('未知 rootId')
  })
})

describe('formatModifiedAt', () => {
  it('秒精度带 Z，不带毫秒', () => {
    // 实测值。Python 侧是 isoformat(timespec="seconds").replace("+00:00","Z")，
    // 同一个 mtime 两边必须逐字节相同，否则同一个文件在 db 里会出现两种格式。
    expect(formatModifiedAt(1756720800000)).toBe('2025-09-01T10:00:00Z')
  })

  it('毫秒被截掉而不是四舍五入', () => {
    expect(formatModifiedAt(1756720800999)).toBe('2025-09-01T10:00:00Z')
  })

  it('纪元零点', () => {
    expect(formatModifiedAt(0)).toBe('1970-01-01T00:00:00Z')
  })
})

describe('toPosix', () => {
  it('反斜杠转正斜杠', () => {
    expect(toPosix('D:\\a\\b.pdf')).toBe('D:/a/b.pdf')
  })

  it('已经是正斜杠的原样返回', () => {
    expect(toPosix('D:/a/b.pdf')).toBe('D:/a/b.pdf')
  })

  it('UNC 路径的双反斜杠也被转', () => {
    // UNC 的完整校验属 Phase 2 TASK-017，这里只钉格式转换本身不炸。
    expect(toPosix('\\\\server\\share\\a.pdf')).toBe('//server/share/a.pdf')
  })
})

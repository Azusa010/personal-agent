import { describe, expect, it } from 'vitest'
import { resolveVikingUriWithinRoot } from './path-guard'

const STORE_ROOT = 'D:/personal-agent/viking_store'

describe('viking-path-guard：正常 URI 解析与路径规范化', () => {
  it('根 URI 解析为知识库根目录绝对路径', () => {
    expect(resolveVikingUriWithinRoot('viking://', STORE_ROOT)).toBe(
      'D:/personal-agent/viking_store'
    )
    expect(resolveVikingUriWithinRoot('viking:///', STORE_ROOT)).toBe(
      'D:/personal-agent/viking_store'
    )
  })

  it('一级子目录与 Markdown 文件解析', () => {
    expect(resolveVikingUriWithinRoot('viking://identity', STORE_ROOT)).toBe(
      'D:/personal-agent/viking_store/identity'
    )
    expect(resolveVikingUriWithinRoot('viking://identity/profile.md', STORE_ROOT)).toBe(
      'D:/personal-agent/viking_store/identity/profile.md'
    )
  })

  it('深层子目录结构与文件解析', () => {
    expect(
      resolveVikingUriWithinRoot(
        'viking://knowledge/cpu_architectures/avx_instruction_set.md',
        STORE_ROOT
      )
    ).toBe('D:/personal-agent/viking_store/knowledge/cpu_architectures/avx_instruction_set.md')
  })

  it('大小写协议头统一放行', () => {
    expect(resolveVikingUriWithinRoot('VIKING://projects/PA.md', STORE_ROOT)).toBe(
      'D:/personal-agent/viking_store/projects/PA.md'
    )
    expect(resolveVikingUriWithinRoot('Viking://INDEX.md', STORE_ROOT)).toBe(
      'D:/personal-agent/viking_store/INDEX.md'
    )
  })

  it('安全相对导航在根内解析成功', () => {
    expect(resolveVikingUriWithinRoot('viking://knowledge/sub/../cpu.md', STORE_ROOT)).toBe(
      'D:/personal-agent/viking_store/knowledge/cpu.md'
    )
  })

  it('包含反斜杠被转正为 Posix 路径', () => {
    expect(resolveVikingUriWithinRoot('viking://knowledge\\cpu.md', STORE_ROOT)).toBe(
      'D:/personal-agent/viking_store/knowledge/cpu.md'
    )
  })
})

describe('viking-path-guard：沙箱逃逸拦截 (test_sandbox_escape_attempts)', () => {
  it('父级目录 .. 逃逸被拒绝', () => {
    expect(() => resolveVikingUriWithinRoot('viking://../secret.txt', STORE_ROOT)).toThrow(
      /VIKING_SANDBOX_ESCAPE/
    )
    expect(() =>
      resolveVikingUriWithinRoot('viking://identity/../../Windows/System32', STORE_ROOT)
    ).toThrow(/VIKING_SANDBOX_ESCAPE/)
  })

  it('URL 编码 %2e%2e 绕过逃逸被拒绝', () => {
    expect(() => resolveVikingUriWithinRoot('viking://%2e%2e/secret.txt', STORE_ROOT)).toThrow(
      /VIKING_SANDBOX_ESCAPE/
    )
    expect(() =>
      resolveVikingUriWithinRoot('viking://%2e%2e%2f%2e%2e%2fWindows', STORE_ROOT)
    ).toThrow(/VIKING_SANDBOX_ESCAPE/)
  })

  it('UNC 与网络共享路径被拒绝', () => {
    expect(() =>
      resolveVikingUriWithinRoot('viking:////evil-server/share/payload.md', STORE_ROOT)
    ).toThrow(/VIKING_UNC_FORBIDDEN/)
    expect(() => resolveVikingUriWithinRoot('viking://\\\\evil-server\\share', STORE_ROOT)).toThrow(
      /VIKING_UNC_FORBIDDEN/
    )
  })

  it('Windows 绝对盘符路径被拒绝', () => {
    expect(() => resolveVikingUriWithinRoot('viking://C:/Windows/win.ini', STORE_ROOT)).toThrow(
      /VIKING_ABSOLUTE_PATH_FORBIDDEN/
    )
    expect(() => resolveVikingUriWithinRoot('viking://D:\\secret\\data.json', STORE_ROOT)).toThrow(
      /VIKING_ABSOLUTE_PATH_FORBIDDEN/
    )
  })

  it('Windows 保留设备名 (CON, NUL, AUX, COM1-9) 被拒绝', () => {
    expect(() => resolveVikingUriWithinRoot('viking://con', STORE_ROOT)).toThrow(
      /VIKING_DEVICE_NAME_FORBIDDEN/
    )
    expect(() => resolveVikingUriWithinRoot('viking://nul.md', STORE_ROOT)).toThrow(
      /VIKING_DEVICE_NAME_FORBIDDEN/
    )
    expect(() => resolveVikingUriWithinRoot('viking://knowledge/aux.txt', STORE_ROOT)).toThrow(
      /VIKING_DEVICE_NAME_FORBIDDEN/
    )
    expect(() => resolveVikingUriWithinRoot('viking://projects/com1/file.md', STORE_ROOT)).toThrow(
      /VIKING_DEVICE_NAME_FORBIDDEN/
    )
  })

  it('非 viking:// 协议与畸形 URI 被拒绝', () => {
    expect(() => resolveVikingUriWithinRoot('file:///D:/viking_store/a.md', STORE_ROOT)).toThrow(
      /INVALID_VIKING_URI/
    )
    expect(() => resolveVikingUriWithinRoot('http://example.com', STORE_ROOT)).toThrow(
      /INVALID_VIKING_URI/
    )
    expect(() => resolveVikingUriWithinRoot('C:/Windows/win.ini', STORE_ROOT)).toThrow(
      /INVALID_VIKING_URI/
    )
    expect(() => resolveVikingUriWithinRoot('', STORE_ROOT)).toThrow(/INVALID_VIKING_URI/)
  })
})

import { describe, it, expect } from 'vitest'
import { parseCodeBlockMeta } from './markdown'

describe('parseCodeBlockMeta', () => {
  it('标准 language-xxx 格式提取为小写语言名', () => {
    expect(parseCodeBlockMeta('language-typescript')).toEqual({ language: 'typescript' })
    expect(parseCodeBlockMeta('language-PYTHON')).toEqual({ language: 'python' })
    expect(parseCodeBlockMeta('language-c++')).toEqual({ language: 'c++' })
  })

  it('多个 class 类名中包含 language-xxx 时正确识别', () => {
    expect(parseCodeBlockMeta('hljs language-bash active')).toEqual({ language: 'bash' })
  })

  it('带有文件名或额外参数的声明正确剥离后缀', () => {
    expect(parseCodeBlockMeta('language-json:config.json')).toEqual({ language: 'json' })
  })

  it('未指定语言或无 language- 前缀时返回空串', () => {
    expect(parseCodeBlockMeta(undefined)).toEqual({ language: '' })
    expect(parseCodeBlockMeta('')).toEqual({ language: '' })
    expect(parseCodeBlockMeta('inline-code-class')).toEqual({ language: '' })
    expect(parseCodeBlockMeta('   ')).toEqual({ language: '' })
  })
})

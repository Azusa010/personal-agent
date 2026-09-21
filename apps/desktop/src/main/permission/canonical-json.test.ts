import { describe, it, expect } from 'vitest'
import { canonicalize } from './canonical-json'

describe('canonicalize：键序', () => {
  it('键序打乱得到同一个串', () => {
    const a = canonicalize({ path: 'D:/downloads/a.pdf', overwrite: true })
    const b = canonicalize({ overwrite: true, path: 'D:/downloads/a.pdf' })
    expect(a).toBe(b)
    expect(a).toBe('{"overwrite":true,"path":"D:/downloads/a.pdf"}')
  })

  it('嵌套对象递归排序', () => {
    expect(canonicalize({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}')
  })

  it('按 UTF-16 码元序排，不是 localeCompare：大写 B 排在小写 a 前面', () => {
    // localeCompare('B','a') 在多数 locale 下是负数，会把 a 排前面，这里必须是反的
    expect(canonicalize({ a: 2, B: 1 })).toBe('{"B":1,"a":2}')
  })

  it('同一个值调两次结果一样', () => {
    const value = { source: ['b.pdf', 'a.pdf'], target: 'Reading/' }
    expect(canonicalize(value)).toBe(canonicalize(value))
  })
})

describe('canonicalize：数组', () => {
  it('数组保持原序，排序会改变动作语义', () => {
    expect(canonicalize({ source: ['b.pdf', 'a.pdf'] })).toBe('{"source":["b.pdf","a.pdf"]}')
  })

  it('数组里的对象仍然排序', () => {
    expect(canonicalize([{ z: 1, a: 2 }])).toBe('[{"a":2,"z":1}]')
  })

  it('空数组与空对象', () => {
    expect(canonicalize([])).toBe('[]')
    expect(canonicalize({})).toBe('{}')
    expect(canonicalize({ a: [], b: {} })).toBe('{"a":[],"b":{}}')
  })
})

describe('canonicalize：undefined 与 null', () => {
  it('值为 undefined 的键整个剔掉，null 保留', () => {
    expect(canonicalize({ a: 1, b: undefined, c: null })).toBe('{"a":1,"c":null}')
  })

  it('嵌套层里的 undefined 同样剔掉', () => {
    expect(canonicalize({ a: { b: undefined, c: 2 } })).toBe('{"a":{"c":2}}')
  })
})

describe('canonicalize：输出不含空白', () => {
  it('嵌套数组与对象之间没有空格', () => {
    expect(canonicalize({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}')
  })
})

describe('canonicalize：标量', () => {
  it('数字 1 与字符串 "1" 必须是不同的串', () => {
    expect(canonicalize({ a: 1 })).toBe('{"a":1}')
    expect(canonicalize({ a: '1' })).toBe('{"a":"1"}')
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: '1' }))
  })

  it('小数与布尔按 JSON.stringify 的写法', () => {
    expect(canonicalize({ a: 1.5 })).toBe('{"a":1.5}')
    expect(canonicalize({ a: true, b: false })).toBe('{"a":true,"b":false}')
  })

  it('顶层不是对象也能处理', () => {
    expect(canonicalize('D:/downloads/a.pdf')).toBe('"D:/downloads/a.pdf"')
    expect(canonicalize(42)).toBe('42')
    expect(canonicalize(true)).toBe('true')
    expect(canonicalize(null)).toBe('null')
    expect(canonicalize(['a', 'b'])).toBe('["a","b"]')
  })
})

describe('canonicalize：转义', () => {
  it('反斜杠按 JSON 规则翻倍：模型给的 Windows 路径不会把串写坏', () => {
    // 入参的实际字符是 D:\downloads\a.pdf（单反斜杠）
    // 输出的实际字符是 {"p":"D:\\downloads\\a.pdf"}（双反斜杠）
    expect(canonicalize({ p: 'D:\\downloads\\a.pdf' })).toBe('{"p":"D:\\\\downloads\\\\a.pdf"}')
  })

  it('双引号与换行被转义', () => {
    expect(canonicalize({ p: 'a"b' })).toBe('{"p":"a\\"b"}')
    expect(canonicalize({ p: 'a\nb' })).toBe('{"p":"a\\nb"}')
  })

  it('中文原样保留，不转成 \\uXXXX', () => {
    expect(canonicalize({ goal: '整理下载目录' })).toBe('{"goal":"整理下载目录"}')
  })
})

describe('canonicalize：贴近真实参数的综合用例', () => {
  it('filesystem_move 的两个规范化路径', () => {
    const bound = {
      target: 'D:/downloads/Reading/a.pdf',
      source: 'D:/downloads/a.pdf'
    }
    expect(canonicalize(bound)).toBe(
      '{"source":"D:/downloads/a.pdf","target":"D:/downloads/Reading/a.pdf"}'
    )
  })

  it('filesystem_list 只有一个枚举字段', () => {
    expect(canonicalize({ rootId: 'downloads' })).toBe('{"rootId":"downloads"}')
  })
})

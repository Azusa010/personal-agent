import { describe, expect, it } from 'vitest'
import {
  isAllowedComponentType,
  sanitizeImageSrc,
  sanitizeProps
} from '../../../../src/renderer/src/components/a2ui/sanitize'
import { A2UIComponentType } from '@personal-agent/protocol'

describe('a2ui/sanitize', () => {
  describe('isAllowedComponentType', () => {
    it('对白名单中的全部 23 种组件类型均返回 true', () => {
      for (const type of A2UIComponentType.options) {
        expect(isAllowedComponentType(type)).toBe(true)
      }
    })

    it('对白名单之外的危险或未知 HTML 标签返回 false', () => {
      const dangerousTypes = [
        'script',
        'iframe',
        'object',
        'embed',
        'link',
        'style',
        'button',
        'div',
        'span',
        'unknown_custom'
      ]
      for (const type of dangerousTypes) {
        expect(isAllowedComponentType(type)).toBe(false)
      }
    })
  })

  describe('sanitizeProps', () => {
    it('过滤所有以 on* 开头的事件处理器（大小写不敏感）', () => {
      const rawProps = {
        label: '用户名',
        onClick: "alert('xss')",
        ONMOUSEOVER: 'fetch("evil.com")',
        onchange: 'doBadThing()',
        onFocus: () => {}
      }

      const cleaned = sanitizeProps(rawProps)
      expect(cleaned).toEqual({
        label: '用户名'
      })
      expect(cleaned['onClick']).toBeUndefined()
      expect(cleaned['ONMOUSEOVER']).toBeUndefined()
      expect(cleaned['onchange']).toBeUndefined()
      expect(cleaned['onFocus']).toBeUndefined()
    })

    it('过滤 dangerouslySetInnerHTML, innerHTML, outerHTML 注入属性', () => {
      const rawProps = {
        title: '测试标题',
        dangerouslySetInnerHTML: { __html: '<script>alert(1)</script>' },
        innerHTML: '<b>hacked</b>',
        outerHTML: '<div>leak</div>'
      }

      const cleaned = sanitizeProps(rawProps)
      expect(cleaned).toEqual({
        title: '测试标题'
      })
    })

    it('过滤 javascript: 和 vbscript: 协议的字符串', () => {
      const rawProps = {
        href: 'javascript:alert(1)',
        actionUrl: '  VBSCRIPT:msgbox(1)  ',
        normalUrl: 'https://example.com/api',
        text: 'hello world'
      }

      const cleaned = sanitizeProps(rawProps)
      expect(cleaned['href']).toBeUndefined()
      expect(cleaned['actionUrl']).toBeUndefined()
      expect(cleaned['normalUrl']).toBe('https://example.com/api')
      expect(cleaned['text']).toBe('hello world')
    })

    it('保留安全合法的组件属性（字符串、数值、布尔值、对象、数组）', () => {
      const validProps = {
        label: '年龄',
        min: 0,
        max: 120,
        disabled: false,
        placeholder: '请输入',
        options: ['A', 'B', 'C'],
        nested: { key: 'value' }
      }

      const cleaned = sanitizeProps(validProps)
      expect(cleaned).toEqual(validProps)
    })
  })

  describe('sanitizeImageSrc', () => {
    it('允许 HTTP / HTTPS 网络图片地址', () => {
      expect(sanitizeImageSrc('https://example.com/logo.png')).toBe('https://example.com/logo.png')
      expect(sanitizeImageSrc('http://localhost:3000/avatar.jpg')).toBe(
        'http://localhost:3000/avatar.jpg'
      )
    })

    it('允许安全图片 Data URI', () => {
      const dataUri =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY44YAAAAASUVORK5CYII='
      expect(sanitizeImageSrc(dataUri)).toBe(dataUri)
    })

    it('允许相对工作区资源路径', () => {
      expect(sanitizeImageSrc('assets/diagram.png')).toBe('assets/diagram.png')
      expect(sanitizeImageSrc('./sub/image.jpg')).toBe('./sub/image.jpg')
    })

    it('拒绝 javascript: 或 data:text/html 等危险伪协议', () => {
      expect(sanitizeImageSrc("javascript:alert('xss')")).toBeNull()
      expect(sanitizeImageSrc('data:text/html,<script>alert(1)</script>')).toBeNull()
    })

    it('拒绝系统敏感路径', () => {
      expect(sanitizeImageSrc('file:///C:/Windows/System32/calc.exe')).toBeNull()
      expect(sanitizeImageSrc('C:\\Windows\\explorer.exe')).toBeNull()
      expect(sanitizeImageSrc('/etc/shadow')).toBeNull()
    })

    it('对非字符串或空输入返回 null', () => {
      expect(sanitizeImageSrc(null)).toBeNull()
      expect(sanitizeImageSrc(undefined)).toBeNull()
      expect(sanitizeImageSrc('')).toBeNull()
      expect(sanitizeImageSrc('   ')).toBeNull()
      expect(sanitizeImageSrc(123)).toBeNull()
    })
  })
})

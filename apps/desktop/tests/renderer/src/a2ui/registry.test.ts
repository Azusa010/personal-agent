import { describe, expect, it, vi } from 'vitest'
import { A2UIComponentType, type A2UIComponent } from '@personal-agent/protocol'
import {
  COMPONENT_REGISTRY,
  renderA2UIComponent
} from '../../../../src/renderer/src/components/a2ui/component-registry'
import type { A2UIComponentRenderContext } from '../../../../src/renderer/src/components/a2ui/types'

describe('a2ui/component-registry', () => {
  it('白名单中的所有 23 种组件均已注册对应的渲染函数', () => {
    for (const type of A2UIComponentType.options) {
      expect(COMPONENT_REGISTRY[type]).toBeDefined()
      expect(typeof COMPONENT_REGISTRY[type]).toBe('function')
    }
  })

  describe('renderA2UIComponent', () => {
    const dummyContext: A2UIComponentRenderContext = {
      getValue: vi.fn(() => 'dummy_val'),
      setValue: vi.fn(),
      readOnly: false
    }

    const dummyRenderChildren = vi.fn((children?: A2UIComponent[]) => {
      return children ? `[children:${children.length}]` : null
    })

    it('未知组件类型静默返回 null', () => {
      const invalidComp = {
        type: 'malicious_script' as unknown as A2UIComponent['type'],
        id: 'bad-1',
        props: {}
      }

      const result = renderA2UIComponent(invalidComp, dummyContext, dummyRenderChildren)
      expect(result).toBeNull()
    })

    it('正确渲染基础展示型组件（heading, paragraph, divider, alert, code_block）', () => {
      const headingComp: A2UIComponent = {
        type: 'heading',
        id: 'h1',
        props: { text: '系统概览', level: 2 }
      }
      const el = renderA2UIComponent(headingComp, dummyContext, dummyRenderChildren)
      expect(el).not.toBeNull()
      expect(el?.type).toBe('h2')

      const pComp: A2UIComponent = {
        type: 'paragraph',
        id: 'p1',
        props: { text: '这是描述信息' }
      }
      const pEl = renderA2UIComponent(pComp, dummyContext, dummyRenderChildren)
      expect(pEl).not.toBeNull()
      expect(pEl?.type).toBe('p')

      const divComp: A2UIComponent = {
        type: 'divider',
        id: 'd1',
        props: {}
      }
      const divEl = renderA2UIComponent(divComp, dummyContext, dummyRenderChildren)
      expect(divEl).not.toBeNull()
      expect(divEl?.type).toBe('hr')
    })

    it('正确渲染输入型组件并从 context 提取值', () => {
      const ctx: A2UIComponentRenderContext = {
        getValue: vi.fn((id) => (id === 'input-1' ? '用户输入内容' : undefined)),
        setValue: vi.fn(),
        readOnly: false
      }

      const textInputComp: A2UIComponent = {
        type: 'text_input',
        id: 'input-1',
        props: { label: '标题', placeholder: '请输入' }
      }

      const el = renderA2UIComponent(textInputComp, ctx, dummyRenderChildren)
      expect(el).not.toBeNull()
      expect(ctx.getValue).toHaveBeenCalledWith('input-1')
    })

    it('容器型组件（card, form, grid）会触发 renderChildren 递归渲染子节点', () => {
      const cardComp: A2UIComponent = {
        type: 'card',
        id: 'card-1',
        props: { title: '卡片标题' },
        children: [{ type: 'paragraph', id: 'p-in-card', props: { text: '卡片内容' } }]
      }

      const renderChildrenSpy = vi.fn((children) => `rendered-${children?.length}`)
      const el = renderA2UIComponent(cardComp, dummyContext, renderChildrenSpy)

      expect(el).not.toBeNull()
      expect(renderChildrenSpy).toHaveBeenCalledWith(cardComp.children)
    })
  })
})

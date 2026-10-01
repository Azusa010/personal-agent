import { describe, expect, it } from 'vitest'
import type { A2UIComponent } from '@personal-agent/protocol'
import {
  extractInitialFormValues,
  FormStateManager
} from '../../../../src/renderer/src/components/a2ui/form-state'

describe('a2ui/form-state', () => {
  describe('FormStateManager', () => {
    it('使用传入的初始值初始化并能正确读写', () => {
      const manager = new FormStateManager({ name: 'Alice', age: 25 })
      expect(manager.getValue('name')).toBe('Alice')
      expect(manager.getValue('age')).toBe(25)
      expect(manager.getValue('unknown')).toBeUndefined()

      manager.setValue('name', 'Bob')
      manager.setValue('city', 'Beijing')
      expect(manager.getValue('name')).toBe('Bob')
      expect(manager.getValue('city')).toBe('Beijing')

      const all = manager.getAllValues()
      expect(all).toEqual({ name: 'Bob', age: 25, city: 'Beijing' })
    })

    it('getAllValues 返回不可侵入的快照（深浅拷贝）', () => {
      const manager = new FormStateManager({ count: 1 })
      const values = manager.getAllValues()
      values['count'] = 999
      expect(manager.getValue('count')).toBe(1)
    })

    it('reset 能重置为新状态或空状态', () => {
      const manager = new FormStateManager({ foo: 'bar' })
      manager.reset({ hello: 'world' })
      expect(manager.getValue('foo')).toBeUndefined()
      expect(manager.getValue('hello')).toBe('world')

      manager.reset()
      expect(manager.getAllValues()).toEqual({})
    })
  })

  describe('extractInitialFormValues', () => {
    it('空组件数组返回空字典', () => {
      expect(extractInitialFormValues([])).toEqual({})
    })

    it('仅包含非输入组件（展示、布局类）时不记录其 id，返回空字典', () => {
      const components: A2UIComponent[] = [
        { type: 'heading', id: 'h1', props: { text: '标题' } },
        { type: 'paragraph', id: 'p1', props: { text: '内容' } },
        { type: 'divider', id: 'div1', props: {} },
        {
          type: 'card',
          id: 'card1',
          props: {},
          children: [
            { type: 'heading', id: 'h2', props: { text: '子标题' } },
            { type: 'divider', id: 'div2', props: {} }
          ]
        }
      ]

      const values = extractInitialFormValues(components)
      expect(values).toEqual({})
      expect(values['h1']).toBeUndefined()
      expect(values['card1']).toBeUndefined()
    })

    it('优先读取 props.value，其次 props.defaultValue，再次 props.default', () => {
      const components: A2UIComponent[] = [
        {
          type: 'text_input',
          id: 'val_first',
          props: { value: 'explicit_val', defaultValue: 'default_val', default: 'def' }
        },
        {
          type: 'text_input',
          id: 'default_val_second',
          props: { defaultValue: 'second_val', default: 'third_val' }
        },
        {
          type: 'checkbox',
          id: 'default_third',
          props: { default: true }
        }
      ]

      const values = extractInitialFormValues(components)
      expect(values).toEqual({
        val_first: 'explicit_val',
        default_val_second: 'second_val',
        default_third: true
      })
    })

    it('未提供显式初始值时，根据组件类型赋予安全初始默认值', () => {
      const components: A2UIComponent[] = [
        { type: 'text_input', id: 'text', props: {} },
        { type: 'textarea', id: 'desc', props: {} },
        { type: 'select', id: 'category', props: {} },
        { type: 'radio_group', id: 'role', props: {} },
        { type: 'date_picker', id: 'birthday', props: {} },
        { type: 'file_picker', id: 'attachment', props: {} },
        { type: 'checkbox', id: 'agree', props: {} },
        { type: 'multi_select', id: 'tags', props: {} },
        { type: 'number_input', id: 'count_no_min', props: {} },
        { type: 'number_input', id: 'count_with_min', props: { min: 10 } },
        { type: 'slider', id: 'volume_no_min', props: {} },
        { type: 'slider', id: 'volume_with_min', props: { min: 5 } }
      ]

      const values = extractInitialFormValues(components)
      expect(values).toEqual({
        text: '',
        desc: '',
        category: '',
        role: '',
        birthday: '',
        attachment: '',
        agree: false,
        tags: [],
        count_no_min: 0,
        count_with_min: 10,
        volume_no_min: 0,
        volume_with_min: 5
      })
    })

    it('递归遍历深层嵌套的容器布局组件（card, form, grid, accordion, tabs）', () => {
      const components: A2UIComponent[] = [
        {
          type: 'form',
          id: 'root-form',
          props: {},
          children: [
            {
              type: 'card',
              id: 'card-1',
              props: {},
              children: [
                {
                  type: 'grid',
                  id: 'grid-1',
                  props: {},
                  children: [
                    {
                      type: 'text_input',
                      id: 'nested_name',
                      props: { label: '姓名', value: '张三' }
                    },
                    {
                      type: 'number_input',
                      id: 'nested_age',
                      props: { label: '年龄', default: 18 }
                    }
                  ]
                }
              ]
            },
            {
              type: 'accordion',
              id: 'acc-1',
              props: { title: '高级选项' },
              children: [
                {
                  type: 'checkbox',
                  id: 'deep_opt_in',
                  props: { label: '订阅更新', default: true }
                }
              ]
            }
          ]
        }
      ]

      const values = extractInitialFormValues(components)
      expect(values).toEqual({
        nested_name: '张三',
        nested_age: 18,
        deep_opt_in: true
      })
      expect(values['root-form']).toBeUndefined()
      expect(values['card-1']).toBeUndefined()
      expect(values['grid-1']).toBeUndefined()
      expect(values['acc-1']).toBeUndefined()
    })
  })
})

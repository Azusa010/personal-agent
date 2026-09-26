import { describe, it, expect } from 'vitest'
import type { UserMemoryCard, UserMemoryNote } from '@personal-agent/protocol'
import {
  WORKING_MEMORY_HEADER,
  WORKING_MEMORY_FOOTER,
  formatSingleMemoryLine,
  formatSingleNoteLine,
  deduplicateLatestMemories,
  formatActiveMemoriesForPrompt,
  formatDualTierMemoriesForPrompt,
  allocateMemoryContextBudget,
  detectUserAsCodeAlerts,
  assembleWorkingMemoryPrompt,
  passportExpiryRule,
  type UserRuleStrategy
} from './memory-context'

function createFakeCard(overrides: Partial<UserMemoryCard>): UserMemoryCard {
  return {
    entryFormat: overrides.entryFormat || 'card',
    id: overrides.id || '11111111-2222-3333-4444-555555555555',
    memoryType: overrides.memoryType || 'semantic',
    category: overrides.category || 'preference',
    subject: overrides.subject || '测试主题',
    person: overrides.person ?? '本人',
    relationship: overrides.relationship ?? '本人',
    content: overrides.content || { note: '默认测试事实' },
    validFrom: overrides.validFrom || '2026-09-25T00:00:00.000Z',
    createdAt: overrides.createdAt || '2026-09-25T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-09-25T00:00:00.000Z',
    confidence: overrides.confidence ?? 1.0,
    accessCount: overrides.accessCount ?? 0,
    isSanitized: overrides.isSanitized ?? false,
    ...overrides
  }
}

describe('memory-context：事实单行格式化与时效去重', () => {
  it('formatSingleMemoryLine 格式化包含分类标签与主题', () => {
    const card = createFakeCard({
      category: 'preference',
      subject: '咖啡偏好',
      content: { favorite: 'latte', sugar: false }
    })
    const line = formatSingleMemoryLine(card)
    expect(line).toContain('[个人偏好]')
    expect(line).toContain('咖啡偏好')
    expect(line).toContain('latte')
  })

  it('deduplicateLatestMemories：Mem0 v3 纯追加事实消歧，同一实体与主题优先保留最新', () => {
    const oldCard = createFakeCard({
      id: 'old-card',
      subject: '居住地',
      content: { city: '北京' },
      occurredAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    const newCard = createFakeCard({
      id: 'new-card',
      subject: '居住地',
      content: { city: '上海' },
      occurredAt: '2026-09-20T00:00:00.000Z',
      createdAt: '2026-09-20T00:00:00.000Z'
    })
    const otherPersonCard = createFakeCard({
      id: 'parent-card',
      person: '父亲',
      relationship: '父亲',
      subject: '居住地',
      content: { city: '广州' },
      occurredAt: '2026-09-01T00:00:00.000Z'
    })

    const deduped = deduplicateLatestMemories([oldCard, newCard, otherPersonCard])

    expect(deduped).toHaveLength(2)
    const myHome = deduped.find((c) => c.person === '本人')
    expect(myHome?.id).toBe('new-card')
    expect(myHome?.content).toEqual({ city: '上海' })

    const parentHome = deduped.find((c) => c.person === '父亲')
    expect(parentHome?.content).toEqual({ city: '广州' })
  })
})

describe('memory-context：formatActiveMemoriesForPrompt 配额与预算', () => {
  it('空记忆列表返回空串', () => {
    expect(formatActiveMemoriesForPrompt([])).toBe('')
  })

  it('格式化包含常驻隔离标头与结尾标头', () => {
    const card = createFakeCard({ subject: '语言偏好', content: { lang: 'zh-CN' } })
    const res = formatActiveMemoriesForPrompt([card])
    expect(res).toContain(WORKING_MEMORY_HEADER)
    expect(res).toContain(WORKING_MEMORY_FOOTER)
    expect(res).toContain('语言偏好')
  })
})

describe('memory-context：detectUserAsCodeAlerts (主动服务与确定性预警)', () => {
  it('护照在 180 天内到期 -> 触发主动服务预警', () => {
    const fixedNow = new Date('2026-09-25T00:00:00.000Z')
    const passportCard = createFakeCard({
      category: 'general',
      subject: '用户护照有效截止期',
      content: { expiryDate: '2027-02-15' } // 距今约 143 天，不足 180 天
    })

    const alerts = detectUserAsCodeAlerts([passportCard], fixedNow)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('用户护照将于 2027-02-15 到期（不足 6 个月）')
    expect(alerts[0]).toContain('若涉及出境行程请主动提醒')
  })

  it('护照远期到期 (> 180 天) -> 不触发预警', () => {
    const fixedNow = new Date('2026-09-25T00:00:00.000Z')
    const passportCard = createFakeCard({
      category: 'general',
      subject: '用户护照有效截止期',
      content: { expiryDate: '2029-01-01' }
    })

    const alerts = detectUserAsCodeAlerts([passportCard], fixedNow)
    expect(alerts).toHaveLength(0)
  })

  it('花生过敏偏好 -> 触发饮食禁忌主动提示', () => {
    const allergyCard = createFakeCard({
      category: 'preference',
      subject: '重度花生过敏',
      content: { reaction: 'severe' }
    })

    const alerts = detectUserAsCodeAlerts([allergyCard])
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('过敏')
  })

  it('支持传入扩展的自定义规则策略', () => {
    const customRule: UserRuleStrategy = {
      name: 'vip_custom_rule',
      detect: (cards) => {
        return cards.some((c) => c.subject.includes('VIP')) ? '[系统自定义提示: VIP 用户]' : null
      }
    }
    const card = createFakeCard({ subject: 'VIP 会员卡' })
    const alerts = detectUserAsCodeAlerts([card], new Date(), [customRule, passportExpiryRule])
    expect(alerts).toContain('[系统自定义提示: VIP 用户]')
  })
})

describe('memory-context：assembleWorkingMemoryPrompt 完整装配', () => {
  it('同时存在常驻卡片与预警时，组装完整且段落清晰', () => {
    const fixedNow = new Date('2026-09-25T00:00:00.000Z')
    const prefCard = createFakeCard({ subject: '偏好代码语言', content: { lang: 'TypeScript' } })
    const passportCard = createFakeCard({
      category: 'general',
      subject: '护照截止时间',
      content: { date: '2027-01-10' }
    })

    const prompt = assembleWorkingMemoryPrompt([prefCard, passportCard], fixedNow)
    expect(prompt).toContain(WORKING_MEMORY_HEADER)
    expect(prompt).toContain('TypeScript')
    expect(prompt).toContain(WORKING_MEMORY_FOOTER)
    expect(prompt).toContain('[系统主动约束提示:')
  })
})

// ==============================================================================
// 陪练 TODO 5 验收测试：验证与质量断言
// ==============================================================================
describe('陪练 TODO(你填)[验证与质量]: memory-context 事实消歧与主动服务断言', () => {
  it('时效事实消歧：新事实完全压制旧事实', () => {
    const oldFact = createFakeCard({
      id: 'old-job',
      subject: '当前职业',
      content: { title: '中级工程师' },
      createdAt: '2025-01-01T00:00:00.000Z'
    })
    const newFact = createFakeCard({
      id: 'new-job',
      subject: '当前职业',
      content: { title: '主任架构师' },
      createdAt: '2026-09-01T00:00:00.000Z'
    })

    const prompt = assembleWorkingMemoryPrompt([oldFact, newFact])

    // 时效消歧断言：常驻提示词中必须包含新事实“主任架构师”，绝不能包含旧事实“中级工程师”
    expect(prompt).toContain('主任架构师')
    expect(prompt).not.toContain('中级工程师')
  })
})

function createFakeNote(overrides: Partial<UserMemoryNote>): UserMemoryNote {
  return {
    entryFormat: 'note',
    id: overrides.id || '22222222-3333-4444-5555-666666666666',
    title: overrides.title || '测试标题',
    noteText: overrides.noteText || '测试备忘内容段落',
    tags: overrides.tags || [],
    validFrom: overrides.validFrom || '2026-09-25T00:00:00.000Z',
    createdAt: overrides.createdAt || '2026-09-25T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-09-25T00:00:00.000Z',
    confidence: overrides.confidence ?? 0.8,
    accessCount: overrides.accessCount ?? 0,
    isSanitized: overrides.isSanitized ?? false,
    ...overrides
  }
}

describe('memory-context：allocateMemoryContextBudget 双轨配额截断器', () => {
  it('预算充裕时，全部 Cards 与 Notes 均被完整纳入', () => {
    const card = createFakeCard({ subject: '饮食偏好', content: { food: 'vegetarian' } })
    const note = createFakeNote({ title: '部署备忘', noteText: '使用 pnpm 启动应用' })

    const { selectedCards, selectedNotes } = allocateMemoryContextBudget([card], [note], 2000)
    expect(selectedCards).toHaveLength(1)
    expect(selectedNotes).toHaveLength(1)
    expect(selectedCards[0].subject).toBe('饮食偏好')
    expect(selectedNotes[0].title).toBe('部署备忘')
  })

  it('Card 数量过多时，受 70% 预算上限约束，剩余 30% 保障 Note 空间', () => {
    const cards = Array.from({ length: 10 }, (_, i) =>
      createFakeCard({
        id: `card-${i}`,
        subject: `用户重要核心约束规则编号${i}`,
        content: { rule: `必须严格遵循第${i}项安全约束条件，不得违规执行任何破坏性操作` }
      })
    )
    const note = createFakeNote({
      title: '排查记录',
      noteText: '测试服务正常运行无异常情况发生。'
    })

    // 总预算 500 字符，Card 最多占用 Math.floor(500 * 0.7) = 350 字符
    const { selectedCards, selectedNotes } = allocateMemoryContextBudget(cards, [note], 500)

    let cardsChars = 0
    for (const c of selectedCards) {
      cardsChars += formatSingleMemoryLine(c).length + 1
    }
    expect(cardsChars).toBeLessThanOrEqual(350)
    expect(selectedNotes).toHaveLength(1)
  })

  it('Card 占用不足 70% 时，剩余配额自动动态流向 Note', () => {
    const shortCard = createFakeCard({ subject: '偏好', content: { a: 1 } })
    const notes = Array.from({ length: 5 }, (_, i) =>
      createFakeNote({
        id: `note-${i}`,
        title: `备忘${i}`,
        noteText: `这是一条用于测试动态额度流转的长备忘内容第${i}条`,
        createdAt: `2026-09-0${i + 1}T00:00:00.000Z`
      })
    )

    // 总预算 400 字符。若 Note 只有严格的 30% (120字符)，只能装 1~2 条。
    // 但因为 Card 仅占用约 30 字符，剩余 ~370 字符全部流向 Note，Note 应能装下 3 条以上！
    const { selectedCards, selectedNotes } = allocateMemoryContextBudget([shortCard], notes, 400)
    expect(selectedCards).toHaveLength(1)
    expect(selectedNotes.length).toBeGreaterThanOrEqual(3)
  })

  it('Note 按时间逆序选择：最新条目优先保留', () => {
    const oldNote = createFakeNote({
      id: 'old-note',
      title: '老备忘',
      noteText: '2026年1月记录的老旧配置流水内容',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    const midNote = createFakeNote({
      id: 'mid-note',
      title: '中期备忘',
      noteText: '2026年5月记录的中期配置流水内容',
      createdAt: '2026-05-01T00:00:00.000Z'
    })
    const newNote = createFakeNote({
      id: 'new-note',
      title: '最新备忘',
      noteText: '2026年9月记录的最新排查关键流水内容',
      createdAt: '2026-09-20T00:00:00.000Z'
    })

    const sampleLineLen = formatSingleNoteLine(newNote).length + 1
    const maxChars = Math.floor(sampleLineLen * 2.5)

    const { selectedNotes } = allocateMemoryContextBudget([], [oldNote, midNote, newNote], maxChars)
    expect(selectedNotes).toHaveLength(2)
    expect(selectedNotes[0].id).toBe('new-note')
    expect(selectedNotes[1].id).toBe('mid-note')
  })

  it('formatDualTierMemoriesForPrompt 组合双轨段落格式输出', () => {
    const card = createFakeCard({ subject: '代码风格', content: { semi: false } })
    const note = createFakeNote({ title: '依赖版本', noteText: 'Node 22 LTS' })

    const prompt = formatDualTierMemoriesForPrompt([card], [note])
    expect(prompt).toContain(WORKING_MEMORY_HEADER)
    expect(prompt).toContain('【核心偏好与事实】')
    expect(prompt).toContain('代码风格')
    expect(prompt).toContain('【近期任务备忘与经验】')
    expect(prompt).toContain('依赖版本')
    expect(prompt).toContain(WORKING_MEMORY_FOOTER)
  })

  it('assembleWorkingMemoryPrompt 支持传入双轨 notes 并组装', () => {
    const card = createFakeCard({ subject: '编辑器偏好', content: { name: 'VSCode' } })
    const note = createFakeNote({ title: '启动命令', noteText: 'pnpm dev' })

    const prompt = assembleWorkingMemoryPrompt([card], { notes: [note] })
    expect(prompt).toContain('编辑器偏好')
    expect(prompt).toContain('启动命令')
    expect(prompt).toContain('【核心偏好与事实】')
    expect(prompt).toContain('【近期任务备忘与经验】')
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import { openProductState, migrate, MEMORY_DB, type SqliteDatabase } from './database'
import { SqliteTaskRepository } from './task-repository'
import { SqlitePlanRepository, type PlanStep } from './plan-repository'

const T = '2026-09-08T00:00:00Z'

let db: SqliteDatabase | null = null

afterEach(() => {
  db?.close()
  db = null
})

function makeRepos(): { d: SqliteDatabase; plans: SqlitePlanRepository } {
  const d = openProductState(MEMORY_DB)
  db = d // const 窄化不受闭包影响，后续都用 d
  migrate(d)
  new SqliteTaskRepository(d).insert({
    id: 't-1',
    goal: '整理下载目录的 PDF',
    status: 'pending',
    createdAt: T,
    updatedAt: T
  })
  return { d, plans: new SqlitePlanRepository(d) }
}

/** plans.task_id 有外键，必须先有 task 才能插 plan */
function addTask(d: SqliteDatabase, id: string): void {
  d.prepare(
    `INSERT INTO tasks (id, goal, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)`
  ).run(id, `目标 ${id}`, T, T)
}

describe('SqlitePlanRepository', () => {
  it('首个版本 version=1，返回完整 record', () => {
    const { plans } = makeRepos()
    const steps: PlanStep[] = [
      { description: '列出 Downloads 下的 PDF', capability: 'filesystem.list' }
    ]

    const saved = plans.append({ id: 'p-1', taskId: 't-1', steps, createdAt: T })

    expect(saved.version).toBe(1)
    expect(saved.id).toBe('p-1')
    expect(saved.taskId).toBe('t-1')
    expect(saved.steps).toEqual(steps)
  })

  it('连续 append 版本递增 1,2,3；绕过 repository 插撞号被 UNIQUE 拒', () => {
    const { d, plans } = makeRepos()

    for (let i = 1; i <= 3; i++) {
      const saved = plans.append({
        id: `p-${i}`,
        taskId: 't-1',
        steps: [{ description: `第 ${i} 版计划` }],
        createdAt: T
      })
      expect(saved.version).toBe(i)
    }
    expect(plans.findAllVersions('t-1').map((p) => p.version)).toEqual([1, 2, 3])

    // 双保险：UNIQUE(task_id, version) 真的在库里生效
    expect(() =>
      d
        .prepare(
          `INSERT INTO plans (id, task_id, version, steps, created_at) VALUES ('x', 't-1', 2, '[]', ?)`
        )
        .run(T)
    ).toThrow(/UNIQUE constraint failed/)
  })

  it('findLatest 返回最高版本；没有 plan 的 task 返回 null 而非抛错', () => {
    const { d, plans } = makeRepos()
    plans.append({ id: 'p-1', taskId: 't-1', steps: [{ description: '旧版' }], createdAt: T })
    plans.append({ id: 'p-2', taskId: 't-1', steps: [{ description: '新版' }], createdAt: T })

    const latest = plans.findLatest('t-1')
    expect(latest?.version).toBe(2)
    expect(latest?.steps[0]?.description).toBe('新版')

    addTask(d, 't-2') // task 存在但没有 plan
    expect(plans.findLatest('t-2')).toBeNull()
    expect(plans.findAllVersions('t-2')).toEqual([])
    expect(plans.findLatest('压根不存在的 task')).toBeNull()
  })

  it('steps 走 JSON 往返：中文、可选 capability、空数组都保真', () => {
    const { plans } = makeRepos()
    const steps: PlanStep[] = [
      { description: '列出下载目录的 PDF', capability: 'filesystem.list' },
      { description: '提取每个 PDF 的页面文本', capability: 'document.extract_pdf' },
      { description: '汇总成带页码引用的摘要' } // 故意不给 capability
    ]
    plans.append({ id: 'p-1', taskId: 't-1', steps, createdAt: T })
    plans.append({ id: 'p-2', taskId: 't-1', steps: [], createdAt: T })

    // 空数组不能被存成 null 或丢掉
    expect(plans.findLatest('t-1')?.steps).toEqual([])

    const first = plans.findAllVersions('t-1')[0]
    expect(first?.steps).toEqual(steps)
    expect(first?.steps[2]?.capability).toBeUndefined()
  })

  it('外键：task 不存在时 append 被拒，不会留下孤儿 plan', () => {
    const { plans } = makeRepos()

    expect(() =>
      plans.append({ id: 'p-x', taskId: '没这个 task', steps: [], createdAt: T })
    ).toThrow(/FOREIGN KEY constraint failed/)

    expect(plans.findAllVersions('没这个 task')).toEqual([])
  })

  it('版本号按 task 独立计数，互不影响', () => {
    const { d, plans } = makeRepos()
    addTask(d, 't-2')

    expect(plans.append({ id: 'p-1', taskId: 't-1', steps: [], createdAt: T }).version).toBe(1)
    expect(plans.append({ id: 'p-2', taskId: 't-1', steps: [], createdAt: T }).version).toBe(2)
    // t-2 必须从 1 重新开始，而不是接着 t-1 涨到 3
    // 这条钉住 NEXT_VERSION_SQL 里的 WHERE task_id = ?，漏了就串号
    expect(plans.append({ id: 'p-3', taskId: 't-2', steps: [], createdAt: T }).version).toBe(1)
    expect(plans.findAllVersions('t-1').map((p) => p.version)).toEqual([1, 2])
  })
})

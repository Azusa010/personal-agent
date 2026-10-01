import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { auditExpectedValues } from '../../../src/main/capabilities/plugins/audit'

describe('auditExpectedValues 双层审计逻辑（TASK-C2）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('预期值与实际值完全一致：hasMismatch 为 false，不打告警日志', () => {
    const expectations = {
      expected_source_exists: true,
      expected_source_is_file: true,
      expected_target_dir_exists: true
    }
    const actuals = {
      expected_source_exists: true,
      expected_source_is_file: true,
      expected_target_dir_exists: true
    }

    const result = auditExpectedValues('call-101', 'filesystem_move', expectations, actuals)

    expect(result.hasMismatch).toBe(false)
    expect(result.mismatches).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('单项预期不一致：准确记录 mismatch 项并输出告警日志', () => {
    const expectations = {
      expected_parent_exists: true
    }
    const actuals = {
      expected_parent_exists: false
    }

    const result = auditExpectedValues('call-102', 'filesystem_create_dir', expectations, actuals)

    expect(result.hasMismatch).toBe(true)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]).toEqual({
      field: 'expected_parent_exists',
      expected: true,
      actual: false
    })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logMessage = warnSpy.mock.calls[0].join(' ')
    expect(logMessage).toContain('[AUDIT_MISMATCH]')
    expect(logMessage).toContain('call-102')
    expect(logMessage).toContain('filesystem_create_dir')
    expect(logMessage).toContain('expected_parent_exists')
  })

  it('多项预期不一致：完整收集所有 mismatch 项并多次触发告警', () => {
    const expectations = {
      expected_file_line_count: 50,
      expected_old_string_line: 12
    }
    const actuals = {
      expected_file_line_count: 40,
      expected_old_string_line: 15
    }

    const result = auditExpectedValues('call-103', 'file_edit', expectations, actuals)

    expect(result.hasMismatch).toBe(true)
    expect(result.mismatches).toHaveLength(2)
    expect(result.mismatches).toEqual([
      { field: 'expected_file_line_count', expected: 50, actual: 40 },
      { field: 'expected_old_string_line', expected: 12, actual: 15 }
    ])
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  it('未声明的预期（undefined 或 null）自动忽略：不比对且不记录 mismatch', () => {
    const expectations = {
      expected_file_exists: undefined,
      expected_no_duplicate: null
    }
    const actuals = {
      expected_file_exists: true,
      expected_no_duplicate: true
    }

    const result = auditExpectedValues('call-104', 'file_write', expectations, actuals)

    expect(result.hasMismatch).toBe(false)
    expect(result.mismatches).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('实际值字典中多出的未预期字段不影响审计', () => {
    const expectations = {
      expected_cwd_exists: true
    }
    const actuals = {
      expected_cwd_exists: true,
      extra_unrelated_field: 'something'
    }

    const result = auditExpectedValues('call-105', 'terminal_execute', expectations, actuals)

    expect(result.hasMismatch).toBe(false)
    expect(result.mismatches).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('声明了预期但实际值缺失（undefined）：判定为 mismatch', () => {
    const expectations = {
      expected_article_exists: true
    }
    const actuals = {}

    const result = auditExpectedValues('call-106', 'viking_write_l2', expectations, actuals)

    expect(result.hasMismatch).toBe(true)
    expect(result.mismatches).toEqual([
      {
        field: 'expected_article_exists',
        expected: true,
        actual: undefined
      }
    ])
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('严格全等性判定：类型不符（如 0 与 false、"1" 与 1）判定为 mismatch', () => {
    const expectations = {
      flag: false,
      count: 1
    }
    const actuals = {
      flag: 0,
      count: '1'
    }

    const result = auditExpectedValues('call-107', 'custom_tool', expectations, actuals)

    expect(result.hasMismatch).toBe(true)
    expect(result.mismatches).toHaveLength(2)
  })
})

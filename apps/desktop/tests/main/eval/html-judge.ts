export interface Check {
  data?: {
    text: string
    filtered?: string
    title?: string
    date?: string
    hasChart?: boolean
    missing: string[]
  }
  submissions?: unknown[]
  errors?: string[]
  error?: string
}

export function infrastructureFailure(value: unknown): boolean {
  return /insufficient.balance|insufficient_balance_error|error code:\s*(401|402|403|429|5\d\d)/i.test(
    JSON.stringify(value) ?? ''
  )
}

export function failures(id: string, check: Check): string[] {
  const out: string[] = []
  if (check.error) out.push(`页面加载失败: ${check.error}`)
  if (!check.data) return [...out, '没有页面检查结果']
  if (check.data.missing.length) out.push(`缺少控件: ${check.data.missing.join(', ')}`)
  if (check.errors?.length) out.push(`运行错误: ${check.errors.join('; ')}`)
  const submitted = check.submissions?.[0] as Record<string, unknown> | undefined
  if (id === 'reminder-form') {
    if (check.data.title !== '提交周报' || check.data.date !== '2026-12-18')
      out.push('已知提醒信息不正确')
    if (
      submitted?.title !== '提交周报' ||
      submitted?.date !== '2026-12-18' ||
      submitted?.time !== '09:30'
    )
      out.push('提交值不正确')
  } else if (id === 'csv-chart') {
    if (!check.data.hasChart) out.push('未找到图表')
    if (!check.data.text.includes('sales.csv')) out.push('缺少来源')
    if (!['120', '75', '95', '130'].every((v) => check.data?.text.includes(v)))
      out.push('初始图表数据不完整')
    if (!['120', '95', '215'].every((v) => (check.data?.filtered ?? '').includes(v)))
      out.push('筛选后的数值或合计不正确')
    if (/\b75\b|\b130\b/.test(check.data.filtered ?? '')) out.push('筛选包含其他地区')
  } else {
    if (
      !['本地备份', '云备份', '混合备份', '10', '25', '40'].every((v) =>
        check.data?.text.includes(v)
      )
    )
      out.push('方案内容不完整')
    if (submitted?.choice !== 'B') out.push('选择结果不正确')
  }
  return out
}

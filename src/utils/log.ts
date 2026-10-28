/** 操作日志的分级：供日志面板突出运维关注的操作 */

export type LogSeverity = 'danger' | 'change' | 'normal'

export const SEVERITY_LABEL: Record<LogSeverity, string> = {
  danger: '删除',
  change: '变更',
  normal: '常规',
}

/**
 * 按操作名与详情判定级别。
 *
 * 刻意用关键词匹配而非枚举全部操作名 —— 后续新增操作（如"批量删除键"）
 * 只要动词命中就能自动归位，不需要同步维护一张映射表。
 */
export function logSeverity(action: string, detail = ''): LogSeverity {
  const text = action ?? ''

  // 删除是最需要追责与复核的动作，单独列为最高级
  if (text.includes('删除')) return 'danger'

  // 命令行里执行的清库操作，风险等级与"删除键"同级
  const payload = (detail ?? '').toUpperCase()
  if (payload.includes('FLUSHALL') || payload.includes('FLUSHDB') || payload.includes('SHUTDOWN')) {
    return 'danger'
  }

  // 会改变数据或配置的操作
  if (
    text.includes('写入') ||
    text.includes('编辑') ||
    text.includes('新建') ||
    text.includes('创建') ||
    text.includes('重命名') ||
    text.includes('TTL') ||
    text.includes('保存')
  ) {
    return 'change'
  }

  return 'normal'
}

/** 是否属于「变更类」操作（含删除），用于「仅看变更」过滤 */
export function isMutation(action: string, detail = ''): boolean {
  return logSeverity(action, detail) !== 'normal'
}

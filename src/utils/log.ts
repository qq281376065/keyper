/** 操作日志的分级：供日志面板突出运维关注的操作 */
import type { MsgKey } from '@shared/i18n'

export type LogSeverity = 'danger' | 'change' | 'normal'

export const SEVERITY_LABEL: Record<LogSeverity, MsgKey> = {
  danger: 'common.delete',
  change: 'logPanel.changes',
  normal: 'log.general',
}

/**
 * 日志文件里的操作名保持中文原文入库（见 electron/ipc/index.ts 的 LOG_ACTIONS）：
 * 它同时承担筛选与 grep 的稳定标识，不随界面语言变化。
 * 展示时才按这张表换成语义 key，历史日志与当前界面语言互不影响。
 */
const ACTION_KEYS: Record<string, MsgKey> = {
  建立连接: 'connectionActions.connect',
  断开连接: 'connectionActions.disconnect',
  保存配置: 'ipc.saveSettings',
  删除配置: 'ipc.deleteConfig',
  写入键: 'ipc.writeKey',
  新建键: 'common.newKey',
  删除键: 'common.deleteKey',
  '设置 TTL': 'common.setTtl',
  重命名键: 'common.renameKey',
  删除字段: 'common.deleteField',
  修改字段: 'editHashFieldDialog.editField',
  '修改字段 TTL': 'ipc.editFieldTtl',
  修改元素: 'ipc.editElement',
  删除元素: 'ipc.deleteElement',
  插入元素: 'ipc.insertElement',
  追加元素: 'ipc.appendElement',
  修改成员: 'common.editMember',
  删除成员: 'common.deleteMember',
  新增成员: 'common.addMember',
  追加消息: 'streamAddEntryDialog.appendMessage',
  命令: 'slowlogCard.command',
  清空数据: 'ipc.clearData',
}

/** 取操作名对应的文案 key；未知操作返回 null，界面原样展示 */
export function logActionKey(action: string): MsgKey | null {
  return ACTION_KEYS[action] ?? null
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

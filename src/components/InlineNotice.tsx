import type { ReactNode } from 'react'
import { DialogIcon, type DialogIconName } from '@/components/DialogIcon'

export type NoticeTone = 'warn' | 'danger' | 'success'

const TONE_ICONS: Record<NoticeTone, DialogIconName> = {
  warn: 'warning',
  danger: 'warning',
  success: 'check',
}

/**
 * 行内提示条：警告、错误、成功共用。
 *
 * 警告与成功用 status（读屏会等待当前朗读结束），错误用 alert（立即打断），
 * 避免一个校验失败就把整段表单描述重复念一遍。
 */
export function InlineNotice({
  tone,
  children,
  icon,
}: {
  tone: NoticeTone
  children: ReactNode
  icon?: DialogIconName
}) {
  return (
    <div
      className={`inline-notice inline-notice-${tone}`}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <DialogIcon name={icon ?? TONE_ICONS[tone]} size={13} />
      <span>{children}</span>
    </div>
  )
}

export default InlineNotice

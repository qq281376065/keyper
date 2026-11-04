import type { ReactNode } from 'react'
import { useTtlClock } from '@/hooks/useTtlClock'
import { t } from '@/i18n'
import { formatTtl, remainingTtl, ttlTone } from '@/utils/format'

export interface LiveTtlProps {
  ttl: number
  /** 渲染层在收到键元信息时打的时间戳；缺失时退化为静态展示 */
  ttlAt?: number
  className?: string
  as?: 'span' | 'b'
  /** 即将过期时追加的提示内容（值区悬停卡的胶囊） */
  urgentChip?: ReactNode
}

/** 每秒递减的 TTL 文本；只有它订阅时钟，避免列表整体重渲染 */
export function LiveTtl({ ttl, ttlAt, className = '', as = 'span', urgentChip }: LiveTtlProps) {
  const now = useTtlClock()
  const remaining = ttlAt == null ? ttl : remainingTtl(ttl, ttlAt, now)
  const text = remaining === 0 ? t('ttl.expired') : formatTtl(remaining)
  const classes = `${className} ${ttlTone(remaining)}`.trim()

  if (as === 'b') {
    return (
      <b className={classes}>
        {text}
        {ttlTone(remaining) === 'urgent' ? urgentChip : null}
      </b>
    )
  }
  return <span className={classes}>{text}</span>
}

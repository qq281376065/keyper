import type { ReactNode } from 'react'

export type TagTone = 'neutral' | 'accent' | 'warn' | 'danger' | 'success'

/** 小型状态标签：预览列表、摘要卡片共用一套胶囊规格 */
export function Tag({ tone = 'neutral', children }: { tone?: TagTone; children: ReactNode }) {
  return <span className={`ui-tag ui-tag-${tone}`}>{children}</span>
}

export default Tag

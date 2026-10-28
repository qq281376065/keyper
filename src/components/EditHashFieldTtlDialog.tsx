import { useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useDialogDrag } from '@/hooks/useDialogDrag'
import { useRedis } from '@/store/useRedis'
import { formatTtl } from '@/utils/format'

/** 预设档位，与键级 TTL 保持一致的交互习惯 */
const PRESETS = [
  { label: '1 分钟', value: 60 },
  { label: '5 分钟', value: 300 },
  { label: '30 分钟', value: 1800 },
  { label: '1 小时', value: 3600 },
  { label: '1 天', value: 86400 },
  { label: '7 天', value: 604800 },
]

export interface EditHashFieldTtlDialogProps {
  keyName: string
  field: string
  /** 当前 TTL：-1 永久、-2 不存在、正数为剩余秒数 */
  currentTtl: number
  onClose: () => void
  onSaved: () => void
}

/**
 * 设置 hash 单个字段的 TTL。
 * 仅在服务端支持字段级过期（Redis 7.4+）时由上层挂载。
 */
export function EditHashFieldTtlDialog({
  keyName,
  field,
  currentTtl,
  onClose,
  onSaved,
}: EditHashFieldTtlDialogProps) {
  const { state, notify } = useRedis()
  const [draft, setDraft] = useState(currentTtl > 0 ? String(currentTtl) : '')
  const [saving, setSaving] = useState(false)
  const { style, onDragStart } = useDialogDrag()

  /* String() 归一：数字输入框可能给出数字，数字值上 .trim() 会炸渲染 */
  const draftText = String(draft ?? '')
  const currentLabel = formatTtl(currentTtl)
  /** 输入为空或 0 表示清除过期时间（HPERSIST） */
  const willPersist = !draftText.trim() || Number(draftText) <= 0

  async function submit(): Promise<void> {
    const id = state.activeId
    if (!id) return

    const raw = draftText.trim()
    const seconds = raw ? Number(raw) : 0
    if (Number.isNaN(seconds)) {
      notify('err', 'TTL 需为数字（秒）')
      return
    }

    setSaving(true)
    try {
      const res = await api.redis.setHashFieldTtl(id, keyName, field, seconds)
      if (!res.ok) {
        notify('err', res.error)
        return
      }
      if (!res.data.ok) {
        notify('err', res.data.message ?? '设置失败')
        return
      }
      notify('ok', res.data.message ?? '已更新')
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mask s-edit-hash-field-ttl-dialog">
      <div className="dialog" style={style}>
        <header className="dialog-head" onMouseDown={onDragStart}>
          <span>设置字段 TTL</span>
          <span className="spacer" />
          <button className="btn-ghost tiny" onClick={onClose}>
            <DialogIcon name="cancel" size={12} />
          </button>
        </header>

        <div className="dialog-body">
          <div className="target">
            <div className="target-row">
              <span className="k">键</span>
              <span className="v mono ellipsis" {...tipProps(keyName)}>
                {keyName}
              </span>
            </div>
            <div className="target-row">
              <span className="k">字段</span>
              <span className="v mono ellipsis" {...tipProps(field)}>
                {field}
              </span>
            </div>
            <div className="target-row">
              <span className="k">当前</span>
              <span className={`v mono${currentTtl > 0 && currentTtl <= 60 ? ' urgent' : ''}`}>{currentLabel}</span>
            </div>
          </div>

          <label className="field">
            <span className="label">新的 TTL（秒）</span>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="mono"
              inputMode="numeric"
              min="0"
              placeholder="留空 = 永久"
            />
          </label>

          <div className="presets">
            <span className="presets-label">常用值</span>
            {PRESETS.map((item) => (
              <button
                key={item.value}
                className={`preset${Number(draft) === item.value ? ' on' : ''}`}
                onClick={() => setDraft(String(item.value))}
              >
                {item.label}
              </button>
            ))}
            <button className={`preset${willPersist ? ' on' : ''}`} onClick={() => setDraft('')}>
              永久
            </button>
          </div>

          <p className={`note${willPersist ? ' persist' : ''}`}>
            {willPersist ? (
              <>将清除该字段的过期时间，使其成为永久字段（HPERSIST）。</>
            ) : (
              <>
                到期后 Redis 会自动从 hash 中移除该字段。<b>注意</b>：字段级 TTL 需要 Redis 7.4 及以上版本。
              </>
            )}
          </p>
        </div>

        <footer className="dialog-foot">
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            <DialogIcon name="cancel" />
            取消
          </button>
          <button className="btn-primary btn" disabled={saving} onClick={() => void submit()}>
            <DialogIcon name="save" />
            {saving ? '保存中…' : willPersist ? '设为永久' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default EditHashFieldTtlDialog

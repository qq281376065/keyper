import { useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { DialogShell } from '@/components/DialogShell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useI18n } from '@/i18n'
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
  const { t } = useI18n()
  const [draft, setDraft] = useState(currentTtl > 0 ? String(currentTtl) : '')
  const [saving, setSaving] = useState(false)

  /* String() 归一：数字输入框可能给出数字，数字值上 .trim() 会炸渲染 */
  const draftText = String(draft ?? '')
  const currentLabel = t(formatTtl(currentTtl))
  /** 输入为空或 0 表示清除过期时间（HPERSIST） */
  const willPersist = !draftText.trim() || Number(draftText) <= 0

  async function submit(): Promise<void> {
    const id = state.activeId
    if (!id) return

    const raw = draftText.trim()
    const seconds = raw ? Number(raw) : 0
    if (Number.isNaN(seconds)) {
      notify('err', t('TTL 需为数字（秒）'))
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
        notify('err', res.data.message ?? t('设置失败'))
        return
      }
      notify('ok', res.data.message ?? t('已更新'))
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogShell
      icon="clock"
      title={t('设置字段 TTL')}
      description={t('字段级过期需要 Redis 7.4 及以上版本')}
      badge={<span className="dlg-badge mono">hash</span>}
      className="edit-hash-field-ttl-dialog"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={onClose}>
            <DialogIcon name="cancel" size={13} />
            {t('取消')}
          </Button>
          <Button
            type="button"
            className="foot-btn foot-primary"
            disabled={saving}
            onClick={() => void submit()}
          >
            <DialogIcon name="save" size={13} />
            {saving ? t('保存中…') : willPersist ? t('设为永久') : t('保存')}
          </Button>
        </>
      }
    >
      {/* 目标信息：键 / 字段 / 当前 TTL。三行只读，让用户在改之前核对对象 */}
      <div className="target">
        <div className="target-row">
          <span className="k">{t('键')}</span>
          <span className="v mono ellipsis" title={keyName}>
            {keyName}
          </span>
        </div>
        <div className="target-row">
          <span className="k">{t('字段')}</span>
          <span className="v mono ellipsis" title={field}>
            {field}
          </span>
        </div>
        <div className="target-row">
          <span className="k">{t('当前')}</span>
          <span className={`v mono${currentTtl > 0 && currentTtl <= 60 ? ' urgent' : ''}`}>{currentLabel}</span>
        </div>
      </div>

      <div className="field">
        <Label htmlFor="ehfttl-input" className="field-label">
          {t('新的 TTL（秒）')}
        </Label>
        <Input
          id="ehfttl-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="mono"
          inputMode="numeric"
          min="0"
          placeholder={t('留空 = 永久')}
          autoFocus
        />
      </div>

      {/* 常用值：胶囊按钮组，一键填入 */}
      <div className="presets">
        <span className="presets-label">{t('常用值')}</span>
        {PRESETS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={`preset${Number(draft) === item.value ? ' on' : ''}`}
            onClick={() => setDraft(String(item.value))}
          >
            {t(item.label)}
          </button>
        ))}
        <button type="button" className={`preset${willPersist ? ' on' : ''}`} onClick={() => setDraft('')}>
          {t('永久')}
        </button>
      </div>

      {/* 结果说明：设为永久 vs 到期自动移除，用同一套提示条表达 */}
      <div className={`dlg-alert${willPersist ? ' is-ok' : ''}`} role="status">
        <DialogIcon name={willPersist ? 'check' : 'info'} size={14} />
        <span>
          {willPersist ? (
            <>{t('将清除该字段的过期时间，使其成为永久字段（HPERSIST）。')}</>
          ) : (
            <>
              {t('到期后 Redis 会自动从 hash 中移除该字段。')}
              <b>{t('注意')}</b>
              {t('：字段级 TTL 需要 Redis 7.4 及以上版本。')}
            </>
          )}
        </span>
      </div>
    </DialogShell>
  )
}

export default EditHashFieldTtlDialog

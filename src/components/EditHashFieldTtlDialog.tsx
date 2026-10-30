import { useState } from 'react'
import { tipProps } from '@/components/tip'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { DialogShell } from '@/components/DialogShell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useI18n } from '@/i18n'
import { useRedis } from '@/store/useRedis'
import { formatTtl } from '@/utils/format'
import type { MsgKey } from '@shared/i18n'

/** 预设档位，与键级 TTL 保持一致的交互习惯 */
const PRESETS: Array<{ label: MsgKey; value: number }> = [
  { label: 'common.oneMinute', value: 60 },
  { label: 'common.fiveMinutes', value: 300 },
  { label: 'common.thirtyMinutes', value: 1800 },
  { label: 'common.oneHour', value: 3600 },
  { label: 'common.oneDay', value: 86400 },
  { label: 'common.sevenDays', value: 604800 },
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
  const currentLabel = formatTtl(currentTtl)
  /** 输入为空或 0 表示清除过期时间（HPERSIST） */
  const willPersist = !draftText.trim() || Number(draftText) <= 0

  async function submit(): Promise<void> {
    const id = state.activeId
    if (!id) return

    const raw = draftText.trim()
    const seconds = raw ? Number(raw) : 0
    if (Number.isNaN(seconds)) {
      notify('err', t('editHashFieldTtlDialog.ttlNumber'))
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
        notify('err', res.data.message ?? t('editHashFieldTtlDialog.applyFailed'))
        return
      }
      notify('ok', res.data.message ?? t('editHashFieldTtlDialog.updated'))
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogShell
      icon="clock"
      title={t('editHashFieldTtlDialog.setFieldTtl')}
      description={t('editHashFieldTtlDialog.fieldLevelExpiration')}
      badge={<span className="dlg-badge mono">hash</span>}
      className="edit-hash-field-ttl-dialog"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={onClose}>
            <DialogIcon name="cancel" size={13} />
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            className="foot-btn foot-primary"
            disabled={saving}
            onClick={() => void submit()}
          >
            <DialogIcon name="save" size={13} />
            {saving ? t('common.saving') : willPersist ? t('editHashFieldTtlDialog.setNoExpiration') : t('common.save')}
          </Button>
        </>
      }
    >
      {/* 目标信息：键 / 字段 / 当前 TTL。三行只读，让用户在改之前核对对象 */}
      <div className="target">
        <div className="target-row">
          <span className="k">{t('editHashFieldTtlDialog.key')}</span>
          <span className="v mono ellipsis" {...tipProps(keyName)}>
            {keyName}
          </span>
        </div>
        <div className="target-row">
          <span className="k">{t('common.field')}</span>
          <span className="v mono ellipsis" {...tipProps(field)}>
            {field}
          </span>
        </div>
        <div className="target-row">
          <span className="k">{t('editHashFieldTtlDialog.current')}</span>
          <span className={`v mono${currentTtl > 0 && currentTtl <= 60 ? ' urgent' : ''}`}>{currentLabel}</span>
        </div>
      </div>

      <div className="field">
        <Label htmlFor="ehfttl-input" className="field-label">
          {t('editHashFieldTtlDialog.newTtl')}
        </Label>
        <Input
          id="ehfttl-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="mono"
          inputMode="numeric"
          min="0"
          placeholder={t('createKeyDialog.blankNoExpiration')}
          autoFocus
        />
      </div>

      {/* 常用值：胶囊按钮组，一键填入 */}
      <div className="presets">
        <span className="presets-label">{t('editHashFieldTtlDialog.commonValues')}</span>
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
          {t('common.noExpiration')}
        </button>
      </div>

      {/* 结果说明：设为永久 vs 到期自动移除，用同一套提示条表达 */}
      <div className={`dlg-alert${willPersist ? ' is-ok' : ''}`} role="status">
        <DialogIcon name={willPersist ? 'check' : 'info'} size={14} />
        <span>
          {willPersist ? (
            <>{t('editHashFieldTtlDialog.clearsFieldsExpiration')}</>
          ) : (
            <>
              {t('editHashFieldTtlDialog.whenExpiresRedisRemoves')}
              <b>{t('editHashFieldTtlDialog.note')}</b>
              {t('editHashFieldTtlDialog.fieldTtlRequiresRedis74')}
            </>
          )}
        </span>
      </div>
    </DialogShell>
  )
}

export default EditHashFieldTtlDialog

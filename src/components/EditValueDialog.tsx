import { useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { DialogShell } from '@/components/DialogShell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
import { useRedis } from '@/store/useRedis'
import type { KeyValue } from '@shared/types'

/**
 * 整键编辑弹窗（string / hash / list / set / zset 的「编辑值」入口）。
 * 保存会以表单内容整体覆盖该键 —— 因此带 TTL 输入框，避免过期时间丢失。
 */
export function EditValueDialog({ initial, onClose }: { initial: KeyValue; onClose: () => void }) {
  const { t } = useI18n()
  const { saveValue, notify } = useRedis()

  const type = initial.type
  const key = initial.key

  const [stringDraft, setStringDraft] = useState(
    typeof initial.value === 'string' ? initial.value : '',
  )
  const [hashRows, setHashRows] = useState<Array<{ field: string; value: string }>>(
    Object.entries((initial.value as Record<string, string>) ?? {}).map(([field, value]) => ({
      field,
      value,
    })),
  )
  const [linesDraft, setLinesDraft] = useState(
    Array.isArray(initial.value) ? (initial.value as string[]).join('\n') : '',
  )
  /** 写回时会整键重建，因此需要带上原 TTL，否则过期时间会丢失 */
  const [ttlDraft, setTtlDraft] = useState(initial.ttl > 0 ? String(initial.ttl) : '')
  const [saving, setSaving] = useState(false)

  /* String() 归一：数字输入框可能给出数字，数字值上 .trim() 会炸提交 */
  const ttlText = String(ttlDraft ?? '')

  const placeholder =
    type === 'hash'
      ? t('editValueDialog.oneFieldPerLineValue')
      : type === 'zset'
        ? t('editValueDialog.memberScoreFormat')
        : type === 'list'
          ? t('editValueDialog.oneElementPerLine')
          : type === 'set'
            ? t('editValueDialog.oneMemberPerLine')
            : t('createKeyDialog.stringContentSpanMultipleLines')

  function parseLines(): string[] {
    return linesDraft
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  }

  function buildPayload(): string | string[] | Record<string, string> | null {
    if (type === 'string') return stringDraft
    if (type === 'hash') {
      const record: Record<string, string> = {}
      for (const row of hashRows) {
        if (row.field.trim()) record[row.field.trim()] = row.value
      }
      return record
    }
    if (type === 'list' || type === 'set' || type === 'zset') return parseLines()
    return null
  }

  function addHashRow(): void {
    setHashRows((prev) => [...prev, { field: '', value: '' }])
  }

  function removeHashRow(index: number): void {
    setHashRows((prev) => prev.filter((_, i) => i !== index))
  }

  function updateHashRow(index: number, patch: Partial<{ field: string; value: string }>): void {
    setHashRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  async function submit(): Promise<void> {
    const payload = buildPayload()
    if (payload === null) {
      notify('err', t('editValueDialog.editingTypeTypesNotSupported', { type }))
      return
    }

    let ttl: number | undefined
    if (ttlText.trim()) {
      const parsed = Number(ttlText)
      if (!Number.isInteger(parsed) || parsed < 0) {
        notify('err', t('createKeyDialog.ttlIntegerNumberSeconds'))
        return
      }
      ttl = parsed
    }

    setSaving(true)
    try {
      const done = await saveValue(key, type, payload, ttl)
      if (done) onClose()
    } finally {
      setSaving(false)
    }
  }


  return (
    <DialogShell
      icon="edit"
      title={t('editValueDialog.editValue')}
      description={t('editValueDialog.savingOverwritesWholeKeyForm')}
      badge={
        <>
          <span className={`type-badge type-${type}`}>{type}</span>
          <span className="dlg-badge mono ellipsis">{key}</span>
        </>
      }
      className="edit-value-dialog"
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
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      {/* TTL 放在最前：整键重建时必须记住过期时间，否则保存一次就变永久 */}
      <div className="field">
        <Label htmlFor="ev-ttl" className="field-label">
          {t('editValueDialog.ttl')}
        </Label>
        <Input
          id="ev-ttl"
          value={ttlDraft}
          onChange={(event) => setTtlDraft(event.target.value)}
          className="mono ttl-input"
          inputMode="numeric"
          min="0"
          placeholder={t('common.noExpiration')}
        />
      </div>

      {/* 按类型切换编辑器 */}
      {type === 'string' ? (
        <div className="field">
          <Textarea
            value={stringDraft}
            onChange={(event) => setStringDraft(event.target.value)}
            className="mono dlg-content"
            autoGrow
            spellCheck={false}
            placeholder={placeholder}
          />
        </div>
      ) : type === 'hash' ? (
        /* hash：字段表格。列头 + 行内输入 + 行末删除，结构保持不变 */
        <div className="hash-table">
          <div className="hash-head">
            <span>field</span>
            <span>value</span>
            <span />
          </div>
          {hashRows.map((row, index) => (
            <div key={index} className="hash-row">
              <Input
                value={row.field}
                onChange={(event) => updateHashRow(index, { field: event.target.value })}
                className="mono"
              />
              <Input
                value={row.value}
                onChange={(event) => updateHashRow(index, { value: event.target.value })}
                className="mono"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="del-btn"
                aria-label={t('common.deleteField')}
                onClick={() => removeHashRow(index)}
              >
                <DialogIcon name="cancel" size={11} />
              </Button>
            </div>
          ))}
          <button type="button" className="btn-ghost add-row" onClick={addHashRow}>
            <DialogIcon name="add" size={12} />
            {t('editHashFieldDialog.addField')}
          </button>
        </div>
      ) : (
        /* list / set / zset：一行一项 */
        <div className="field">
          <Textarea
            value={linesDraft}
            onChange={(event) => setLinesDraft(event.target.value)}
            className="mono dlg-content"
            autoGrow
            spellCheck={false}
            placeholder={placeholder}
          />
        </div>
      )}

      {/* 覆盖式保存的风险提示：用 warning 色条，位置在内容之后、页脚之前 */}
      <div className="dlg-alert" role="status">
        <DialogIcon name="warning" size={14} />
        <span>{t('editValueDialog.savingOverwritesWholeKeyCurrent')}</span>
      </div>
    </DialogShell>
  )
}

export default EditValueDialog

import { useState } from 'react'
import { tipProps } from '@/components/tip'
import { DialogShell } from '@/components/DialogShell'
import { DialogIcon } from '@/components/DialogIcon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'

export interface StreamAddEntryDialogProps {
  keyName: string
  /** 当前 entry 数，用于显示影响范围 */
  total: number
  onConfirm: (fields: Array<[string, string]>) => void
  onCancel: () => void
}

interface FieldRow {
  id: number
  field: string
  value: string
}

let nextRowId = 1

function createRow(): FieldRow {
  return { id: nextRowId++, field: '', value: '' }
}

/**
 * 向 stream 追加一条 entry（XADD），支持多字段。
 * 字段顺序按界面行顺序传给服务端；空字段行会被忽略。
 */
export function StreamAddEntryDialog({ keyName, total, onConfirm, onCancel }: StreamAddEntryDialogProps) {
  const { t } = useI18n()
  const [rows, setRows] = useState<FieldRow[]>([createRow()])

  const validFields = rows
    .map((row) => [row.field.trim(), row.value] as [string, string])
    .filter(([field]) => field.length > 0)
  const canSubmit = validFields.length > 0
  const valueBytes = rows.reduce(
    (totalBytes, row) => totalBytes + new TextEncoder().encode(row.value).length,
    0,
  )

  function updateRow(id: number, patch: Partial<FieldRow>): void {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  function removeRow(id: number): void {
    setRows((current) => (current.length > 1 ? current.filter((row) => row.id !== id) : current))
  }

  return (
    <DialogShell
      icon="add"
      title={t('streamAddEntryDialog.appendMessage')}
      description={t('streamAddEntryDialog.messageIdsBrief')}
      badge={<span className="dlg-badge mono">stream</span>}
      className="stream-add-entry-dialog"
      onClose={onCancel}
      footer={
        <>
          <span className="stat mono">
            {t('streamAddEntryDialog.fieldCount', { count: validFields.length })}
          </span>
          <span className="sep">·</span>
          <span className="stat mono">{t('streamAddEntryDialog.bytes', { count: valueBytes })}</span>
          <span className="spacer" />
          <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={onCancel}>
            <DialogIcon name="cancel" size={13} />
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            className="foot-btn foot-primary"
            disabled={!canSubmit}
            onClick={() => onConfirm(validFields)}
          >
            <DialogIcon name="add" size={13} />
            {t('valueViewer.append')}
          </Button>
        </>
      }
    >
      <div className="key-preview">
        <span className="type-badge">stream</span>
        <span className="key-name mono ellipsis" {...tipProps(keyName)}>
          {keyName}
        </span>
        <span className="pos mono">{t('streamAddEntryDialog.countMessages', { count: total })}</span>
      </div>

      <div className="sae-rows">
        {rows.map((row, index) => (
          <div className="sae-row" key={row.id}>
            <div className="field sae-field">
              <Label htmlFor={`sae-field-${row.id}`} className="field-label">
                {index === 0 ? 'field' : ''}
              </Label>
              <Input
                id={`sae-field-${row.id}`}
                value={row.field}
                onChange={(event) => updateRow(row.id, { field: event.target.value })}
                className="mono"
                placeholder={t('streamAddEntryDialog.e')}
                autoComplete="off"
                spellCheck={false}
                autoFocus={index === 0}
              />
            </div>
            <div className="field sae-value">
              <Label htmlFor={`sae-value-${row.id}`} className="field-label">
                {index === 0 ? 'value' : ''}
              </Label>
              <Textarea
                id={`sae-value-${row.id}`}
                value={row.value}
                onChange={(event) => updateRow(row.id, { value: event.target.value })}
                className="mono dlg-content"
                autoGrow
                spellCheck={false}
                placeholder={t('streamAddEntryDialog.messageContentMultiple')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && canSubmit) {
                    event.preventDefault()
                    onConfirm(validFields)
                  }
                }}
              />
            </div>
            <button
              className="sae-remove"
              disabled={rows.length === 1}
              {...tipProps(t('streamAddEntryDialog.removeField'))}
              onClick={() => removeRow(row.id)}
            >
              <DialogIcon name="trash" size={12} />
            </button>
          </div>
        ))}
      </div>

      <button className="sae-add" onClick={() => setRows((current) => [...current, createRow()])}>
        <DialogIcon name="add" size={12} />
        {t('streamAddEntryDialog.addField')}
      </button>

      <div className="dlg-alert" role="status">
        <DialogIcon name="info" size={14} />
        <span>{t('streamAddEntryDialog.messageIdsServerGenerated')}</span>
      </div>
    </DialogShell>
  )
}

export default StreamAddEntryDialog

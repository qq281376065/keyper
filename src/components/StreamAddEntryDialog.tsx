import { useState } from 'react'
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
  onConfirm: (field: string, value: string) => void
  onCancel: () => void
}

/**
 * 向 stream 追加一条 entry（XADD）。
 *
 * 与 hash 新增字段弹窗同构（field + value 两输入），差异点：
 *   · ID 由服务端 `*` 自动生成（单调约束手工填必错），界面只做说明；
 *   · 保存后的本地更新走整表静默刷新（ID 是服务端生成的，本地猜不出，
 *     这与 hash/list「结果完全可预期」的本地直改前提不同）。
 */
export function StreamAddEntryDialog({ keyName, total, onConfirm, onCancel }: StreamAddEntryDialogProps) {
  const { t } = useI18n()
  const [fieldDraft, setFieldDraft] = useState('')
  const [valueDraft, setValueDraft] = useState('')

  const fieldValid = fieldDraft.trim().length > 0
  const canSubmit = fieldValid
  /* TextEncoder 而不是 new Blob().size：Blob 每次都会触发一次内存拷贝，
     长文本下开销可观；TextEncoder 是纯计算，且不依赖 DOM。 */
  const valueBytes = new TextEncoder().encode(valueDraft).length

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
          <span className="stat mono">{t('common.countCharacters', { count: fieldDraft.length })}</span>
          <span className="sep">·</span>
          <span className="stat mono">value {valueBytes} B</span>
          <span className="spacer" />
          <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={onCancel}>
            <DialogIcon name="cancel" size={13} />
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            className="foot-btn foot-primary"
            disabled={!canSubmit}
            onClick={() => onConfirm(fieldDraft.trim(), valueDraft)}
          >
            <DialogIcon name="add" size={13} />
            {t('valueViewer.append')}
          </Button>
        </>
      }
    >
      {/* 目标键：stream 是只追加的日志流，用条数表达规模 */}
      <div className="key-preview">
        <span className="type-badge">stream</span>
        <span className="key-name mono ellipsis" title={keyName}>
          {keyName}
        </span>
        <span className="pos mono">{t('streamAddEntryDialog.countMessages', { count: total })}</span>
      </div>

      <div className="field">
        <Label htmlFor="sae-field" className="field-label">
          field
          <span className="hint-inline">{t('streamAddEntryDialog.fieldNameHint')}</span>
        </Label>
        <Input
          id="sae-field"
          value={fieldDraft}
          onChange={(event) => setFieldDraft(event.target.value)}
          className="mono"
          placeholder={t('streamAddEntryDialog.e')}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          onKeyUp={(event) => {
            if (event.key === 'Enter' && canSubmit) onConfirm(fieldDraft.trim(), valueDraft)
          }}
        />
      </div>

      <div className="field">
        <Label htmlFor="sae-value" className="field-label">
          value
        </Label>
        <Textarea
          id="sae-value"
          value={valueDraft}
          onChange={(event) => setValueDraft(event.target.value)}
          className="mono dlg-content"
          autoGrow
          spellCheck={false}
          placeholder={t('streamAddEntryDialog.messageContentMultiple')}
        />
      </div>

      <div className="dlg-alert" role="status">
        <DialogIcon name="info" size={14} />
        <span>{t('streamAddEntryDialog.messageIdsServerGenerated')}</span>
      </div>
    </DialogShell>
  )
}

export default StreamAddEntryDialog

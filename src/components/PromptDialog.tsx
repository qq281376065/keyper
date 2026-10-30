import { useState } from 'react'
import { DialogShell } from '@/components/DialogShell'
import { DialogIcon } from '@/components/DialogIcon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useI18n } from '@/i18n'

/** 通用单值输入弹窗：用于重命名键、设置 TTL 等轻量输入场景 */
export interface PromptDialogProps {
  title: string
  label: string
  initialValue?: string
  placeholder?: string
  hint?: string
  confirmText?: string
  /** 输入框类型：TTL 等数值场景使用 number */
  inputType?: 'text' | 'number'
  /** 常用值快捷项，点击后直接填入输入框 */
  presets?: Array<{ label: string; value: string }>
  onConfirm: (value: string) => void
  onCancel: () => void
}

export function PromptDialog({
  title,
  label,
  initialValue = '',
  placeholder = '',
  hint = '',
  confirmText,
  inputType = 'text',
  presets = [],
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(initialValue)

  return (
    <DialogShell
      icon="edit"
      title={title}
      description={t('填写后按 Enter 可直接确认')}
      className="prompt-dialog"
      onClose={onCancel}
      footer={
        <>
          <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={onCancel}>
            <DialogIcon name="cancel" size={13} />
            {t('取消')}
          </Button>
          <Button
            type="button"
            className="foot-btn foot-primary"
            onClick={() => onConfirm(draft)}
          >
            <DialogIcon name="save" size={13} />
            {confirmText ?? t('确定')}
          </Button>
        </>
      }
    >
      <div className="field">
        <Label htmlFor="prompt-input" className="field-label">
          {label}
        </Label>
        <Input
          id="prompt-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="mono"
          type={inputType}
          min={inputType === 'number' ? 0 : undefined}
          placeholder={placeholder}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          onKeyUp={(event) => {
            if (event.key === 'Enter') onConfirm(draft)
          }}
        />
      </div>

      {/* 常用值：一键填入，省掉手输。整组胶囊化，与按钮约定一致 */}
      {presets.length ? (
        <div className="presets">
          <span className="presets-label">{t('常用值')}</span>
          {presets.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`preset${draft === item.value ? ' on' : ''}`}
              onClick={() => setDraft(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      {hint ? <p className="hint">{hint}</p> : null}
    </DialogShell>
  )
}

export default PromptDialog

import { useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { useDialogDrag } from '@/hooks/useDialogDrag'

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
  confirmText = '确定',
  inputType = 'text',
  presets = [],
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const [draft, setDraft] = useState(initialValue)
  const { style, onDragStart } = useDialogDrag()

  return (
    <div className="mask s-prompt-dialog">
      <div className="dialog" style={style}>
        <header className="dialog-head" onMouseDown={onDragStart}>
          <span>{title}</span>
          <span className="spacer" />
          <button className="btn-ghost tiny" onClick={onCancel}>
            <DialogIcon name="cancel" size={12} />
          </button>
        </header>

        <div className="dialog-body">
          <label className="field">
            <span className="label">{label}</span>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="mono"
              type={inputType}
              min={inputType === 'number' ? 0 : undefined}
              placeholder={placeholder}
              onKeyUp={(event) => {
                if (event.key === 'Enter') onConfirm(draft)
              }}
            />
          </label>

          {presets.length ? (
            <div className="presets">
              <span className="presets-label">常用值</span>
              {presets.map((item) => (
                <button
                  key={item.value}
                  className={`preset${draft === item.value ? ' on' : ''}`}
                  onClick={() => setDraft(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}

          {hint ? <p className="hint">{hint}</p> : null}
        </div>

        <footer className="dialog-foot">
          <button className="btn" onClick={onCancel}>
            <DialogIcon name="cancel" />
            取消
          </button>
          <span className="spacer" />
          <button className="btn-primary btn" onClick={() => onConfirm(draft)}>
            <DialogIcon name="save" />
            {confirmText}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default PromptDialog

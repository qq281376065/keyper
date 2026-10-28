import { useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useDialogDrag } from '@/hooks/useDialogDrag'

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
  const [fieldDraft, setFieldDraft] = useState('')
  const [valueDraft, setValueDraft] = useState('')
  const { style, onDragStart } = useDialogDrag()

  const fieldValid = fieldDraft.trim().length > 0
  const canSubmit = fieldValid
  const valueBytes = new Blob([valueDraft]).size

  return (
    <div className="mask s-stream-add-entry-dialog">
      <div className="dialog" style={style}>
        <header className="dialog-head" onMouseDown={onDragStart}>
          <span>追加消息</span>
          <span className="key-name mono ellipsis" {...tipProps(keyName)}>
            {keyName}
          </span>
          <span className="spacer" />
          <button className="btn-ghost tiny" onClick={onCancel}>
            <DialogIcon name="cancel" size={12} />
          </button>
        </header>

        {/* key 预览：stream 是只追加的日志流，位置信息用条数表达 */}
        <div className="key-preview">
          <span className="type-badge">stream</span>
          <span className="key-name mono ellipsis" {...tipProps(keyName)}>
            {keyName}
          </span>
          <span className="pos mono">{total} 条消息</span>
        </div>

        <div className="dialog-body">
          <label className="field">
            <span className="label">
              field
              <span className="hint-inline">（消息的字段名，如 event / user_id）</span>
            </span>
            <input
              value={fieldDraft}
              onChange={(event) => setFieldDraft(event.target.value)}
              className="mono"
              placeholder="如 order_paid"
              autoComplete="off"
              spellCheck={false}
              onKeyUp={(event) => {
                if (event.key === 'Enter' && canSubmit) onConfirm(fieldDraft.trim(), valueDraft)
              }}
            />
          </label>

          <label className="field">
            <span className="label">value</span>
            <textarea
              value={valueDraft}
              onChange={(event) => setValueDraft(event.target.value)}
              className="mono content"
              spellCheck={false}
              placeholder="消息内容，可多行"
            />
          </label>

          <p className="note">消息 ID 由服务端自动生成（XADD *），总是追加在流的末尾、不影响历史消息。</p>
        </div>

        <footer className="dialog-foot">
          <span className="stat mono">{fieldDraft.length} 字符</span>
          <span className="sep">·</span>
          <span className="stat mono">value {valueBytes} B</span>

          <span className="spacer" />
          <button className="btn" onClick={onCancel}>
            <DialogIcon name="cancel" />
            取消
          </button>
          <button
            className="btn-primary btn"
            disabled={!canSubmit}
            onClick={() => onConfirm(fieldDraft.trim(), valueDraft)}
          >
            <DialogIcon name="add" />
            追加
          </button>
        </footer>
      </div>
    </div>
  )
}

export default StreamAddEntryDialog

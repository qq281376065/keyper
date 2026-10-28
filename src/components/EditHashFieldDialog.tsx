import { useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useDialogDrag } from '@/hooks/useDialogDrag'
import { useRedis } from '@/store/useRedis'

export interface EditHashFieldDialogProps {
  /** edit=编辑既有字段（默认）；add=新增字段 */
  mode?: 'edit' | 'add'
  keyName: string
  field?: string
  value?: string
  onClose: () => void
  /**
   * 保存成功。携带新字段名与新值，
   * 便于调用方直接本地更新，无需回读整个键。
   * renamedFrom 为空串 = 新增字段（add 模式），否则 = 编辑/重命名。
   */
  onSaved: (payload: { field: string; value: string; renamedFrom: string }) => void
}

/**
 * 编辑 / 新增 hash 的单个字段：field 改名与 value 修改都支持。
 *
 * mode='add'（用户需求：hash 补新增字段入口）：field/value 初始为空，
 * 提交即 HSET 新字段（不存在则新增、存在则覆盖值 —— HSET 天然 upsert，
 * 服务端零改动复用 setHashField）；onSaved 的 renamedFrom 携空串表达新增语义。
 */
export function EditHashFieldDialog({
  mode = 'edit',
  keyName,
  field = '',
  value = '',
  onClose,
  onSaved,
}: EditHashFieldDialogProps) {
  const { state, notify } = useRedis()
  const [fieldDraft, setFieldDraft] = useState(field)
  const [valueDraft, setValueDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const { style, onDragStart } = useDialogDrag()

  const isAdd = mode === 'add'
  const title = isAdd ? '新增字段' : '修改字段'
  const renamed = !isAdd && fieldDraft.trim() !== field
  const canSubmit = fieldDraft.trim().length > 0 && !saving

  async function submit(): Promise<void> {
    const id = state.activeId
    if (!id || !canSubmit) return

    const name = fieldDraft.trim()
    if (isAdd) {
      /* 新增：HSET upsert —— 直接以新 field 提交，renamedFrom 空串表达新增语义 */
      setSaving(true)
      try {
        const res = await api.redis.setHashField(id, keyName, name, valueDraft)
        if (!res.ok) {
          notify('err', res.error)
          return
        }
        if (!res.data.ok) {
          notify('err', res.data.message ?? '保存失败')
          return
        }
        notify('ok', res.data.message ?? '已新增字段')
        onSaved({ field: name, value: valueDraft, renamedFrom: '' })
      } finally {
        setSaving(false)
      }
      return
    }

    const changed = name !== field || valueDraft !== value
    if (!changed) {
      onClose()
      return
    }

    setSaving(true)
    try {
      const res = await api.redis.setHashField(
        id,
        keyName,
        field,
        valueDraft,
        name === field ? undefined : name,
      )
      if (!res.ok) {
        notify('err', res.error)
        return
      }
      if (!res.data.ok) {
        notify('err', res.data.message ?? '保存失败')
        return
      }
      notify('ok', res.data.message ?? '已保存')
      // 透出新字段名与新值：调用方据此本地更新表格，避免整表重读
      onSaved({ field: name, value: valueDraft, renamedFrom: field })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mask s-edit-hash-field-dialog">
      <div className="dialog" style={style}>
        <header className="dialog-head" onMouseDown={onDragStart}>
          <span>{title}</span>
          <span className="key-name mono ellipsis" {...tipProps(keyName)}>
            {keyName}
          </span>
          <span className="spacer" />
          <button className="btn-ghost tiny" onClick={onClose}>
            <DialogIcon name="cancel" size={12} />
          </button>
        </header>

        <div className="dialog-body">
          <label className="field">
            <span className="label">field</span>
            <input
              value={fieldDraft}
              onChange={(event) => setFieldDraft(event.target.value)}
              className="mono"
              placeholder="字段名"
              onKeyUp={(event) => {
                if (event.key === 'Enter') void submit()
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
              placeholder="字段值，可多行"
            />
          </label>

          {isAdd ? (
            <p className="warn">字段已存在时会覆盖其原有值（HSET 语义），不会影响同键下的其他字段。</p>
          ) : renamed ? (
            <p className="warn">
              字段名已变更：将删除原字段 <code className="mono">{field}</code> 并写入{' '}
              <code className="mono">{fieldDraft.trim()}</code>。 若目标字段已存在，其原有值会被覆盖。
            </p>
          ) : null}
        </div>

        <footer className="dialog-foot">
          <span className="foot-hint">仅影响该字段，不会改动同键下的其他字段</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            <DialogIcon name="cancel" />
            取消
          </button>
          <button className="btn-primary btn" disabled={!canSubmit} onClick={() => void submit()}>
            <DialogIcon name="save" />
            {saving ? '保存中…' : isAdd ? '添加' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default EditHashFieldDialog

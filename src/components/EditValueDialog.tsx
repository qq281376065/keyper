import { useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useDialogDrag } from '@/hooks/useDialogDrag'
import { useRedis } from '@/store/useRedis'
import type { KeyValue } from '@shared/types'

/**
 * 整键编辑弹窗（string / hash / list / set / zset 的「编辑值」入口）。
 * 保存会以表单内容整体覆盖该键 —— 因此带 TTL 输入框，避免过期时间丢失。
 */
export function EditValueDialog({ initial, onClose }: { initial: KeyValue; onClose: () => void }) {
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
      ? '每行一个字段，格式 field=value'
      : type === 'zset'
        ? '每行格式 member::score'
        : type === 'list'
          ? '每行一个元素'
          : type === 'set'
            ? '每行一个成员'
            : '字符串内容，可多行'

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
      notify('err', `暂不支持编辑 ${type} 类型`)
      return
    }

    let ttl: number | undefined
    if (ttlText.trim()) {
      const parsed = Number(ttlText)
      if (!Number.isInteger(parsed) || parsed < 0) {
        notify('err', 'TTL 需为不小于 0 的整数秒')
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

  const { style, onDragStart } = useDialogDrag()

  return (
    <div className="mask s-edit-value-dialog">
      <div className="dialog" style={style}>
        <header className="dialog-head" onMouseDown={onDragStart}>
          <span>编辑值</span>
          <span className={`type-badge type-${type}`}>{type}</span>
          <span className="key-name mono ellipsis" {...tipProps(key)}>
            {key}
          </span>
          <span className="spacer" />
          <button className="btn-ghost tiny" onClick={onClose}>
            <DialogIcon name="cancel" size={12} />
          </button>
        </header>

        <div className="dialog-body">
          <label className="field">
            <span className="label">TTL（秒，留空表示永久）</span>
            <input
              value={ttlDraft}
              onChange={(event) => setTtlDraft(event.target.value)}
              className="mono ttl-input"
              inputMode="numeric"
              min="0"
              placeholder="永久"
            />
          </label>

          {/* string */}
          {type === 'string' ? (
            <textarea
              value={stringDraft}
              onChange={(event) => setStringDraft(event.target.value)}
              className="content mono"
              spellCheck={false}
              placeholder={placeholder}
            />
          ) : type === 'hash' ? (
            /* hash */
            <div className="hash-table">
              <div className="hash-head">
                <span>field</span>
                <span>value</span>
                <span />
              </div>
              {hashRows.map((row, index) => (
                <div key={index} className="hash-row">
                  <input
                    value={row.field}
                    onChange={(event) => updateHashRow(index, { field: event.target.value })}
                    className="mono"
                  />
                  <input
                    value={row.value}
                    onChange={(event) => updateHashRow(index, { value: event.target.value })}
                    className="mono"
                  />
                  <button className="del-btn" {...tipProps('删除字段')} onClick={() => removeHashRow(index)}>
                    <DialogIcon name="cancel" size={11} />
                  </button>
                </div>
              ))}
              <button className="btn-ghost add-row" onClick={addHashRow}>
                <DialogIcon name="add" size={12} />
                新增字段
              </button>
            </div>
          ) : (
            /* list / set / zset */
            <textarea
              value={linesDraft}
              onChange={(event) => setLinesDraft(event.target.value)}
              className="content mono"
              spellCheck={false}
              placeholder={placeholder}
            />
          )}

          <p className="warn">保存会以当前表单内容整体覆盖该键，请确认内容完整。</p>
        </div>

        <footer className="dialog-foot">
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            <DialogIcon name="cancel" />
            取消
          </button>
          <button className="btn-primary btn" disabled={saving} onClick={() => void submit()}>
            <DialogIcon name="save" />
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default EditValueDialog

import { useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useDialogDrag } from '@/hooks/useDialogDrag'
import { formatBytes } from '@/utils/format'

export interface EditListElementDialogProps {
  /** edit 修改已有元素；insert 在指定位置插入新元素 */
  mode?: 'edit' | 'insert'
  keyName: string
  /** 元素下标（从 0 起）；insert 模式下为插入基准位置 */
  index: number
  /** 列表总长度，用于显示位置信息 */
  total: number
  initialValue?: string
  /** insert 模式：插在基准位置之前还是之后 */
  position?: 'before' | 'after'
  /** insert 模式：是否追加到末尾 */
  appending?: boolean
  /**
   * 对象称呼：默认按 list 语义称「项」。
   * set 等无序集合应传「成员」—— "第 N 项"对无序集合没有意义，会误导用户。
   */
  itemLabel?: string
  /** 键类型：用于预览条徽标（list / set 等） */
  keyType?: string
  /**
   * 是否显示位置信息（`#N / 总数`、`插入后共 N 项`）。
   * 无序集合应关闭：位置随时可能变化，展示出来反而制造困惑。
   */
  showPosition?: boolean
  onConfirm: (value: string) => void
  onCancel: () => void
}

/**
 * list 元素的「修改」与「插入」共用弹窗。
 *
 * 两者形态一致（key 预览条 + 多行内容 + 底部状态栏），差别只在于：
 * - edit：内容有原值，状态栏额外展示改动量（增/减），无改动时禁用保存；
 * - insert：新增内容，没有对比基准，因此只统计新内容本身。
 * 用 mode 区分而非拆成两个组件 —— 否则 key 预览与统计逻辑要重复一遍。
 */
export function EditListElementDialog({
  mode = 'edit',
  keyName,
  index,
  total,
  initialValue = '',
  position = 'after',
  appending = false,
  itemLabel = '项',
  keyType = 'list',
  showPosition = true,
  onConfirm,
  onCancel,
}: EditListElementDialogProps) {
  const [draft, setDraft] = useState(initialValue)
  const { style, onDragStart } = useDialogDrag()

  /** 状态栏统计：字符数、行数、字节数、是否修改 */
  const bytes = new Blob([draft]).size
  const lines = draft ? draft.split('\n').length : 0
  const originalBytes = new Blob([initialValue]).size
  const stats = {
    chars: draft.length,
    lines,
    bytes,
    /** 与原始值是否不同 —— 用于禁用"无改动"的提交（仅 edit 模式有意义） */
    changed: draft !== initialValue,
    originalBytes,
  }

  /** 字节数增减：用带符号形式直观表达"改了多大"（仅 edit 模式展示） */
  const bytesDelta = stats.bytes - stats.originalBytes

  /** 弹窗标题：无序集合用「成员」而非「第 N 项」 */
  const title =
    mode === 'edit'
      ? showPosition
        ? `修改第 ${index + 1} ${itemLabel}`
        : `修改${itemLabel}`
      : !showPosition
        ? `新增${itemLabel}`
        : appending
          ? `追加${itemLabel}`
          : `在第 ${index + 1} ${itemLabel}${position === 'before' ? '前' : '后'}插入`

  /** 副标题：说明这次操作的影响（无序集合无可预期的数量位置，仅在有序时展示） */
  const subtitle = mode === 'edit' || !showPosition ? '' : appending ? `将追加为第 ${total + 1} 项` : `插入后共 ${total + 1} 项`

  /** 尝试格式化为 JSON，便于用户确认自己写的是合法结构 */
  const jsonHint = (() => {
    const text = draft.trim()
    if (!text || (!text.startsWith('{') && !text.startsWith('['))) return ''
    try {
      JSON.parse(text)
      return '合法 JSON'
    } catch {
      return 'JSON 格式有误'
    }
  })()

  /**
   * 是否可提交。
   * edit 模式要求内容确有变化（否则"保存"等于空操作）；
   * insert 模式只要求非空 —— 插入相同内容是有意义的操作。
   */
  const canSubmit = draft.length ? (mode === 'insert' ? true : stats.changed) : false

  return (
    <div className="mask s-edit-list-element-dialog">
      <div className="dialog" style={style}>
        <header className="dialog-head" onMouseDown={onDragStart}>
          <span>{title}</span>
          {subtitle ? <span className="subtitle">{subtitle}</span> : null}
          <span className="spacer" />
          <button className="btn-ghost tiny" onClick={onCancel}>
            <DialogIcon name="cancel" size={12} />
          </button>
        </header>

        {/* key 预览：类型徽标 + 完整键名 + 位置（无序集合不显示位置） */}
        <div className="key-preview">
          <span className="type-badge">{keyType}</span>
          <span className="key-name mono ellipsis" {...tipProps(keyName)}>
            {keyName}
          </span>
          {showPosition ? (
            <span className="pos mono">
              {mode === 'edit' ? `#${index + 1} / ${total}` : `插入点 #${index + 1}`}
            </span>
          ) : null}
        </div>

        <div className="dialog-body">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="mono content"
            spellCheck={false}
            placeholder={mode === 'edit' ? '元素内容，可多行' : '要插入的内容'}
          />
          {jsonHint ? <p className={`json-hint${jsonHint.includes('有误') ? ' bad' : ''}`}>{jsonHint}</p> : null}
        </div>

        <footer className="dialog-foot">
          <span className="stat mono">{stats.chars} 字符</span>
          <span className="sep">·</span>
          <span className="stat mono">{stats.lines} 行</span>
          <span className="sep">·</span>
          <span className="stat mono">{formatBytes(stats.bytes)}</span>
          {/* 改动量仅在编辑模式展示：插入是新增内容，没有对比基准 */}
          {mode === 'edit' && stats.changed ? (
            <>
              <span className="sep">·</span>
              <span className={`stat mono delta ${bytesDelta > 0 ? 'up' : 'down'}`}>
                {bytesDelta > 0 ? '+' : ''}
                {formatBytes(Math.abs(bytesDelta))}
              </span>
            </>
          ) : null}
          {showPosition ? (
            <>
              <span className="sep">·</span>
              <span className="stat mono">{mode === 'edit' ? `位置 ${index + 1} / ${total}` : subtitle}</span>
            </>
          ) : null}

          <span className="spacer" />
          <button className="btn" onClick={onCancel}>
            <DialogIcon name="cancel" />
            取消
          </button>
          <button className="btn-primary btn" disabled={!canSubmit} onClick={() => onConfirm(draft)}>
            <DialogIcon name="save" />
            {mode === 'edit' ? '保存' : '插入'}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default EditListElementDialog

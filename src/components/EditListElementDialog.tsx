import { useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { DialogShell } from '@/components/DialogShell'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
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
  /** 键类型：用于预览条徽标（list / set 等） */
  keyType?: string
  /**
   * 是否显示位置信息（`#N / 总数`、`插入后共 N 项`）。
   * 无序集合应关闭：位置随时可能变化，展示出来反而制造困惑；
   * 关闭时文案称「成员」而不是「第 N 项」。
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
  keyType = 'list',
  showPosition = true,
  onConfirm,
  onCancel,
}: EditListElementDialogProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState(initialValue)

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
        ? t('修改第 {index} 项', { index: index + 1 })
        : t('修改成员')
      : !showPosition
        ? t('新增成员')
        : appending
          ? t('追加项')
          : position === 'before'
            ? t('在第 {index} 项前插入', { index: index + 1 })
            : t('在第 {index} 项后插入', { index: index + 1 })

  /** 副标题：说明这次操作的影响（无序集合无可预期的数量位置，仅在有序时展示） */
  const subtitle =
    mode === 'edit' || !showPosition
      ? ''
      : appending
        ? t('将追加为第 {index} 项', { index: total + 1 })
        : t('插入后共 {count} 项', { count: total + 1 })

  /** 尝试格式化为 JSON，便于用户确认自己写的是合法结构 */
  const jsonHint = (() => {
    const text = draft.trim()
    if (!text || (!text.startsWith('{') && !text.startsWith('['))) return null
    try {
      JSON.parse(text)
      return { text: t('合法 JSON'), bad: false }
    } catch {
      return { text: t('JSON 格式有误'), bad: true }
    }
  })()

  /**
   * 是否可提交。
   * edit 模式要求内容确有变化（否则"保存"等于空操作）；
   * insert 模式只要求非空 —— 插入相同内容是有意义的操作。
   */
  const canSubmit = draft.length ? (mode === 'insert' ? true : stats.changed) : false

  return (
    <DialogShell
      icon={mode === 'edit' ? 'edit' : 'add'}
      title={title}
      description={subtitle || (mode === 'edit' ? t('修改后立即生效') : t('插入后立即生效'))}
      badge={<span className="dlg-badge mono">{keyType}</span>}
      className="edit-list-element-dialog"
      onClose={onCancel}
      footer={
        <>
          {/* 统计条：字符 / 行 / 字节（+ 改动量），放在页脚左侧充当副信息 */}
          <span className="stat mono">{t('{count} 字符', { count: stats.chars })}</span>
          <span className="sep">·</span>
          <span className="stat mono">{t('{count} 行', { count: stats.lines })}</span>
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
          <span className="spacer" />
          <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={onCancel}>
            <DialogIcon name="cancel" size={13} />
            {t('取消')}
          </Button>
          <Button
            type="button"
            className="foot-btn foot-primary"
            disabled={!canSubmit}
            onClick={() => onConfirm(draft)}
          >
            <DialogIcon name="save" size={13} />
            {mode === 'edit' ? t('保存') : t('插入')}
          </Button>
        </>
      }
    >
      {/* 目标键：徽标显示类型，完整键名等宽展示，便于核对 */}
      <div className="key-preview">
        <span className="type-badge">{keyType}</span>
        <span className="key-name mono ellipsis" title={keyName}>
          {keyName}
        </span>
        {showPosition ? (
          <span className="pos mono">
            {mode === 'edit'
              ? `#${index + 1} / ${total}`
              : t('插入点 #{index}', { index: index + 1 })}
          </span>
        ) : null}
      </div>

      <div className="field">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="mono dlg-content"
          autoGrow
          spellCheck={false}
          placeholder={
            !showPosition ? t('成员内容') : mode === 'edit' ? t('元素内容，可多行') : t('要插入的内容')
          }
          autoFocus
        />
        {jsonHint ? <p className={`json-hint${jsonHint.bad ? ' bad' : ''}`}>{jsonHint.text}</p> : null}
      </div>
    </DialogShell>
  )
}

export default EditListElementDialog

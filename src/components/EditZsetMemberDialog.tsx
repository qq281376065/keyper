import { useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useDialogDrag } from '@/hooks/useDialogDrag'
import { formatBytes } from '@/utils/format'

export interface EditZsetMemberDialogProps {
  mode?: 'edit' | 'add'
  keyName: string
  /** 当前成员数，用于显示影响范围 */
  total: number
  /** edit 模式：原成员名 */
  initialMember?: string
  /** edit 模式：原 score */
  initialScore?: string
  /** 提示：同分数的成员共享排名 */
  duplicatedScore?: boolean
  onConfirm: (member: string, score: string) => void
  onCancel: () => void
}

/**
 * 编辑 / 新增 zset 成员。
 *
 * 与 EditListElementDialog 的差别：zset 成员是「member + score」两个字段，
 * 单值输入框装不下；且 score 影响排序位置，需要数值校验与直观反馈。
 * 因此单独成组件而非继续给那个弹窗加分支。
 */
export function EditZsetMemberDialog({
  mode = 'edit',
  keyName,
  total,
  initialMember = '',
  initialScore = '',
  duplicatedScore = false,
  onConfirm,
  onCancel,
}: EditZsetMemberDialogProps) {
  const [memberDraft, setMemberDraft] = useState(initialMember)
  const [scoreDraft, setScoreDraft] = useState(initialScore)
  const { style, onDragStart } = useDialogDrag()

  /*
   * score 草稿的字符串视图 —— 一切字符串操作必须走这里。
   *
   * ⚠️ 历史炸雷（用户踩爆）：输入框曾用 type="number"，Vue 的 v-model
   * 对 number input 会自动把值 parseFloat 成 JS 数字。用户一输入数字，
   * scoreDraft 就从 string 变 number，模板里的 scoreDraft.trim() 直接抛
   * "trim is not a function" → 渲染中断 → 弹窗消失，且状态卡住 → 弹窗永远打不开。
   *
   * 双层修复：①输入框去掉 type="number"（改 inputmode，score 允许负数/小数/
   * 科学计数法，文本 + 校验完全覆盖）；②String() 归一兜底 —— 未来谁再加回
   * type="number"，也只是静默多一层转换，不再崩渲染。
   */
  const scoreText = String(scoreDraft ?? '')
  const scoreNumber = Number(scoreText)
  /** score 必须是有限数字；空字符串 Number('') 为 0，需单独排除 */
  const scoreValid = scoreText.trim() !== '' && Number.isFinite(scoreNumber)
  const memberValid = memberDraft.trim().length > 0

  const changed = memberDraft.trim() !== initialMember || scoreText.trim() !== initialScore
  const canSubmit = memberValid && scoreValid && (mode === 'add' ? true : changed)

  const stats = {
    memberBytes: new Blob([memberDraft]).size,
  }

  const title = mode === 'add' ? '新增成员' : '修改成员'

  return (
    <div className="mask s-edit-zset-member-dialog">
      <div className="dialog" style={style}>
        <header className="dialog-head" onMouseDown={onDragStart}>
          <span>{title}</span>
          <span className="spacer" />
          <button className="btn-ghost tiny" onClick={onCancel}>
            <DialogIcon name="cancel" size={12} />
          </button>
        </header>

        {/* key 预览：zset 有序，因此位置信息用成员数表达更有意义 */}
        <div className="key-preview">
          <span className="type-badge">zset</span>
          <span className="key-name mono ellipsis" {...tipProps(keyName)}>
            {keyName}
          </span>
          <span className="pos mono">{total} 个成员</span>
        </div>

        <div className="dialog-body">
          <label className="field">
            <span className="label">member</span>
            <input
              value={memberDraft}
              onChange={(event) => setMemberDraft(event.target.value)}
              className="mono"
              placeholder="成员内容"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className="field">
            <span className="label">
              score
              <span className="hint-inline">（排序依据，可为小数或负数）</span>
            </span>
            {/* 不用 type="number"：见上方注释；inputmode="decimal" 保留数字输入法 */}
            <input
              value={scoreDraft}
              onChange={(event) => setScoreDraft(event.target.value)}
              className="mono"
              inputMode="decimal"
              placeholder="如 9821 或 1.5"
              autoComplete="off"
            />
          </label>

          {scoreText.trim() && !scoreValid ? (
            <p className="note bad">score 必须是数字</p>
          ) : duplicatedScore ? (
            <p className="note">提示：修改 score 后会自动按新分数重排，同分数的成员共享排名。</p>
          ) : null}
        </div>

        <footer className="dialog-foot">
          <span className="stat mono">{memberDraft.length} 字符</span>
          <span className="sep">·</span>
          <span className="stat mono">member {formatBytes(stats.memberBytes)}</span>
          <span className="sep">·</span>
          <span className={`stat mono${!scoreValid && scoreText.trim() ? ' bad' : ''}`}>
            score {scoreValid ? scoreNumber : '—'}
          </span>

          <span className="spacer" />
          <button className="btn" onClick={onCancel}>
            <DialogIcon name="cancel" />
            取消
          </button>
          <button
            className="btn-primary btn"
            disabled={!canSubmit}
            onClick={() => onConfirm(memberDraft.trim(), scoreText.trim())}
          >
            <DialogIcon name="save" />
            {mode === 'add' ? '添加' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default EditZsetMemberDialog

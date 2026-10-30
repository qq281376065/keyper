import { useState } from 'react'
import { tipProps } from '@/components/tip'
import { DialogIcon } from '@/components/DialogIcon'
import { DialogShell } from '@/components/DialogShell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useI18n } from '@/i18n'
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
  const { t } = useI18n()
  const [memberDraft, setMemberDraft] = useState(initialMember)
  const [scoreDraft, setScoreDraft] = useState(initialScore)

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

  const title = mode === 'add' ? t('common.addMember') : t('common.editMember')

  return (
    <DialogShell
      icon={mode === 'add' ? 'add' : 'edit'}
      title={title}
      description={t('editZsetMemberDialog.scoreSetsSortPosition')}
      badge={<span className="dlg-badge mono">zset</span>}
      className="edit-zset-member-dialog"
      onClose={onCancel}
      footer={
        <>
          <span className="stat mono">{t('common.countCharacters', { count: memberDraft.length })}</span>
          <span className="sep">·</span>
          <span className="stat mono">member {formatBytes(stats.memberBytes)}</span>
          <span className="sep">·</span>
          <span className={`stat mono${!scoreValid && scoreText.trim() ? ' bad' : ''}`}>
            score {scoreValid ? scoreNumber : '—'}
          </span>
          <span className="spacer" />
          <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={onCancel}>
            <DialogIcon name="cancel" size={13} />
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            className="foot-btn foot-primary"
            disabled={!canSubmit}
            onClick={() => onConfirm(memberDraft.trim(), scoreText.trim())}
          >
            <DialogIcon name="save" size={13} />
            {mode === 'add' ? t('editHashFieldDialog.add') : t('common.save')}
          </Button>
        </>
      }
    >
      {/* 目标键：zset 有序，用成员数表达规模比位置更有意义 */}
      <div className="key-preview">
        <span className="type-badge">zset</span>
        <span className="key-name mono ellipsis" {...tipProps(keyName)}>
          {keyName}
        </span>
        <span className="pos mono">{t('editZsetMemberDialog.countMembers', { count: total })}</span>
      </div>

      <div className="field">
        <Label htmlFor="ezm-member" className="field-label">
          member
        </Label>
        <Input
          id="ezm-member"
          value={memberDraft}
          onChange={(event) => setMemberDraft(event.target.value)}
          className="mono"
          placeholder={t('editListElementDialog.memberContent')}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
      </div>

      <div className="field">
        <Label htmlFor="ezm-score" className="field-label">
          score
          <span className="hint-inline">{t('editZsetMemberDialog.scoreSortHint')}</span>
        </Label>
        {/* 不用 type="number"：inputmode="decimal" 保留数字输入法且不吞前导零 */}
        <Input
          id="ezm-score"
          value={scoreDraft}
          onChange={(event) => setScoreDraft(event.target.value)}
          className="mono"
          inputMode="decimal"
          placeholder={t('editZsetMemberDialog.e')}
          autoComplete="off"
        />
      </div>

      {/* 校验反馈：错误用红条，一般提示用中性条 */}
      {scoreText.trim() && !scoreValid ? (
        <div className="dlg-alert is-err" role="status">
          <DialogIcon name="warning" size={14} />
          <span>{t('common.scoreNumber')}</span>
        </div>
      ) : duplicatedScore ? (
        <div className="dlg-alert" role="status">
          <DialogIcon name="info" size={14} />
          <span>{t('editZsetMemberDialog.changingScoreReorders')}</span>
        </div>
      ) : null}
    </DialogShell>
  )
}

export default EditZsetMemberDialog

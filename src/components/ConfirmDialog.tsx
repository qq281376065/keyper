import { useEffect, useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { useDialogDrag } from '@/hooks/useDialogDrag'
import { globalHolder } from '@/store/global'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'

/**
 * 全局确认弹窗。
 * 由 state.confirm 驱动，用于删除键、高危命令等二次确认。
 *
 * 当请求带有 requirePhrase 时，用户必须完整输入该短语才能提交 ——
 * 这是不可逆操作的硬门槛，不是"点一下就好"的软提示。
 */
export function ConfirmDialog() {
  const { state, resolveConfirm } = useRedis()
  useObservable(globalHolder)
  const request = state.confirm

  /** 支持拖动：确认弹窗常与背景内容对照查看，固定居中会挡住被确认的对象 */
  const { style, onDragStart, resetDrag } = useDialogDrag()
  const [phrase, setPhrase] = useState('')

  // 每次弹出新请求都清空输入，避免上一次的输入残留造成误放行
  // 同时复位弹窗位置 —— 否则第二次打开会停在上一轮拖到的地方
  const requestKey = request?.title ?? ''
  useEffect(() => {
    setPhrase('')
    resetDrag()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  if (!request) return null

  const phraseMatched = !request.requirePhrase || phrase.trim() === request.requirePhrase

  function confirm(): void {
    if (!phraseMatched) return
    resolveConfirm(true)
  }

  return (
    <div
      className="mask s-confirm-dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget) resolveConfirm(false)
      }}
    >
      <div className="dialog" style={style}>
        <header className="dialog-head" onMouseDown={onDragStart}>
          <span className={`dot${request.danger ? ' danger' : ''}`} />
          {request.title}
        </header>

        <div className="dialog-body">
          <p className="message">{request.message}</p>

          {/* 结构化明细：标签置灰、值加亮，数据类值用等宽 */}
          {request.details?.length ? (
            <dl className="details">
              {request.details.map((item) => (
                <DetailRow key={`${requestKey}-${item.label}`} item={item} />
              ))}
            </dl>
          ) : null}

          {/* 待操作内容预览：独立区块，等宽展示，便于逐字核对 */}
          {request.preview ? (
            <div className="preview">
              <span className="preview-label">
                {request.preview.label}
                {request.preview.truncated ? <span className="truncated">已截断</span> : null}
              </span>
              <pre className="preview-text mono">{request.preview.text}</pre>
            </div>
          ) : null}

          {/* 风险提示：醒目色，与正文拉开层次 */}
          {request.warning ? (
            <p className="warning">
              <span className="warn-icon">!</span>
              {request.warning}
            </p>
          ) : null}

          {request.requirePhrase ? (
            <div className="phrase-box">
              <span className="phrase-hint">
                请输入 <code className="mono">{request.requirePhrase}</code> 以确认执行
              </span>
              <input
                value={phrase}
                onChange={(event) => setPhrase(event.target.value)}
                className={`mono phrase-input${phraseMatched ? ' matched' : ''}`}
                placeholder={request.requirePhrase}
                autoComplete="off"
                spellCheck={false}
                onKeyUp={(event) => {
                  if (event.key === 'Enter') confirm()
                }}
              />
            </div>
          ) : null}
        </div>

        <footer className="dialog-foot">
          <button className="btn cancel-btn" onClick={() => resolveConfirm(false)}>
            <DialogIcon name="cancel" />
            取消
          </button>
          <span className="spacer" />
          <button
            className={`confirm-btn${request.danger ? ' danger' : ''}`}
            disabled={!phraseMatched}
            onClick={confirm}
          >
            <DialogIcon name="check" />
            {request.confirmText ?? '确定'}
          </button>
        </footer>
      </div>
    </div>
  )
}

/** 明细行：dt 标签 + dd 值（dt/dd 必须成对出现在 dl 里，故单独组件化） */
function DetailRow({
  item,
}: {
  item: { label: string; value: string; mono?: boolean; tone?: 'normal' | 'danger' | 'muted' }
}) {
  return (
    <>
      <dt>{item.label}</dt>
      <dd className={`${item.mono ? 'mono' : ''} ${item.tone ?? 'normal'}`.trim()}>{item.value}</dd>
    </>
  )
}

export default ConfirmDialog

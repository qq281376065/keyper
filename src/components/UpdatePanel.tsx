import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import type { UpdateCheckResult } from '@shared/types'
import { APP_VERSION } from '@/services/errorReport'
import { useI18n } from '@/i18n'

/**
 * 检查更新 —— 一个内联下拉面板，而不是弹窗。
 *
 * 理由：检查更新是"顺手看一眼"的低频动作，结果通常只有三种
 * （已是最新 / 有新版本 / 检查失败）。为这三种情况弹一个模态框，
 * 打断成本远大于信息量。这里做成贴着按钮展开的小面板：
 * 结果就地呈现，点外部即消失，不阻挡页面其余操作。
 */

type Phase = 'idle' | 'checking' | 'done' | 'error'

export interface UpdatePanelProps {
  onClose: () => void
}

export function UpdatePanel({ onClose }: UpdatePanelProps) {
  const { t } = useI18n()
  const [phase, setPhase] = useState<Phase>('checking')
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  /** 格式化检查时间：只到分钟，避免"23 秒前"这种需要定时刷新的文案 */
  function formatTime(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  async function check(): Promise<void> {
    setPhase('checking')
    setError(null)
    const res = await api.update.check()
    if (res.ok) {
      setResult(res.data)
      setPhase('done')
    } else {
      setError(res.error)
      setPhase('error')
    }
  }

  /* 打开即检查一次：用户点这个按钮的意图就是"看看有没有新版" */
  useEffect(() => {
    void check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* 点面板外部关闭。用 pointerdown 而不是 click：
     click 会在按下与抬起之间被拖选文本打断，面板反而更难关。 */
  useEffect(() => {
    function onDown(event: PointerEvent): void {
      const panel = panelRef.current
      if (!panel) return
      if (panel.contains(event.target as Node)) return
      onClose()
    }
    // 延后一帧挂载，避免"打开面板的那次点击"立刻把面板关掉
    const timer = setTimeout(() => document.addEventListener('pointerdown', onDown), 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [onClose])

  /* Esc 关闭：与其它浮层保持一致的键盘习惯 */
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const hasUpdate = result?.hasUpdate === true

  return (
    <div ref={panelRef} className="update-panel" role="dialog" aria-label={t('updatePanel.checkForUpdates')}>
      <header className="update-head">
        <span className="update-title">{t('updatePanel.checkForUpdates')}</span>
        <span className="update-current mono">{t('updatePanel.currentVVersion', { version: APP_VERSION })}</span>
      </header>

      {phase === 'checking' ? (
        <p className="update-state">
          <span className="spinner" />
          {t('updatePanel.checking')}
        </p>
      ) : null}

      {phase === 'error' ? (
        <div className="update-state is-error">
          <DialogIcon name="warning" size={13} />
          <span>{error}</span>
        </div>
      ) : null}

      {phase === 'done' && result ? (
        <>
          {hasUpdate ? (
            <div className="update-state is-new">
              <DialogIcon name="arrow-up" size={13} />
              <span>
                {t('updatePanel.newVersionAvailable')} <strong className="mono">v{result.latestVersion}</strong>
              </span>
            </div>
          ) : (
            <div className="update-state is-latest">
              <DialogIcon name="check" size={13} />
              <span>{t('updatePanel.youLatestVersion')}</span>
            </div>
          )}

          {result.notice ? <p className="update-note">{result.notice}</p> : null}

          {/* 版本说明：tag message 是发布者写的原文，最多展示若干行，超出可滚动 */}
          {result.notes ? <pre className="update-notes">{result.notes}</pre> : null}

          <footer className="update-foot">
            <span className="update-time mono">
              {t('updatePanel.checkedTime', { time: formatTime(result.checkedAt) })}
            </span>
            <span className="spacer" />
            <button
              className="btn tiny"
              onClick={() => void api.update.openPage(result.pageUrl)}
            >
              <DialogIcon name="export" size={11} />
              {hasUpdate ? t('updatePanel.viewDownload') : t('updatePanel.versionHistory')}
            </button>
            <button className="btn tiny" onClick={() => void check()}>
              <DialogIcon name="refresh" size={11} />
              {t('memcachedOverview.retry')}
            </button>
          </footer>
        </>
      ) : null}
    </div>
  )
}

export default UpdatePanel

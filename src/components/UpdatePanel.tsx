import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import type { UpdateCheckResult, UpdateDownloadState } from '@shared/types'
import { APP_VERSION } from '@/services/errorReport'
import { useI18n } from '@/i18n'
import { formatBytes } from '@/utils/format'

/**
 * 检查更新 —— 一个内联下拉面板，而不是弹窗。
 *
 * 理由：检查更新是"顺手看一眼"的低频动作，结果通常只有三种
 * （已是最新 / 有新版本 / 检查失败）。为这三种情况弹一个模态框，
 * 打断成本远大于信息量。这里做成贴着按钮展开的小面板：
 * 结果就地呈现，点外部即消失，不阻挡页面其余操作。
 *
 * 打包版走 electron-updater：发现新版本后可以直接「下载更新」并
 * 「重启并安装」，下载进度由主进程推送；面板关掉不会中断下载，
 * 重新打开时先用 update.state() 恢复最新进度。
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
  const [download, setDownload] = useState<UpdateDownloadState | null>(null)
  /* 触发下载 / 安装失败时的提示；下载过程本身的错误在 download.message 里 */
  const [actionError, setActionError] = useState<string | null>(null)
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
    setActionError(null)
    const res = await api.update.check()
    if (res.ok) {
      setResult(res.data)
      setPhase('done')
    } else {
      setError(res.error)
      setPhase('error')
    }
  }

  async function startDownload(): Promise<void> {
    if (!result?.hasUpdate) return
    setActionError(null)
    const res = await api.update.download(result.latestVersion)
    if (res.ok) setDownload(res.data)
    else setActionError(res.error)
  }

  async function installNow(): Promise<void> {
    setActionError(null)
    const res = await api.update.install()
    // 安装成功时窗口随即退出，这里通常不会执行到失败分支
    if (!res.ok) setActionError(res.error)
  }

  /*
   * 打开面板：先订阅状态，再拉一次快照，最后检查更新。
   * 顺序很重要 —— 先拉快照再订阅会漏掉两者之间的进度事件。
   */
  useEffect(() => {
    const unsubscribe = api.update.onStateChange((next) => setDownload(next))
    void api.update.state().then((res) => {
      if (res.ok) setDownload(res.data)
    })
    void check()
    return unsubscribe
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

  /*
   * 只有「本次检查到的版本」才认下载状态：如果用户下载完 v1.1.0
   * 又检查到 v1.2.0，旧包不能被当成可安装的新版。
   */
  const downloadMatches =
    hasUpdate && !!result && !!download && download.version === result.latestVersion
  const downloading = downloadMatches && download.phase === 'downloading'
  const downloaded = downloadMatches && download.phase === 'downloaded'
  const downloadFailed = downloadMatches && download.phase === 'error'
  const autoUpdatable = hasUpdate && result?.canAutoUpdate === true

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

          {/* 下载中：进度条 + 已下载量 / 速度 */}
          {downloading && download ? (
            <div className="update-download">
              <div
                className="update-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={download.percent ?? 0}
              >
                <span
                  className="update-progress-fill"
                  style={{ width: `${download.percent ?? 0}%` }}
                />
              </div>
              <p className="update-download-stats mono">
                <span>{download.percent != null ? `${download.percent.toFixed(0)}%` : '—'}</span>
                <span>
                  {formatBytes(download.transferred)} /{' '}
                  {download.total != null ? formatBytes(download.total) : '—'}
                </span>
                <span>{download.bytesPerSecond ? `${formatBytes(download.bytesPerSecond)}/s` : ''}</span>
              </p>
              <p className="update-note">{t('updatePanel.downloadingHint')}</p>
            </div>
          ) : null}

          {/* 下载完成：提示重启安装，或等退出时自动安装 */}
          {downloaded ? (
            <div className="update-download">
              <div className="update-state is-latest">
                <DialogIcon name="check" size={13} />
                <span>{t('updatePanel.updateDownloaded')}</span>
              </div>
              <p className="update-note">{t('updatePanel.installOnQuitHint')}</p>
            </div>
          ) : null}

          {/* 下载失败：错误原因 + 底部「重试下载」 */}
          {downloadFailed && download ? (
            <div className="update-state is-error update-download-error">
              <DialogIcon name="warning" size={13} />
              <span>
                {t('updatePanel.downloadFailed')}
                {download.message ? `：${download.message}` : ''}
              </span>
            </div>
          ) : null}

          {actionError ? (
            <div className="update-state is-error update-download-error">
              <DialogIcon name="warning" size={13} />
              <span>{actionError}</span>
            </div>
          ) : null}

          {/* 版本说明：release notes 是发布者写的原文，最多展示若干行，超出可滚动 */}
          {result.notes ? <pre className="update-notes">{result.notes}</pre> : null}

          <footer className="update-foot">
            <span className="update-time mono">
              {t('updatePanel.checkedTime', { time: formatTime(result.checkedAt) })}
            </span>
            <span className="spacer" />
            {autoUpdatable ? (
              <>
                {downloaded ? (
                  <>
                    <button className="btn tiny" onClick={onClose}>
                      {t('updatePanel.later')}
                    </button>
                    <button className="btn tiny btn-primary" onClick={() => void installNow()}>
                      <DialogIcon name="power" size={11} />
                      {t('updatePanel.restartAndInstall')}
                    </button>
                  </>
                ) : downloading ? (
                  <button className="btn tiny" onClick={onClose}>
                    {t('updatePanel.hidePanel')}
                  </button>
                ) : (
                  <>
                    <button
                      className="btn tiny"
                      onClick={() => void api.update.openPage(result.pageUrl)}
                    >
                      <DialogIcon name="export" size={11} />
                      {t('updatePanel.viewDownload')}
                    </button>
                    <button className="btn tiny btn-primary" onClick={() => void startDownload()}>
                      <DialogIcon name="export" size={11} />
                      {downloadFailed ? t('updatePanel.retryDownload') : t('updatePanel.downloadUpdate')}
                    </button>
                  </>
                )}
              </>
            ) : (
              <>
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
              </>
            )}
          </footer>
        </>
      ) : null}
    </div>
  )
}

export default UpdatePanel

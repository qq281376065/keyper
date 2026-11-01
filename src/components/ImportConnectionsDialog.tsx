import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { DialogShell } from '@/components/DialogShell'
import { DialogIcon } from '@/components/DialogIcon'
import { EngineGlyph } from '@/components/EngineGlyph'
import { InlineNotice } from '@/components/InlineNotice'
import { SwitchRow } from '@/components/SwitchRow'
import { Tag } from '@/components/Tag'
import { useRedis } from '@/store/useRedis'
import { useI18n } from '@/i18n'
import type { ConnectionImportPreview, ConnectionImportPreviewItem } from '@shared/types'

export interface ImportConnectionsDialogProps {
  onClose: () => void
}

function formatExportedAt(value: string | undefined, locale: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(locale)
}

function credentialTags(item: ConnectionImportPreviewItem): string[] {
  const tags: string[] = []
  if (item.hasPassword) tags.push('password')
  if (item.hasSshCredential) tags.push('ssh')
  return tags
}

/**
 * 导入连接配置：选文件 → 预览 → 合并。
 *
 * 预览里凭据只以布尔标签呈现，文件里的明文密码不进入渲染层；
 * 合并发生在主进程（一次性令牌对应已解析的配置），渲染层只提交
 * 「是否按 ID 覆盖」。已连接的项由主进程直接跳过 —— 覆盖磁盘配置
 * 不会重建内存里的客户端，界面显示新地址、会话仍连旧实例。
 */
export function ImportConnectionsDialog({ onClose }: ImportConnectionsDialogProps) {
  const { t, locale } = useI18n()
  const { notify, applyImportedConnections } = useRedis()

  const [preview, setPreview] = useState<ConnectionImportPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [overwrite, setOverwrite] = useState(false)
  const [applying, setApplying] = useState(false)

  const tokenRef = useRef<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    return () => {
      aliveRef.current = false
      /* 预览没被消费就关窗：让主进程丢掉缓存，不必等 5 分钟过期 */
      const token = tokenRef.current
      if (token) void api.connection.importCancel(token)
    }
  }, [])

  async function pickFile(keepOnCancel = false): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const res = await api.connection.importPick()
      if (!res.ok) throw new Error(res.error)
      /*
       * 系统打开框里点了取消：首次打开就没有可导入的东西，直接关窗；
       * 从预览里点「选择其他文件」再取消，应保留当前预览，而不是丢掉。
       */
      if (!res.data) {
        if (!keepOnCancel) onClose()
        else setLoading(false)
        return
      }
      if (!aliveRef.current) {
        void api.connection.importCancel(res.data.token)
        return
      }
      const previous = tokenRef.current
      tokenRef.current = res.data.token
      if (previous) void api.connection.importCancel(previous)
      setPreview(res.data)
      setOverwrite(false)
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    void pickFile()
    // 只在挂载时打开一次文件选择框；重选走按钮显式触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function closeDialog(): void {
    const token = tokenRef.current
    if (token) {
      void api.connection.importCancel(token)
      tokenRef.current = null
    }
    onClose()
  }

  async function handleApply(): Promise<void> {
    if (!preview || !preview.valid || applying) return
    setApplying(true)
    try {
      const res = await api.connection.importApply(preview.token, { overwrite })
      if (!res.ok) throw new Error(res.error)
      tokenRef.current = null
      applyImportedConnections(res.data.connections)
      notify(
        'ok',
        t('connectionTransfer.importSummary', {
          imported: res.data.summary.imported,
          overwritten: res.data.summary.overwritten,
          skipped: res.data.summary.skipped,
        }),
      )
      onClose()
    } catch (err) {
      notify('err', err instanceof Error ? err.message : String(err))
    } finally {
      setApplying(false)
    }
  }

  const hasIdConflict = !!preview?.items.some((item) => item.conflict === 'id')
  const exportedAt = formatExportedAt(preview?.exportedAt, locale)

  function renderItem(item: ConnectionImportPreviewItem): ReactNode {
    const tags = credentialTags(item)
    return (
      <div key={item.index} className={`transfer-item${item.connected ? ' is-skipped' : ''}`}>
        <span className={`engine-glyph engine-${item.engine}`} aria-hidden>
          <EngineGlyph engine={item.engine} />
        </span>
        <div className="transfer-item-body">
          <div className="transfer-item-name ellipsis">{item.name}</div>
          <div className="transfer-item-addr mono ellipsis">
            {item.host}:{item.port}
            {item.engine === 'redis' ? ` · db${item.db ?? 0}` : ''}
            {item.tls ? ' · TLS' : ''}
            {item.sshEnabled ? ` · SSH ${item.sshHost ?? ''}` : ''}
          </div>
        </div>
        <div className="transfer-item-tags">
          {tags.map((tag) => (
            <Tag key={tag} tone="accent">
              {t(
                tag === 'password'
                  ? 'connectionTransfer.passwordIncluded'
                  : 'connectionTransfer.sshCredentialIncluded',
              )}
            </Tag>
          ))}
          {!tags.length ? (
            <Tag tone="neutral">{t('connectionTransfer.noCredentials')}</Tag>
          ) : null}
          {item.connected ? (
            <Tag tone="danger">{t('connectionTransfer.connectedSkip')}</Tag>
          ) : item.conflict === 'id' ? (
            <Tag tone="warn">{t('connectionTransfer.conflictId')}</Tag>
          ) : item.conflict === 'name' ? (
            <Tag tone="warn">{t('connectionTransfer.conflictName')}</Tag>
          ) : (
            <Tag tone="neutral">{t('connectionTransfer.newBadge')}</Tag>
          )}
        </div>
      </div>
    )
  }

  return (
    <DialogShell
      icon="import"
      title={t('connectionTransfer.importTitle')}
      description={t('connectionTransfer.importSubtitle')}
      className="transfer-dialog"
      onClose={closeDialog}
      footer={
        <>
          <span className="spacer" />
          <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={closeDialog}>
            <DialogIcon name="cancel" size={13} />
            {t('common.cancel')}
          </Button>
          {error ? (
            <Button type="button" className="foot-btn foot-primary" onClick={() => void pickFile()}>
              <DialogIcon name="folder-open" size={13} />
              {t('connectionTransfer.chooseAnotherFile')}
            </Button>
          ) : null}
          {preview ? (
            <>
              <Button
                type="button"
                variant="secondary"
                className="foot-btn"
                disabled={applying}
                onClick={() => void pickFile(true)}
              >
                <DialogIcon name="folder-open" size={13} />
                {t('connectionTransfer.pickDifferentFile')}
              </Button>
              <Button
                type="button"
                className="foot-btn foot-primary"
                disabled={!preview.valid || applying}
                onClick={() => void handleApply()}
              >
                <DialogIcon name="import" size={13} />
                {applying
                  ? t('connectionTransfer.importing')
                  : t('connectionTransfer.importApplyCount', { count: preview.valid })}
              </Button>
            </>
          ) : null}
        </>
      }
    >
      {loading ? (
        <p className="transfer-loading">
          <DialogIcon name="refresh" size={14} />
          {t('connectionTransfer.readingFile')}
        </p>
      ) : error ? (
        <InlineNotice tone="danger">{error}</InlineNotice>
      ) : preview ? (
        <>
          <div className="transfer-source">
            <div className="transfer-file">
              <DialogIcon name="document" size={13} />
              <span className="mono ellipsis">{preview.fileName}</span>
              <Tag tone={preview.includesCredentials ? 'warn' : 'neutral'}>
                {t(
                  preview.includesCredentials
                    ? 'connectionTransfer.fileHasCredentials'
                    : 'connectionTransfer.fileNoCredentials',
                )}
              </Tag>
            </div>

            <div className="transfer-meta">
              <span>{t('connectionTransfer.validOfTotal', { valid: preview.valid, total: preview.total })}</span>
              {exportedAt ? (
                <span>
                  {t('connectionTransfer.exportedFrom', { date: exportedAt })}
                  {preview.appVersion ? ` · v${preview.appVersion}` : ''}
                </span>
              ) : null}
            </div>
          </div>

          {preview.items.length ? (
            <div className="transfer-list">{preview.items.map(renderItem)}</div>
          ) : (
            <InlineNotice tone="warn">{t('connectionTransfer.noValidEntries')}</InlineNotice>
          )}

          {preview.issues.length ? (
            <div className="transfer-issues" role="status">
              <div className="transfer-issues-head">
                {t('connectionTransfer.invalidEntries', { count: preview.issues.length })}
              </div>
              {preview.issues.map((issue) => (
                <div className="transfer-issue" key={issue.index}>
                  <span className="transfer-issue-index mono">
                    {t('connectionTransfer.entryNumber', { index: issue.index + 1 })}
                  </span>
                  <span>{issue.message}</span>
                </div>
              ))}
            </div>
          ) : null}

          {hasIdConflict ? (
            <SwitchRow
              title={t('connectionTransfer.overwriteExisting')}
              hint={t('connectionTransfer.overwriteHint')}
              checked={overwrite}
              onCheckedChange={setOverwrite}
            />
          ) : null}
        </>
      ) : null}
    </DialogShell>
  )
}

export default ImportConnectionsDialog

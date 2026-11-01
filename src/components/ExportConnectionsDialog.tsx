import { useState } from 'react'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { DialogShell } from '@/components/DialogShell'
import { DialogIcon } from '@/components/DialogIcon'
import { EngineTag } from '@/components/EngineTag'
import { InlineNotice } from '@/components/InlineNotice'
import { SwitchRow } from '@/components/SwitchRow'
import { useRedis } from '@/store/useRedis'
import { useI18n } from '@/i18n'
import { TRANSFER_FORMAT, TRANSFER_VERSION } from '@shared/connection-transfer'

export interface ExportConnectionsDialogProps {
  onClose: () => void
}

/**
 * 导出连接配置。
 *
 * 默认不含凭据：文件会被随意复制、发群、进网盘，密码写进去等于泄露。
 * 勾选后仍要过一次 force 确认，把「明文保存」这件事说清楚再落盘。
 */
export function ExportConnectionsDialog({ onClose }: ExportConnectionsDialogProps) {
  const { t } = useI18n()
  const { state, askConfirm, notify } = useRedis()
  const [includeCredentials, setIncludeCredentials] = useState(false)
  const [busy, setBusy] = useState(false)

  const total = state.connections.length
  const redisCount = state.connections.filter((item) => item.engine !== 'memcached').length
  const memcachedCount = total - redisCount

  async function handleExport(): Promise<void> {
    if (!total || busy) return

    if (includeCredentials) {
      const confirmed = await askConfirm({
        force: true,
        danger: true,
        title: t('connectionTransfer.exportConfirmMessage', { count: total }),
        message: t('connectionTransfer.credentialsIncludedWarning'),
        confirmText: t('connectionTransfer.exportConfirmText'),
      })
      if (!confirmed) return
    }

    setBusy(true)
    try {
      const res = await api.connection.exportToFile({ includeCredentials })
      if (!res.ok) throw new Error(res.error)
      /* 用户在系统保存框里点了取消：不算失败，安静关掉 */
      if (!res.data.saved) return

      const { exported, missingCredentials } = res.data
      if (missingCredentials > 0) {
        notify(
          'err',
          t('connectionTransfer.exportedMissingCredentials', { count: exported, missing: missingCredentials }),
        )
      } else {
        notify('ok', t('connectionTransfer.exportedCount', { count: exported }))
      }
      onClose()
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell
      icon="export"
      title={t('connectionTransfer.exportTitle')}
      description={t('connectionTransfer.exportSubtitle')}
      className="transfer-dialog"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={onClose}>
            <DialogIcon name="cancel" size={13} />
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            className="foot-btn foot-primary"
            disabled={!total || busy}
            onClick={() => void handleExport()}
          >
            <DialogIcon name="export" size={13} />
            {busy ? t('common.loading') : t('connectionTransfer.exportTitle')}
          </Button>
        </>
      }
    >
      <div className="transfer-summary">
        <div className="transfer-summary-head">
          <DialogIcon name="document" size={13} />
          {t('connectionTransfer.summaryTitle')}
        </div>
        <dl className="transfer-summary-rows">
          <div className="transfer-summary-row">
            <dt>{t('connectionTransfer.summaryConnections')}</dt>
            <dd className="mono">{total}</dd>
          </div>
          <div className="transfer-summary-row">
            <dt>{t('connectionTransfer.summaryEngines')}</dt>
            <dd className="transfer-summary-engines">
              <span className="transfer-summary-engine">
                <EngineTag engine="redis" />
                <span className="mono">{redisCount}</span>
              </span>
              <span className="transfer-summary-engine">
                <EngineTag engine="memcached" />
                <span className="mono">{memcachedCount}</span>
              </span>
            </dd>
          </div>
          <div className="transfer-summary-row">
            <dt>{t('connectionTransfer.summaryFormat')}</dt>
            <dd className="mono">
              {TRANSFER_FORMAT} v{TRANSFER_VERSION}
            </dd>
          </div>
          <div className="transfer-summary-row">
            <dt>{t('connectionTransfer.summaryCredentials')}</dt>
            <dd className={includeCredentials ? 'is-warn' : undefined}>
              {t(
                includeCredentials
                  ? 'connectionTransfer.summaryCredentialsIncluded'
                  : 'connectionTransfer.summaryCredentialsExcluded',
              )}
            </dd>
          </div>
        </dl>
      </div>

      <SwitchRow
        title={t('connectionTransfer.includeCredentials')}
        hint={t('connectionTransfer.includeCredentialsHint')}
        checked={includeCredentials}
        onCheckedChange={setIncludeCredentials}
      />

      {includeCredentials ? (
        <InlineNotice tone="warn">{t('connectionTransfer.credentialsIncludedWarning')}</InlineNotice>
      ) : (
        <p className="transfer-hint">{t('connectionTransfer.credentialsExcludedHint')}</p>
      )}
    </DialogShell>
  )
}

export default ExportConnectionsDialog

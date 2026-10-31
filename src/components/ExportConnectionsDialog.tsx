import { useState } from 'react'
import { api } from '@/api'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { DialogIcon } from '@/components/DialogIcon'
import { useDialogDrag } from '@/hooks/useDialogDrag'
import { useRedis } from '@/store/useRedis'
import { useI18n } from '@/i18n'

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
  const { style, onDragStart } = useDialogDrag()
  const { t } = useI18n()
  const { state, askConfirm, notify } = useRedis()
  const [includeCredentials, setIncludeCredentials] = useState(false)
  const [busy, setBusy] = useState(false)

  const total = state.connections.length

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
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent
        className="dialog dlg transfer-dialog"
        style={style}
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <div className="dlg-shell">
          <header className="dlg-head" onMouseDown={onDragStart}>
            <div className="dlg-head-main">
              <div className="dlg-head-top">
                <span className="dlg-head-icon">
                  <DialogIcon name="export" size={15} />
                </span>
                <DialogTitle className="dlg-title">{t('connectionTransfer.exportTitle')}</DialogTitle>
              </div>
              <DialogDescription className="dlg-sub">{t('connectionTransfer.exportSubtitle')}</DialogDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="dlg-close"
              aria-label={t('common.close')}
              onClick={onClose}
            >
              <DialogIcon name="cancel" size={13} />
            </Button>
          </header>

          <div className="dlg-body">
            <p className="transfer-scope">{t('connectionTransfer.exportScope', { count: total })}</p>

            <div className="transfer-toggle">
              <span className="transfer-toggle-text">
                <span className="transfer-toggle-title">{t('connectionTransfer.includeCredentials')}</span>
                <span className="transfer-toggle-hint">{t('connectionTransfer.includeCredentialsHint')}</span>
              </span>
              <Switch
                checked={includeCredentials}
                onCheckedChange={setIncludeCredentials}
                aria-label={t('connectionTransfer.includeCredentials')}
              />
            </div>

            {includeCredentials ? (
              <p className="transfer-warn">
                <DialogIcon name="warning" size={13} />
                <span>{t('connectionTransfer.credentialsIncludedWarning')}</span>
              </p>
            ) : (
              <p className="transfer-hint">{t('connectionTransfer.credentialsExcludedHint')}</p>
            )}
          </div>

          <footer className="dlg-foot">
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
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default ExportConnectionsDialog

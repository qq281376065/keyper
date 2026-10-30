import { useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DialogIcon } from '@/components/DialogIcon'
import { useDialogDrag } from '@/hooks/useDialogDrag'
import { extractUriFromText, parseConnectionUri } from '@/utils/connectionUri'
import type { RedisConnectionConfig } from '@shared/types'
import { useI18n } from '@/i18n'

export interface ImportUriDialogProps {
  /** 确认后把解析好的配置交给调用方（由它决定保存 / 直接连接） */
  onSubmit: (config: RedisConnectionConfig) => void
  onClose: () => void
  /** 从剪贴板预填的内容（可选） */
  initialText?: string
}

/**
 * 粘贴连接串新建连接。
 *
 * 为什么单独做一个弹窗而不是塞进 ConnectionDialog：
 *   · 真实使用场景是"别人给我一串 redis://…，我要立刻连上看看"，
 *     走完整表单要点开、填六个字段、再回来，成本太高；
 *   · 解析出的字段必须让用户先看一眼再确认 —— 静默按解析结果连接，
 *     万一解析错了会连到别的实例上，这在生产环境里很危险。
 *
 * 所以这里做"解析 → 预览 → 确认"三段式，确认后仍进入标准表单
 * （保留可编辑性），只是字段已经填好。
 */
export function ImportUriDialog({ onSubmit, onClose, initialText = '' }: ImportUriDialogProps) {
  const { style, onDragStart } = useDialogDrag()
  const { t } = useI18n()
  const [text, setText] = useState(initialText)
  const [name, setName] = useState('')

  /*
   * 解析是纯函数、开销极小，直接用 useMemo 跟着输入走，
   * 用户边粘贴边看到结果 —— 比"点一下解析"少一步，也更容易发现格式不对。
   */
  const parsed = useMemo(() => {
    if (!text.trim()) return null
    return parseConnectionUri(extractUriFromText(text))
  }, [text])

  const ok = parsed?.ok === true
  const value = ok ? parsed.value : null

  /** 默认名称：主机名 + 端口，用户可改。避免一堆"未命名"分不清 */
  const suggestedName = value ? `${value.host}:${value.port}` : ''

  async function pasteFromClipboard(): Promise<void> {
    try {
      const clip = await navigator.clipboard.readText()
      if (clip) setText(clip)
    } catch {
      /* 无权限或非安全上下文：让用户手动粘贴，不弹错误打断 */
    }
  }

  function handleSubmit(): void {
    if (!value) return
    onSubmit({
      id: `conn-${Date.now().toString(36)}`,
      /*
       * 连接串解析只产出 Redis 配置 —— URI 形态本就是 Redis 的约定，
       * Memcached 没有等价物（见 utils/engine 里对连接串的说明）。
       */
      engine: 'redis',
      name: name.trim() || suggestedName,
      host: value.host,
      port: value.port,
      username: value.username,
      password: value.password,
      db: value.db,
      tls: value.tls,
    })
    onClose()
  }

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent
        className="dialog dlg uri-dialog"
        style={style}
        showCloseButton={false}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <div className="dlg-shell">
          <header className="dlg-head" onMouseDown={onDragStart}>
            <div className="dlg-head-main">
              <div className="dlg-head-top">
                <span className="dlg-head-icon">
                  <DialogIcon name="link" size={15} />
                </span>
                <DialogTitle className="dlg-title">{t('importUriDialog.importConnectionString')}</DialogTitle>
              </div>
              <DialogDescription id="uri-desc" className="dlg-sub">
                {t('importUriDialog.supportsRedis')}
              </DialogDescription>
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
            <div className="field">
              <div className="field-label key-label">
                <Label htmlFor="uri-input">{t('importUriDialog.connectionString')}</Label>
                <button type="button" className="link-btn" onClick={() => void pasteFromClipboard()}>
                  <DialogIcon name="copy" size={12} />
                  {t('importUriDialog.pasteClipboard')}
                </button>
              </div>
              <Input
                id="uri-input"
                value={text}
                onChange={(event) => setText(event.target.value)}
                className="mono"
                placeholder="redis://:password@127.0.0.1:6379/0"
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </div>

            {/* 解析结果预览：确认前让用户核对，避免连错实例 */}
            {text.trim() ? (
              ok && value ? (
                <div className="uri-preview">
                  <div className="uri-preview-head">
                    <DialogIcon name="check" size={13} />
                    <span>{t('importUriDialog.parsedResult')}</span>
                  </div>
                  <dl className="uri-rows">
                    <div className="uri-row">
                      <dt>{t('connectionDialog.host')}</dt>
                      <dd className="mono">{value.host}</dd>
                    </div>
                    <div className="uri-row">
                      <dt>{t('connectionDialog.port')}</dt>
                      <dd className="mono">{value.port}</dd>
                    </div>
                    {value.username ? (
                      <div className="uri-row">
                        <dt>{t('connectionDialog.username')}</dt>
                        <dd className="mono">{value.username}</dd>
                      </div>
                    ) : null}
                    <div className="uri-row">
                      <dt>{t('connectionDialog.password')}</dt>
                      <dd className="mono">{value.password ? '••••••••' : t('importUriDialog.empty')}</dd>
                    </div>
                    <div className="uri-row">
                      <dt>{t('common.defaultDatabase')}</dt>
                      <dd className="mono">db{value.db}</dd>
                    </div>
                    <div className="uri-row">
                      <dt>TLS</dt>
                      <dd className="mono">{value.tls ? t('importUriDialog.enabled') : t('importUriDialog.disabled')}</dd>
                    </div>
                  </dl>
                  <div className="field">
                    <Label htmlFor="uri-name" className="field-label">
                      {t('connectionDialog.connectionName')}
                    </Label>
                    <Input
                      id="uri-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={suggestedName}
                      autoComplete="off"
                    />
                  </div>
                </div>
              ) : (
                <p className="uri-error">
                  <DialogIcon name="warning" size={13} />
                  {parsed && !parsed.ok ? t(parsed.error.key, parsed.error.params) : t('importUriDialog.unrecognized')}
                </p>
              )
            ) : null}
          </div>

          <footer className="dlg-foot">
            <span className="spacer" />
            <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={onClose}>
              <DialogIcon name="cancel" size={13} />
              {t('common.cancel')}
            </Button>
            <Button type="button" className="foot-btn foot-primary" disabled={!ok} onClick={handleSubmit}>
              <DialogIcon name="save" size={13} />
              {t('importUriDialog.fillIntoForm')}
            </Button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default ImportUriDialog

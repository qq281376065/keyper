import { useMemo, useState } from 'react'
import { api } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { DialogIcon } from '@/components/DialogIcon'
import { DialogShell } from '@/components/DialogShell'
import { EngineTag } from '@/components/EngineTag'
import { InlineNotice } from '@/components/InlineNotice'
import { useRedis } from '@/store/useRedis'
import { MAX_BATCH_URIS, extractUriFromText, parseConnectionUri, parseConnectionUriBatch } from '@/utils/connectionUri'
import type { ParsedConnectionUri } from '@/utils/connectionUri'
import type { CacheConnectionConfig } from '@shared/types'
import { useI18n } from '@/i18n'

export interface ImportUriDialogProps {
  /** 确认后把解析好的配置交给调用方（由它决定保存 / 直接连接） */
  onSubmit: (config: CacheConnectionConfig) => void
  onClose: () => void
  /** 从剪贴板预填的内容（可选） */
  initialText?: string
}

/**
 * 粘贴连接串新建连接。
 *
 * 单行时保持原有「解析 → 预览 → 填入表单」流程：字段必须让用户先核对，
 * 静默按解析结果连接，万一解析错了会连到别的实例上。
 *
 * 多行时切换为批量导入：逐行解析、逐行展示错误，确认后一次性写盘。
 * 批量不进入标准表单 —— N 条记录无法用一张表单承载，也没必要逐条改名，
 * 名称默认取 host:port，重名由服务端合并规则自动加序号。
 */
export function ImportUriDialog({ onSubmit, onClose, initialText = '' }: ImportUriDialogProps) {
  const { t } = useI18n()
  const { notify, applyImportedConnections } = useRedis()
  const [text, setText] = useState(initialText)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const batch = useMemo(() => parseConnectionUriBatch(text), [text])
  const isBatch = batch.entries.length > 1

  /* 单行模式的解析结果与旧实现保持一致：从整段文本里捞出第一个连接串 */
  const single = useMemo(() => {
    if (!text.trim()) return null
    return parseConnectionUri(extractUriFromText(text))
  }, [text])

  const singleValue = single?.ok ? single.value : null
  const singleOk = single?.ok === true

  /** 默认名称：主机名 + 端口，用户可改。避免一堆"未命名"分不清 */
  const suggestedName = singleValue ? `${singleValue.host}:${singleValue.port}` : ''

  function buildConfig(value: ParsedConnectionUri, label: string, idSeed: string): CacheConnectionConfig {
    const id = `conn-uri-${Date.now().toString(36)}-${idSeed}`
    if (value.engine === 'memcached') {
      return { id, engine: 'memcached', name: label, host: value.host, port: value.port, poolSize: 4 }
    }
    return {
      id,
      engine: 'redis',
      name: label,
      host: value.host,
      port: value.port,
      username: value.username,
      password: value.password,
      db: value.db,
      tls: value.tls,
    }
  }

  async function pasteFromClipboard(): Promise<void> {
    try {
      const clip = await navigator.clipboard.readText()
      if (clip) setText(clip)
    } catch {
      notify('err', t('importUriDialog.clipboardFailed'))
    }
  }

  function handleSubmit(): void {
    if (!singleValue) return
    onSubmit(buildConfig(singleValue, name.trim() || suggestedName, 'single'))
    onClose()
  }

  async function handleBatchImport(): Promise<void> {
    if (busy || batch.tooMany) return
    const configs: CacheConnectionConfig[] = []
    for (const entry of batch.entries) {
      if (!entry.result.ok) continue
      const value = entry.result.value
      configs.push(buildConfig(value, `${value.host}:${value.port}`, String(entry.line)))
    }
    if (!configs.length) return

    setBusy(true)
    try {
      const res = await api.connection.saveMany(configs)
      if (!res.ok) throw new Error(res.error)
      applyImportedConnections(res.data.connections)
      notify('ok', t('importUriDialog.batchImported', { count: res.data.summary.imported }))
      onClose()
    } catch (error) {
      notify('err', error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const showBatchHint = !text.trim() || isBatch

  return (
    <DialogShell
      icon="link"
      title={t('importUriDialog.importConnectionString')}
      description={t('importUriDialog.supportsRedis')}
      className="uri-dialog"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={onClose}>
            <DialogIcon name="cancel" size={13} />
            {t('common.cancel')}
          </Button>
          {isBatch ? (
            <Button
              type="button"
              className="foot-btn foot-primary"
              disabled={!batch.valid || batch.tooMany || busy}
              onClick={() => void handleBatchImport()}
            >
              <DialogIcon name="import" size={13} />
              {busy
                ? t('connectionTransfer.importing')
                : t('importUriDialog.batchImportCount', { count: batch.valid })}
            </Button>
          ) : (
            <Button type="button" className="foot-btn foot-primary" disabled={!singleOk} onClick={handleSubmit}>
              <DialogIcon name="save" size={13} />
              {t('importUriDialog.fillIntoForm')}
            </Button>
          )}
        </>
      }
    >
      <div className="field">
        <div className="field-label key-label">
          <Label htmlFor="uri-input">{t('importUriDialog.connectionString')}</Label>
          <button type="button" className="link-btn" onClick={() => void pasteFromClipboard()}>
            <DialogIcon name="copy" size={12} />
            {t('importUriDialog.pasteClipboard')}
          </button>
        </div>
        <Textarea
          id="uri-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="mono uri-input"
          placeholder={'redis://:password@127.0.0.1:6379/0\nmemcached://127.0.0.1:11211'}
          autoComplete="off"
          spellCheck={false}
          rows={isBatch ? 5 : 2}
          autoFocus
        />
        {showBatchHint ? <p className="uri-hint">{t('importUriDialog.batchHint')}</p> : null}
      </div>

      {isBatch ? (
        <div className="uri-batch">
          <div className={`uri-batch-head${batch.invalid ? ' has-invalid' : ''}`}>
            <DialogIcon name={batch.invalid ? 'warning' : 'check'} size={13} />
            <span>{t('importUriDialog.detectedSummary', { valid: batch.valid, invalid: batch.invalid })}</span>
            <span className="uri-batch-limit mono">
              {batch.total}/{MAX_BATCH_URIS}
            </span>
          </div>

          {batch.tooMany ? (
            <InlineNotice tone="danger">
              {t('importUriDialog.tooManyLines', { max: MAX_BATCH_URIS })}
            </InlineNotice>
          ) : null}

          <div className="uri-batch-list">
            {batch.entries.map((entry) => (
              <div
                className={`uri-batch-row${entry.result.ok ? '' : ' invalid'}`}
                key={entry.line}
              >
                <span className="uri-batch-line mono">
                  {t('importUriDialog.lineNumber', { line: entry.line })}
                </span>
                {entry.result.ok ? (
                  <>
                    <EngineTag engine={entry.result.value.engine} />
                    <span className="uri-batch-addr mono">
                      {entry.result.value.host}:{entry.result.value.port}
                      {entry.result.value.engine === 'redis' ? ` · db${entry.result.value.db}` : ''}
                      {entry.result.value.tls ? ' · TLS' : ''}
                    </span>
                    <span className="uri-batch-auth">
                      {entry.result.value.password
                        ? t('importUriDialog.hasPassword')
                        : t('importUriDialog.noCredentials')}
                    </span>
                  </>
                ) : (
                  <span className="uri-batch-error">
                    {t(entry.result.error.key, entry.result.error.params)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : text.trim() ? (
        singleOk && singleValue ? (
          <div className="uri-preview">
            <div className="uri-preview-head">
              <DialogIcon name="check" size={13} />
              <span>{t('importUriDialog.parsedResult')}</span>
            </div>
            <dl className="uri-rows">
              <div className="uri-row">
                <dt>{t('importUriDialog.engine')}</dt>
                <dd>
                  <EngineTag engine={singleValue.engine} />
                </dd>
              </div>
              <div className="uri-row">
                <dt>{t('connectionDialog.host')}</dt>
                <dd className="mono">{singleValue.host}</dd>
              </div>
              <div className="uri-row">
                <dt>{t('connectionDialog.port')}</dt>
                <dd className="mono">{singleValue.port}</dd>
              </div>
              {singleValue.engine === 'redis' ? (
                <>
                  {singleValue.username ? (
                    <div className="uri-row">
                      <dt>{t('connectionDialog.username')}</dt>
                      <dd className="mono">{singleValue.username}</dd>
                    </div>
                  ) : null}
                  <div className="uri-row">
                    <dt>{t('connectionDialog.password')}</dt>
                    <dd className="mono">
                      {singleValue.password ? '••••••••' : t('importUriDialog.empty')}
                    </dd>
                  </div>
                  <div className="uri-row">
                    <dt>{t('common.defaultDatabase')}</dt>
                    <dd className="mono">db{singleValue.db}</dd>
                  </div>
                  <div className="uri-row">
                    <dt>TLS</dt>
                    <dd className="mono">
                      {singleValue.tls ? t('importUriDialog.enabled') : t('importUriDialog.disabled')}
                    </dd>
                  </div>
                </>
              ) : (
                <div className="uri-row">
                  <dt>{t('importUriDialog.credentials')}</dt>
                  <dd className="mono">{t('importUriDialog.noCredentials')}</dd>
                </div>
              )}
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
          <InlineNotice tone="danger">
            {single && !single.ok ? t(single.error.key, single.error.params) : t('importUriDialog.unrecognized')}
          </InlineNotice>
        )
      ) : null}
    </DialogShell>
  )
}

export default ImportUriDialog

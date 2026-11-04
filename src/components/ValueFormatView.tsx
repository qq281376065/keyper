import { useEffect, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { useI18n } from '@/i18n'
import { useRedis } from '@/store/useRedis'
import type { ValueFormatsApi } from '@/hooks/useValueFormats'

const IMAGE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024

function ImagePreview({
  base64,
  mime,
  bytes,
  truncated,
  keyName,
}: {
  base64: string
  mime: string
  bytes: number
  truncated: boolean
  keyName: string
}) {
  const { t } = useI18n()
  const { notify } = useRedis()
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    try {
      const binary = atob(base64)
      const data = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i)
      const objectUrl = URL.createObjectURL(new Blob([data], { type: mime }))
      setUrl(objectUrl)
      return () => URL.revokeObjectURL(objectUrl)
    } catch {
      setUrl(null)
      return undefined
    }
  }, [base64, mime])

  const tooLarge = bytes > IMAGE_PREVIEW_MAX_BYTES

  async function save(): Promise<void> {
    const ext = mime.split('/')[1] || 'bin'
    const res = await api.file.saveBytes({
      base64,
      suggestedName: `${keyName.replace(/[\\/:*?"<>|]/g, '_')}.${ext}`,
    })
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (res.data.saved) notify('ok', t('common.saved'))
  }

  return (
    <div className="format-image">
      <div className="format-view-head">
        <span className="mono">{mime}</span>
        <span className="mono">{t('valueFormats.bytes', { count: bytes })}</span>
        {truncated ? <span className="format-warn">{t('valueFormats.truncated')}</span> : null}
        <span className="spacer" />
        <button className="tool" onClick={() => void save()}>
          <DialogIcon name="export" size={12} className="ti" />
          {t('valueFormats.saveImage')}
        </button>
      </div>
      {tooLarge ? (
        <p className="format-error-text">{t('valueFormats.imageTooLarge')}</p>
      ) : url ? (
        <div className="format-image-stage">
          <img src={url} alt={keyName} />
        </div>
      ) : (
        <p className="format-error-text">{t('valueFormats.decodeFailed')}</p>
      )}
    </div>
  )
}

export function ValueFormatView({ formats, keyName }: { formats: ValueFormatsApi; keyName: string }) {
  const { t } = useI18n()

  if (formats.loading) {
    return (
      <div className="format-view-wrap">
        <p className="format-loading">
          <span className="spinner" />
          {t('valueFormats.loading')}
        </p>
      </div>
    )
  }

  if (formats.error) {
    return (
      <div className="format-view-wrap">
        <div className="format-view-head">
          <span className="format-error-text">{t('valueFormats.decodeFailed')}</span>
          <span className="spacer" />
          <button className="tool" onClick={formats.reset}>
            <DialogIcon name="cancel" size={12} className="ti" />
            {t('valueFormats.raw')}
          </button>
        </div>
        <pre className="format-text mono format-error-text">{formats.error}</pre>
      </div>
    )
  }

  const view = formats.view
  if (!view) return null

  if (view.kind === 'image') {
    return (
      <div className="format-view-wrap">
        <ImagePreview
          base64={view.base64}
          mime={view.mime}
          bytes={view.bytes}
          truncated={view.truncated}
          keyName={keyName}
        />
      </div>
    )
  }

  return (
    <div className="format-view-wrap">
      <div className="format-view-head">
        <span className="mono">
          {view.kind === 'hex' ? t('valueFormats.hex') : t('valueFormats.format')}
        </span>
        {view.kind === 'text' && view.bytes != null ? (
          <span className="mono">{t('valueFormats.bytes', { count: view.bytes })}</span>
        ) : null}
        {view.kind === 'hex' ? (
          <span className="mono">{t('valueFormats.bytes', { count: view.bytes })}</span>
        ) : null}
        {view.truncated ? <span className="format-warn">{t('valueFormats.truncated')}</span> : null}
        <span className="spacer" />
        <button className="tool" onClick={formats.reset}>
          <DialogIcon name="cancel" size={12} className="ti" />
          {t('valueFormats.raw')}
        </button>
      </div>
      <pre className={`format-text mono${view.kind === 'hex' ? ' format-hex' : ''}`}>
        {view.kind === 'text' ? view.text : view.rows.join('\n')}
      </pre>
    </div>
  )
}

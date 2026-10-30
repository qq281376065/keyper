import { useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { DialogShell } from '@/components/DialogShell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useI18n } from '@/i18n'
import type { MsgKey } from '@shared/i18n'
import { api } from '@/api'
import { formatBytes } from '@/utils/format'

/**
 * Memcached 新建 / 编辑缓存项。
 *
 * 为什么不复用 Redis 的 CreateKeyDialog：
 *   那个弹窗的核心是"六种数据类型"——string / hash / list / set / zset / stream
 *   各有自己的编辑器与 TTL 语义。Memcached 只有一种东西：一个键 + 一段字节，
 *   外加一个过期时间。把类型选择器、字段表格、成员列表摆给 Memcached 用户，
 *   等于逼他理解一套根本不存在的模型。
 *
 * 因此这里只保留 Memcached 真有的四个输入：
 *   键名、值、过期时间、写入模式（set / add / replace）。
 * 写入模式是 Memcached 协议真实存在的语义，单独暴露比永远用 set 更有用 ——
 * "只在不存在时写入"是缓存里最常见的诉求（防覆盖正在回源的请求）。
 */

export interface MemcachedKeyDialogProps {
  connectionId: string
  /** 传入则为编辑（键名锁定），否则为新建 */
  initial?: { key: string; data: string; flags: number } | null
  /** 新建时预填的键名前缀（目录右键「添加新键」） */
  prefix?: string
  onClose: () => void
  onSaved: (key: string) => void
}

/** 常用过期时间：0 = 永久。列出常见档位而不是让用户手算秒数 */
const EXPIRY_OPTIONS: Array<{ value: string; label: MsgKey }> = [
  { value: '0', label: 'common.noExpiration' },
  { value: '60', label: 'common.oneMinute' },
  { value: '300', label: 'common.fiveMinutes' },
  { value: '1800', label: 'common.thirtyMinutes' },
  { value: '3600', label: 'common.oneHour' },
  { value: '21600', label: 'common.sixHours' },
  { value: '86400', label: 'common.oneDay' },
  { value: '604800', label: 'common.sevenDays' },
]

export function MemcachedKeyDialog({
  connectionId,
  initial = null,
  prefix = '',
  onClose,
  onSaved,
}: MemcachedKeyDialogProps) {
  const { t } = useI18n()
  const isEdit = !!initial

  const [key, setKey] = useState(initial?.key ?? prefix)
  const [value, setValue] = useState(initial?.data ?? '')
  const [expiry, setExpiry] = useState('0')
  const [mode, setMode] = useState<'set' | 'add' | 'replace'>('set')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const bytes = new TextEncoder().encode(value).length
  const keyOk = key.trim().length > 0
  /* Memcached 的键不能含空格与控制字符（协议用空格分隔字段） */
  const keyBadChar = /[\s\u0000-\u001f]/.test(key)
  const canSubmit = keyOk && !keyBadChar && !saving

  async function submit(): Promise<void> {
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    try {
      const res = await api.memcached.set(connectionId, key.trim(), value, {
        exptime: Number(expiry) || 0,
        /* 编辑时永远用 set：改一个已存在的键，"仅当不存在"没有意义 */
        mode: isEdit ? 'set' : mode,
      })
      if (!res.ok) throw new Error(res.error)
      if (!res.data.ok) throw new Error(res.data.message ?? t('memcachedKeyDialog.writeFailed'))
      onSaved(key.trim())
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('memcachedKeyDialog.writeFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogShell
      icon={isEdit ? 'edit' : 'add'}
      title={isEdit ? t('memcachedKeyDialog.editCacheItem') : t('memcachedKeyBrowser.newCachedItem')}
      description={t('memcachedKeyDialog.memcachedKeysFlat')}
      badge={<span className="dlg-badge">Memcached</span>}
      className="mc-key-dialog"
      onClose={onClose}
      footer={
        <>
          <span className="stat mono">{t('memcachedKeyDialog.bytes', { bytes: bytes.toLocaleString() })}</span>
          <span className="spacer" />
          <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={onClose}>
            <DialogIcon name="cancel" size={13} />
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            className="foot-btn foot-primary"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            <DialogIcon name="save" size={13} />
            {saving ? t('memcachedKeyDialog.writing') : isEdit ? t('common.save') : t('common.create')}
          </Button>
        </>
      }
    >
      <div className="field">
        <Label htmlFor="mc-key" className="field-label">
          {t('common.keyName')}
          <span className="req" aria-hidden="true">
            *
          </span>
        </Label>
        <Input
          id="mc-key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          className={`mono${keyBadChar ? ' is-invalid' : ''}`}
          placeholder={t('memcachedKeyDialog.e')}
          autoComplete="off"
          /* 编辑时键名锁定：改名等于删旧键再建新键，语义上不是"编辑" */
          disabled={isEdit}
          autoFocus
        />
        {keyBadChar ? (
          <p className="ml-field-hint is-error">{t('memcachedKeyDialog.keyNamesCannotContainSpaces')}</p>
        ) : (
          <p className="ml-field-hint">{t('memcachedKeyDialog.noSpacesControlCharactersUse')}</p>
        )}
      </div>

      <div className="field">
        <Label htmlFor="mc-value" className="field-label">
          {t('memcachedKeyDialog.value')}
        </Label>
        <Textarea
          id="mc-value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="mono dlg-content"
          autoGrow
          spellCheck={false}
          placeholder={t('memcachedKeyDialog.contentWriteMultipleLines')}
        />
      </div>

      <div className="field-row">
        <div className="field grow">
          <Label htmlFor="mc-expiry" className="field-label">
            {t('memcachedKeyDialog.expirationTime')}
          </Label>
          <Select value={expiry} onValueChange={setExpiry}>
            <SelectTrigger id="mc-expiry" className="dlg-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="dlg-select-menu">
              {EXPIRY_OPTIONS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {t(item.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="field grow">
          <Label htmlFor="mc-mode" className="field-label">
            {t('memcachedKeyDialog.writeMode')}
          </Label>
          <Select
            value={isEdit ? 'set' : mode}
            onValueChange={(next) => setMode(next as 'set' | 'add' | 'replace')}
            disabled={isEdit}
          >
            <SelectTrigger id="mc-mode" className="dlg-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="dlg-select-menu">
              <SelectItem value="set">{t('memcachedKeyDialog.overwrite')}</SelectItem>
              <SelectItem value="add">{t('memcachedKeyDialog.onlyIfAbsent')}</SelectItem>
              <SelectItem value="replace">{t('memcachedKeyDialog.onlyIfPresent')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {error ? <div className="dlg-alert is-err">{error}</div> : null}

      {isEdit ? (
        <p className="ml-field-hint">
          {t('memcachedKeyDialog.currentSizeFlags', { size: formatBytes(bytes), flags: initial?.flags ?? 0 })}
        </p>
      ) : null}
    </DialogShell>
  )
}

export default MemcachedKeyDialog

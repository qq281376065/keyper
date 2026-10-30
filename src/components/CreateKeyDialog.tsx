import { useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { useDialogDrag } from '@/hooks/useDialogDrag'
import { useI18n } from '@/i18n'
import { useRedis } from '@/store/useRedis'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
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
import type { RedisValueType } from '@shared/types'
import type { MsgKey } from '@shared/i18n'

const TYPES: Array<{ value: RedisValueType; label: MsgKey }> = [
  { value: 'string', label: 'type.string' },
  { value: 'hash', label: 'type.hash' },
  { value: 'list', label: 'type.list' },
  { value: 'set', label: 'type.set' },
  { value: 'zset', label: 'type.zset' },
  { value: 'stream', label: 'type.stream' },
]

export interface CreateKeyDialogProps {
  /**
   * 前缀模式：从树节点右键「添加新键」进入时传入。
   * 语义是"在这个前缀下新建"，前缀本身不可改 —— 用户已经用右键
   * 明确指向了某个目录，再让他在输入框里删改前缀，很容易手滑
   * 建到别的前缀下去，事后极难发现。
   */
  prefix?: string
  /** 分隔符，决定前缀与后缀的拼接方式 */
  separator?: string
  onClose: () => void
  onCreated: (key: string) => void
}

/** 新建键：键名（可带固定前缀）、类型、TTL、初始内容 */
export function CreateKeyDialog({ prefix, separator, onClose, onCreated }: CreateKeyDialogProps) {
  const { t } = useI18n()
  const { state, notify } = useRedis()

  const sep = separator || ':'

  /** 用户实际输入的"后缀"部分；无前缀模式下它就是完整键名 */
  const [suffix, setSuffix] = useState('')
  const [keyType, setKeyType] = useState<RedisValueType>('string')
  const [content, setContent] = useState('')
  const [ttl, setTtl] = useState('')
  const [submitting, setSubmitting] = useState(false)

  /** 最终键名 = 前缀 + 分隔符 + 后缀（无前缀时直接用后缀） */
  const keyName = prefix ? (suffix.trim() ? `${prefix}${sep}${suffix.trim()}` : '') : suffix

  const placeholder =
    keyType === 'hash'
      ? t('createKeyDialog.oneFieldPerLineValue')
      : keyType === 'list'
        ? t('createKeyDialog.oneElementPerLineWritten')
        : keyType === 'set'
          ? t('createKeyDialog.oneMemberPerLineDuplicates')
          : keyType === 'zset'
            ? t('createKeyDialog.oneMemberPerLine')
            : keyType === 'stream'
              ? t('createKeyDialog.oneFieldPerLine')
              : t('createKeyDialog.stringContentSpanMultipleLines')

  const hint =
    keyType === 'hash'
      ? t('createKeyDialog.fieldValueSeparatedFirst')
      : keyType === 'zset'
        ? t('createKeyDialog.memberScoreSeparated')
        : keyType === 'stream'
          ? t('createKeyDialog.fieldsValuesSeparated')
          : keyType === 'string'
            ? t('createKeyDialog.leaveEmptyCreateStringKey')
            : t('createKeyDialog.fillLeastOneLineRedis')

  const canSubmit = keyName.trim().length > 0 && !submitting

  function parseLines(): string[] {
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  }

  function buildPayload(): string | string[] | Record<string, string> {
    if (keyType === 'string') return content
    if (keyType === 'hash') {
      const record: Record<string, string> = {}
      for (const line of parseLines()) {
        const index = line.indexOf('=')
        if (index <= 0) continue
        record[line.slice(0, index).trim()] = line.slice(index + 1).trim()
      }
      return record
    }
    return parseLines()
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return

    const id = state.activeId
    if (!id) {
      notify('err', t('cliConsole.connectFirst'))
      return
    }

    const name = keyName.trim()
    if (name.includes(' ')) {
      notify('err', t('createKeyDialog.keyNamesNotContainSpaces'))
      return
    }

    let ttlSeconds: number | undefined
    /* String() 归一：防上游把值改成 number（zset 弹窗同款炸雷的兜底） */
    const ttlText = String(ttl ?? '')
    if (ttlText.trim()) {
      const parsed = Number(ttlText)
      if (!Number.isInteger(parsed) || parsed < 0) {
        notify('err', t('createKeyDialog.ttlIntegerNumberSeconds'))
        return
      }
      ttlSeconds = parsed
    }

    setSubmitting(true)
    try {
      const res = await api.redis.createKey(id, name, keyType, buildPayload(), ttlSeconds)
      if (!res.ok) {
        notify('err', res.error)
        return
      }
      if (!res.data.ok) {
        notify('err', res.data.message ?? t('createKeyDialog.createFailed'))
        return
      }
      notify('ok', res.data.message ?? t('createKeyDialog.createdName', { name }))
      onCreated(name)
    } catch (error) {
      notify('err', error instanceof Error ? error.message : t('createKeyDialog.createFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  const { style, onDragStart } = useDialogDrag()

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent
        className="dialog dlg create-key-dialog"
        style={style}
        showCloseButton={false}
        /* 点击遮罩不关闭：键名与内容可能已填一半，误触外部导致全丢代价太高 */
        onPointerDownOutside={(event) => event.preventDefault()}
        aria-describedby="ck-desc"
      >
        <div className="dlg-shell">
          <header className="dlg-head" onMouseDown={onDragStart}>
            <div className="dlg-head-main">
              <div className="dlg-head-top">
                {/*
                  图标语义：新建键的产物是"一条键值记录"，用 text（三行文本条目）
                  比 add（加号）更贴切 —— 加号与连接弹窗的「新建连接」重复，
                  在标题栏里两个弹窗看起来会是同一个图标。
                */}
                <span className="dlg-head-icon">
                  <DialogIcon name="text" size={15} />
                </span>
                <DialogTitle className="dlg-title">{t('common.newKey')}</DialogTitle>
                {/* 当前库：与连接弹窗的副标题同一行位置，用胶囊徽标区分 */}
                <span className="dlg-badge mono">db{state.activeDb}</span>
              </div>
              <DialogDescription id="ck-desc" className="dlg-sub">
                {prefix
                  ? t('createKeyDialog.createdUnderPrefixCannotChanged', { prefix })
                  : t('createKeyDialog.enterKeyNameTypeInitial')}
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
            <section className="dlg-section">
              <h3 className="dlg-section-title">{t('createKeyDialog.keyInfo')}</h3>

              <div className="field">
                <Label htmlFor="ck-name" className="field-label">
                  {t('common.keyName')}
                  <span className="req" aria-hidden="true">
                    *
                  </span>
                  {prefix ? <span className="prefix-hint">{t('createKeyDialog.prefixFixedEnterOnlyRest')}</span> : null}
                </Label>

                {/*
                  前缀模式：前缀作为不可编辑的静态片断贴在输入框左侧，
                  与用户输入的后缀视觉上连成一个完整键名。
                  两段之间由分隔符衔接，输入框里只填后缀。
                */}
                <span className="key-input-wrap">
                  {prefix ? (
                    <span className="prefix-fixed mono">
                      {prefix}
                      {sep}
                    </span>
                  ) : null}
                  <Input
                    id="ck-name"
                    value={suffix}
                    onChange={(event) => setSuffix(event.target.value)}
                    className="mono"
                    placeholder={prefix ? t('createKeyDialog.remainingKeyName') : t('createKeyDialog.e')}
                    autoFocus
                    spellCheck={false}
                    autoComplete="off"
                  />
                </span>

                {/* 实时预览最终键名：前缀 + 后缀的组合结果比两段更直观 */}
                {prefix && keyName ? (
                  <span className="hint full-name">
                    {t('createKeyDialog.create')}
                    <b className="mono">{keyName}</b>
                  </span>
                ) : null}
              </div>

              <div className="field-row">
                <div className="field grow">
                  <Label htmlFor="ck-type" className="field-label">
                    {t('common.type')}
                  </Label>
                  <Select value={keyType} onValueChange={(next) => setKeyType(next as RedisValueType)}>
                    <SelectTrigger id="ck-type" className="dlg-select">
                      <SelectValue placeholder={t('createKeyDialog.selectType')} />
                    </SelectTrigger>
                    <SelectContent className="dlg-select-menu">
                      {TYPES.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {t(item.label)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="field ttl">
                  <Label htmlFor="ck-ttl" className="field-label">
                    {t('createKeyDialog.ttl')}
                  </Label>
                  {/* 不用 type="number"：提交时的 .trim() 会直接抛错 */}
                  <Input
                    id="ck-ttl"
                    value={ttl}
                    onChange={(event) => setTtl(event.target.value)}
                    className="mono"
                    inputMode="numeric"
                    placeholder={t('createKeyDialog.blankNoExpiration')}
                  />
                </div>
              </div>
            </section>

            <section className="dlg-section">
              <h3 className="dlg-section-title">{t('createKeyDialog.initialContent')}</h3>
              <div className="field">
                <Textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  className="mono ck-content"
                  spellCheck={false}
                  placeholder={placeholder}
                />
                <span className="hint">{hint}</span>
              </div>
            </section>
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
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              <DialogIcon name="add" size={13} />
              {submitting ? t('createKeyDialog.creating') : t('common.create')}
            </Button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default CreateKeyDialog

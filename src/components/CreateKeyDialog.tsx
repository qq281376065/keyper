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

const TYPES: Array<{ value: RedisValueType; label: string }> = [
  { value: 'string', label: 'string · 字符串' },
  { value: 'hash', label: 'hash · 哈希' },
  { value: 'list', label: 'list · 列表' },
  { value: 'set', label: 'set · 集合' },
  { value: 'zset', label: 'zset · 有序集合' },
  { value: 'stream', label: 'stream · 流' },
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
      ? t('每行一个字段，格式 field=value，例如：\nname=张伟\ncity=长沙')
      : keyType === 'list'
        ? t('每行一个元素，按输入顺序从左到右写入')
        : keyType === 'set'
          ? t('每行一个成员，重复项会被自动去重')
          : keyType === 'zset'
            ? t('每行格式 member::score，例如：\nitem:1::98.5')
            : keyType === 'stream'
              ? t('每行格式 field::value，例如：\nname::张伟\ncity::长沙')
              : t('字符串内容，可多行')

  const hint =
    keyType === 'hash'
      ? t('字段与值以第一个 = 分隔')
      : keyType === 'zset'
        ? t('成员与分值以 :: 分隔，分值需为数字')
        : keyType === 'stream'
          ? t('字段与值以 :: 分隔；消息 ID 由 Redis 自动生成')
          : keyType === 'string'
            ? t('内容留空则创建一个空字符串键')
            : t('至少填写一行 —— Redis 容器类型需要有元素才会真正落库')

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
      notify('err', t('请先建立连接'))
      return
    }

    const name = keyName.trim()
    if (name.includes(' ')) {
      notify('err', t('键名不建议包含空格'))
      return
    }

    let ttlSeconds: number | undefined
    /* String() 归一：防上游把值改成 number（zset 弹窗同款炸雷的兜底） */
    const ttlText = String(ttl ?? '')
    if (ttlText.trim()) {
      const parsed = Number(ttlText)
      if (!Number.isInteger(parsed) || parsed < 0) {
        notify('err', t('TTL 需为不小于 0 的整数秒'))
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
        notify('err', res.data.message ?? t('创建失败'))
        return
      }
      notify('ok', res.data.message ?? t('已创建 {name}', { name }))
      onCreated(name)
    } catch (error) {
      notify('err', error instanceof Error ? error.message : t('创建失败'))
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
                <DialogTitle className="dlg-title">{t('新建键')}</DialogTitle>
                {/* 当前库：与连接弹窗的副标题同一行位置，用胶囊徽标区分 */}
                <span className="dlg-badge mono">db{state.activeDb}</span>
              </div>
              <DialogDescription id="ck-desc" className="dlg-sub">
                {prefix
                  ? t('在 {prefix} 下创建，前缀不可修改', { prefix })
                  : t('填写键名、类型与初始内容')}
              </DialogDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="dlg-close"
              aria-label={t('关闭')}
              onClick={onClose}
            >
              <DialogIcon name="cancel" size={13} />
            </Button>
          </header>

          <div className="dlg-body">
            <section className="dlg-section">
              <h3 className="dlg-section-title">{t('键信息')}</h3>

              <div className="field">
                <Label htmlFor="ck-name" className="field-label">
                  {t('键名')}
                  <span className="req" aria-hidden="true">
                    *
                  </span>
                  {prefix ? <span className="prefix-hint">{t('前缀固定，只需填写后半段')}</span> : null}
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
                    placeholder={prefix ? t('后半段键名') : t('例如 user:1001:profile')}
                    autoFocus
                    spellCheck={false}
                    autoComplete="off"
                  />
                </span>

                {/* 实时预览最终键名：前缀 + 后缀的组合结果比两段更直观 */}
                {prefix && keyName ? (
                  <span className="hint full-name">
                    {t('将创建：')}
                    <b className="mono">{keyName}</b>
                  </span>
                ) : null}
              </div>

              <div className="field-row">
                <div className="field grow">
                  <Label htmlFor="ck-type" className="field-label">
                    {t('类型')}
                  </Label>
                  <Select value={keyType} onValueChange={(next) => setKeyType(next as RedisValueType)}>
                    <SelectTrigger id="ck-type" className="dlg-select">
                      <SelectValue placeholder={t('选择类型')} />
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
                    {t('TTL（秒，可空）')}
                  </Label>
                  {/* 不用 type="number"：提交时的 .trim() 会直接抛错 */}
                  <Input
                    id="ck-ttl"
                    value={ttl}
                    onChange={(event) => setTtl(event.target.value)}
                    className="mono"
                    inputMode="numeric"
                    placeholder={t('留空 = 永久')}
                  />
                </div>
              </div>
            </section>

            <section className="dlg-section">
              <h3 className="dlg-section-title">{t('初始内容')}</h3>
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
              {t('取消')}
            </Button>
            <Button
              type="button"
              className="foot-btn foot-primary"
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              <DialogIcon name="add" size={13} />
              {submitting ? t('创建中…') : t('创建')}
            </Button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default CreateKeyDialog

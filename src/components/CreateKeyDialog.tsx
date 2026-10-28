import { useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useDialogDrag } from '@/hooks/useDialogDrag'
import { useRedis } from '@/store/useRedis'
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
      ? '每行一个字段，格式 field=value，例如：\nname=张伟\ncity=长沙'
      : keyType === 'list'
        ? '每行一个元素，按输入顺序从左到右写入'
        : keyType === 'set'
          ? '每行一个成员，重复项会被自动去重'
          : keyType === 'zset'
            ? '每行格式 member::score，例如：\nitem:1::98.5'
            : keyType === 'stream'
              ? '每行格式 field::value，例如：\nname::张伟\ncity::长沙'
              : '字符串内容，可多行'

  const hint =
    keyType === 'hash'
      ? '字段与值以第一个 = 分隔'
      : keyType === 'zset'
        ? '成员与分值以 :: 分隔，分值需为数字'
        : keyType === 'stream'
          ? '字段与值以 :: 分隔；消息 ID 由 Redis 自动生成'
          : keyType === 'string'
            ? '内容留空则创建一个空字符串键'
            : '至少填写一行 —— Redis 容器类型需要有元素才会真正落库'

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
      notify('err', '请先建立连接')
      return
    }

    const name = keyName.trim()
    if (name.includes(' ')) {
      notify('err', '键名不建议包含空格')
      return
    }

    let ttlSeconds: number | undefined
    /* String() 归一：防上游把值改成 number（zset 弹窗同款炸雷的兜底） */
    const ttlText = String(ttl ?? '')
    if (ttlText.trim()) {
      const parsed = Number(ttlText)
      if (!Number.isInteger(parsed) || parsed < 0) {
        notify('err', 'TTL 需为不小于 0 的整数秒')
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
        notify('err', res.data.message ?? '创建失败')
        return
      }
      notify('ok', res.data.message ?? `已创建 ${name}`)
      onCreated(name)
    } catch (error) {
      notify('err', error instanceof Error ? error.message : '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  const { style, onDragStart } = useDialogDrag()

  return (
    <div className="mask s-create-key-dialog">
      <div className="dialog" style={style}>
        <header className="dialog-head" onMouseDown={onDragStart}>
          <span>新建键</span>
          <span className="where mono">db{state.activeDb}</span>
          <span className="spacer" />
          <button className="btn-ghost tiny" onClick={onClose}>
            <DialogIcon name="cancel" size={12} />
          </button>
        </header>

        <div className="dialog-body">
          <label className="field">
            <span className="label">
              键名 <i>*</i>
              {prefix ? <span className="prefix-hint">前缀固定，只需填写后半段</span> : null}
            </span>

            {/*
              前缀模式：前缀作为静态片断展示在输入框左侧，
              视觉上与输入内容连成一个完整的键名，但它不可编辑。
            */}
            {/* 实时预览最终键名：前缀 + 后缀的组合结果比两段更直观 */}
            {prefix && keyName ? (
              <span className="hint full-name">
                将创建：<b className="mono">{keyName}</b>
              </span>
            ) : null}
          </label>

          <div className="field-row">
            <label className="field grow">
              <span className="label">类型</span>
              <select
                value={keyType}
                onChange={(event) => setKeyType(event.target.value as RedisValueType)}
              >
                {TYPES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field ttl">
              <span className="label">TTL（秒，可空）</span>
              {/* 不用 type="number"：v-model 会把值自动转成 JS 数字，
                  提交时的 .trim() 直接抛错（zset 弹窗同款炸雷） */}
              <input
                value={ttl}
                onChange={(event) => setTtl(event.target.value)}
                className="mono"
                inputMode="numeric"
                min="0"
                placeholder="留空 = 永久"
              />
            </label>
          </div>

          <label className="field">
            <span className="label">初始内容</span>
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              className="content mono"
              spellCheck={false}
              placeholder={placeholder}
            />
            <span className="hint">{hint}</span>
          </label>
        </div>

        <footer className="dialog-foot">
          <span className="foot-hint">创建后会自动选中该键，可在右侧继续编辑</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            <DialogIcon name="cancel" />
            取消
          </button>
          <button className="btn-primary btn" disabled={!canSubmit} onClick={() => void submit()}>
            <DialogIcon name="add" />
            {submitting ? '创建中…' : '创建'}
          </button>
        </footer>
      </div>
    </div>
  )
}

export default CreateKeyDialog

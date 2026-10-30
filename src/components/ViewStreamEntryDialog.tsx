import { useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { DialogShell } from '@/components/DialogShell'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { useRedis } from '@/store/useRedis'
import { copyText } from '@/utils/clipboard'
import { formatBytes } from '@/utils/format'

export interface ViewStreamEntryDialogProps {
  /** 所在键名 */
  keyName: string
  /** entry ID */
  entryId: string
  /** 字段原始内容（与表格中展示的一致） */
  fields: string
  /** 该 entry 在 stream 中的序号（1 起） */
  position: number
  /** stream 总条目数 */
  total: number
  onClose: () => void
}

/**
 * 查看 stream entry 的完整内容。
 *
 * 为什么单独成组件而不是复用 EditListElementDialog：
 * 那个弹窗中间是**可编辑的 textarea**，而 stream 是只读日志 ——
 * 给一个能改的输入框会让人以为改动会保存，实际却没有保存入口，语义矛盾。
 *
 * 核心是把字段**解析成键值对表格**：表格里的字段列被单行截断，
 * 用户右键「查看」的诉求正是"看到完整内容"，逐字段拆开比扔一大段原始文本更清楚。
 * 无法解析成键值对时（如自由文本），退回单块原文展示。
 */
export function ViewStreamEntryDialog({
  keyName,
  entryId,
  fields,
  position,
  total,
  onClose,
}: ViewStreamEntryDialogProps) {
  const { notify } = useRedis()
  const { t } = useI18n()

  /**
   * 字段区的展示视图。
   * - `fields`：逐字段拆成键值对表格（便于逐项核对）
   * - `json`：完整 JSON 原文（便于整体复制、看嵌套层级）
   */
  const [view, setView] = useState<'fields' | 'json'>('fields')

  /** entry ID 的毫秒时间戳部分，可读性远好于原始数字 */
  const timestamp = (() => {
    const ms = Number(entryId.split('-')[0])
    if (!Number.isFinite(ms) || ms <= 0) return ''
    const date = new Date(ms)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
      date.getHours(),
    )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(ms % 1000).padStart(3, '0')}`
  })()

  /**
   * 完整 JSON 文本（美化后）。
   *
   * 仅当字段确实是 JSON 对象/数组时返回内容，否则为 null ——
   * `key=value` 序列与自由文本没有 JSON 结构，强行格式化只会得到
   * 一个被引号包裹的字符串，反而比原文更难读。
   */
  const jsonText = (() => {
    const text = fields.trim()
    const looksLikeJson =
      (text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))
    if (!looksLikeJson) return null
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return null
    }
  })()

  const jsonAvailable = jsonText !== null

  /**
   * 解析字段为键值对列表。
   * 1. JSON 对象（`{"event":"created","orderId":"8842"}`）—— 事件体常见形态
   * 2. 空格分隔的 `key=value`（`status=ok user_id=1001`）—— XADD 的展平形态
   * 都解析不出时返回 null，由模板退回原文展示。
   */
  const parsedFields = ((): Array<{ field: string; value: string }> | null => {
    const text = fields.trim()
    if (!text) return null

    // 形态一：JSON 对象
    if (text.startsWith('{') && text.endsWith('}')) {
      try {
        const obj = JSON.parse(text) as Record<string, unknown>
        return Object.entries(obj).map(([field, value]) => ({
          field,
          // 嵌套对象与数组序列化回字符串，避免表格里显示 [object Object]
          value: typeof value === 'string' ? value : JSON.stringify(value),
        }))
      } catch {
        return null
      }
    }

    // 形态二：key=value 序列（按空白切分，值里含空格的情况无法覆盖，此时会退回原文）
    const pairs = text.split(/\s+/).filter(Boolean)
    const isKeyValue = pairs.length > 1 && pairs.every((part) => /^[^\s=]+=/.test(part))
    if (isKeyValue) {
      return pairs.map((part) => {
        const eq = part.indexOf('=')
        return { field: part.slice(0, eq), value: part.slice(eq + 1) }
      })
    }

    return null
  })()

  /** 字数与字节统计（按原始文本算，不受解析方式影响） */
  const stats = {
    chars: fields.length,
    bytes: new TextEncoder().encode(fields).length,
    lines: fields ? fields.split('\n').length : 0,
    fieldCount: parsedFields?.length ?? 0,
  }

  /**
   * 复制并由全局 toast 反馈结果。
   * 用项目的 `copyText` 而非直接调 `navigator.clipboard`：后者在非安全上下文下不可用。
   */
  async function copyEntryId(): Promise<void> {
    if (!entryId) {
      notify('err', t('内容为空，无可复制'))
      return
    }
    const done = await copyText(entryId)
    notify(done ? 'ok' : 'err', done ? t('已复制 entry ID') : t('复制失败，请检查剪贴板权限'))
  }

  return (
    <DialogShell
      icon="document"
      title={t('查看 entry')}
      description={t('只读视图，stream 条目不可原地修改')}
      badge={<span className="dlg-badge mono">stream</span>}
      className="view-stream-entry-dialog"
      closeOnOverlay
      onClose={onClose}
      footer={
        <>
          <span className="stat mono">{t('{count} 字符', { count: stats.chars })}</span>
          <span className="sep">·</span>
          <span className="stat mono">{t('{count} 行', { count: stats.lines })}</span>
          <span className="sep">·</span>
          <span className="stat mono">{formatBytes(stats.bytes)}</span>
          <span className="spacer" />
          <Button type="button" variant="ghost" className="foot-btn foot-quiet" onClick={onClose}>
            <DialogIcon name="cancel" size={13} />
            {t('关闭')}
          </Button>
        </>
      }
    >
      {/* 目标键：类型徽标 + 键名 + entry 在 stream 中的位置 */}
      <div className="key-preview">
        <span className="type-badge">stream</span>
        <span className="key-name mono ellipsis" title={keyName}>
          {keyName}
        </span>
        <span className="pos mono">
          #{position} / {total}
        </span>
      </div>

      {/* 元信息：entry ID（可复制）、时间、字段数 */}
      <dl className="details">
        <dt>entry ID</dt>
        <dd className="mono entry-id-cell">
          <span className="ellipsis">{entryId}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="mini-copy"
            aria-label={t('复制 entry ID')}
            onClick={() => void copyEntryId()}
          >
            <DialogIcon name="copy" size={11} />
          </Button>
        </dd>

        {timestamp ? (
          <>
            <dt>{t('时间')}</dt>
            <dd className="mono">{timestamp}</dd>
          </>
        ) : null}

        <dt>{t('字段数')}</dt>
        <dd className="mono">{stats.fieldCount || '—'}</dd>
      </dl>

      {/* 字段区：可切换「字段明细」与「JSON 明细」 */}
      <section className="stream-section">
        <div className="stream-section-head">
          <span className="stream-section-title">{t('字段')}</span>

          {/* 视图切换固定在最右：位置稳定，切换时不会因文案长短左右跳动 */}
          {parsedFields || jsonAvailable ? (
            <div className="view-switch">
              <button
                type="button"
                className={view === 'fields' ? 'on' : ''}
                onClick={() => setView('fields')}
              >
                {t('字段明细')}
              </button>
              {jsonAvailable ? (
                <button
                  type="button"
                  className={view === 'json' ? 'on' : ''}
                  onClick={() => setView('json')}
                >
                  {t('JSON 明细')}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* 视图一：逐字段拆开（解析成功时） */}
        {view === 'fields' && parsedFields ? (
          <div className="field-table">
            {parsedFields.map((item) => (
              <div key={item.field} className="field-row">
                <span className="field-name mono">{item.field}</span>
                <pre className="field-value mono">{item.value}</pre>
              </div>
            ))}
          </div>
        ) : view === 'json' && jsonText ? (
          /* 视图二：完整 JSON（美化缩进，保留嵌套层级） */
          <pre className="raw json mono">{jsonText}</pre>
        ) : (
          <>
            <pre className="raw mono">{fields || t('（空）')}</pre>
            {/* 仅在「内容可拆成字段、但当前停在 JSON 视图」时给出回切引导 */}
            {parsedFields ? <p className="note">{t('切换到「字段明细」可按字段逐项查看。')}</p> : null}
          </>
        )}
      </section>
    </DialogShell>
  )
}

export default ViewStreamEntryDialog

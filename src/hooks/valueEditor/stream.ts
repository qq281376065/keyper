import { useState } from 'react'
import { api } from '@/api'
import { t } from '@/i18n'
import { useRedis } from '@/store/useRedis'
import { copyText } from '@/utils/clipboard'
import { prettyJson, utf8Bytes } from '@/utils/format'
import { compareEntryId, splitPair, type LineView, type ValueEditorContext } from './shared'

/**
 * stream 值编辑器：
 * 只读视图 —— 查看完整 entry、复制（ID/字段/XADD 命令）与导出；
 * 追加新 entry 走 XADD（补齐与 hash/list/set/zset 对称的新增入口，
 * 只追加不改历史，与「消费位点不可破坏」的只读定位不冲突）。
 * 行视图 lineView 在公共侧（list/set/zset/stream 共用），streamView 即其别名。
 */
export function useStreamEditor(
  ctx: ValueEditorContext,
  deps: { lineView: LineView; setSelectedListIndex: (value: number | null) => void },
) {
  const { getValue } = ctx
  const { lineView, setSelectedListIndex } = deps
  const { state, notify, refreshSelected } = useRedis()

  /**
   * stream 是**只读**的：它是消息日志，entry 一旦写入即固化。
   * 修改历史消息会破坏消费位点语义，删除 entry 又会造成消费缺口，
   * 因此只提供「复制」类操作，不提供修改 / 删除。
   *
   * 定位一律用 entry ID 而非下标 —— ID 由服务端生成且全局唯一，
   * 下标会随 XRANGE / XREVRANGE 的读取方向变化。
   */
  const [streamMenu, setStreamMenu] = useState<{
    row: { index: number; text: string; left?: string }
    top: number
    left: number
  } | null>(null)

  const STREAM_MENU_WIDTH = 200
  const STREAM_MENU_HEIGHT = 250

  /** 正在查看完整内容的 stream entry（null 表示未打开） */
  const [viewingStreamEntry, setViewingStreamEntry] = useState<{
    entryId: string
    fields: string
    position: number
  } | null>(null)

  /** 正在追加 stream entry（false 表示未打开弹窗） */
  const [addingEntry, setAddingEntry] = useState(false)

  /** 打开查看弹窗：位置取该 entry 在 stream 中的序号 */
  function openStreamViewer(row: { index: number; text: string; left?: string }): void {
    setViewingStreamEntry({
      entryId: streamIdOf(row),
      fields: row.text,
      position: row.index + 1,
    })
  }

  /** stream 行的 entry ID */
  function streamIdOf(row: { left?: string }): string {
    return row.left ?? ''
  }

  async function copyStreamId(row: { left?: string }): Promise<void> {
    const id = streamIdOf(row)
    const done = await copyText(id)
    notify(
      done ? 'ok' : 'err',
      done ? t('已复制 entry ID {id}', { id }) : t('复制失败，请检查剪贴板权限'),
    )
  }

  async function copyStreamFields(row: { text: string }): Promise<void> {
    const done = await copyText(row.text)
    notify(done ? 'ok' : 'err', done ? t('已复制字段内容') : t('复制失败，请检查剪贴板权限'))
  }

  /** 复制为 XADD 命令：排障时可直接粘进 redis-cli 复现这条消息 */
  async function copyStreamAsCommand(row: { text: string; left?: string }): Promise<void> {
    const key = getValue()?.key ?? ''
    const done = await copyText(`XADD ${key} ${streamIdOf(row)} ${streamToCommandFields(row.text)}`)
    notify(done ? 'ok' : 'err', done ? t('已复制 XADD 命令') : t('复制失败，请检查剪贴板权限'))
  }

  /**
   * 把字段文本转成 XADD 的参数形式。
   *
   * 字段是 JSON 对象时展开为 `field value` 依次排列（Redis 的参数形态）；
   * 不是 JSON 则原样返回，避免把普通文本强行改写。
   */
  function streamToCommandFields(text: string): string {
    const parsed = prettyJson(text)
    if (!parsed.ok) return text
    try {
      const obj = JSON.parse(text) as Record<string, unknown>
      return Object.entries(obj)
        .map(([field, val]) => `"${field}" "${String(val)}"`)
        .join(' ')
    } catch {
      return text
    }
  }

  function openStreamMenu(
    event: React.MouseEvent,
    row: { index: number; text: string; left?: string },
  ): void {
    setSelectedListIndex(row.index)
    const left =
      event.clientX + STREAM_MENU_WIDTH > window.innerWidth
        ? Math.max(4, event.clientX - STREAM_MENU_WIDTH)
        : event.clientX
    const top =
      event.clientY + STREAM_MENU_HEIGHT > window.innerHeight
        ? Math.max(4, window.innerHeight - STREAM_MENU_HEIGHT - 4)
        : event.clientY
    setStreamMenu({ row, top, left })
  }

  function closeStreamMenu(): void {
    setStreamMenu(null)
  }

  /** 与 hash / list 同理：先快照 row 再关菜单，避免闭包二次求值拿到 null */
  function runStreamMenuAction(
    action: (row: { index: number; text: string; left?: string }) => void,
  ): void {
    const row = streamMenu?.row
    if (!row) return
    closeStreamMenu()
    action(row)
  }

  /**
   * 缩写 entry ID 用于状态栏显示。
   * ID 形如 `1760668800123-0`，完整长度会挤占状态栏空间；
   * 只保留毫秒时间戳的后 6 位（同一天内的消息足以区分）。
   */
  function shortEntryId(id: string): string {
    if (!id) return '—'
    const [ms, seq] = id.split('-')
    const tail = ms && ms.length > 6 ? `…${ms.slice(-6)}` : ms
    return seq ? `${tail}-${seq}` : (tail ?? '')
  }

  /** stream 表格行（复用 lineView 的解析结果） */
  const streamView = lineView

  /** stream 统计：entry 数、匹配数、总字节、首个与末个 entry ID（即时间跨度） */
  const streamItems = Array.isArray(getValue()?.value) ? (getValue()!.value as string[]) : []
  const streamBytes = streamItems.reduce((sum, item) => sum + utf8Bytes(item), 0)
  const ids = streamItems.map((item) => splitPair(item)[0]).filter(Boolean)
  const streamStats = {
    total: streamItems.length,
    matched: streamView.rows.length,
    bytes: streamBytes,
    /** entry ID 即毫秒时间戳，首末 ID 反映消息的时间跨度 */
    firstId: ids.length ? ids.reduce((a, b) => (compareEntryId(a, b) <= 0 ? a : b)) : '',
    lastId: ids.length ? ids.reduce((a, b) => (compareEntryId(a, b) >= 0 ? a : b)) : '',
  }

  /** 把全部 entry 序列化为可读文本，用于「复制全部」与导出 */
  function streamAsText(): string {
    const items = Array.isArray(getValue()?.value) ? (getValue()!.value as string[]) : []
    // 原样输出（entry ID + Tab + 字段），不做格式化 —— 导出的用途是离线排查，保持原始形态便于 grep
    return items.map((item) => splitPair(item).join('\t')).join('\n')
  }

  async function copyStreamAll(): Promise<void> {
    if (!streamStats.total) {
      notify('err', t('当前 stream 没有 entry'))
      return
    }
    const done = await copyText(streamAsText())
    notify(
      done ? 'ok' : 'err',
      done
        ? t('已复制 {count} 条 entry', { count: streamStats.total })
        : t('复制失败，请检查剪贴板权限'),
    )
  }

  /** 导出为本地文件（主进程保存对话框；浏览器预览走 Blob 下载） */
  async function exportStream(): Promise<void> {
    if (!streamStats.total) {
      notify('err', t('当前 stream 没有 entry'))
      return
    }
    const key = getValue()?.key ?? 'stream'
    const res = await api.file.saveText({
      suggestedName: `${key.replace(/[\\/:*?"<>|]/g, '_')}.txt`,
      content: streamAsText(),
    })
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    // 用户取消保存时 saved 为 false，不提示成功
    if (!res.data.saved) return
    notify('ok', t('已导出到 {path}', { path: res.data.path ?? key }))
  }

  /**
   * XADD 追加确认：成功后走**整表静默刷新**而非本地拼接 ——
   * 行文本含服务端生成的 entry ID（`id :: fields`），本地猜不出真值
   * （同毫秒多条会是 -1/-2 后缀），猜错 ID 会污染后续「复制为 XADD 命令」。
   * stream 数据量小（日志流通常几十条），一次往返换正确性值得；
   * silent 不闪骨架屏，与 hash/list 的本地直改前提（结果可预期）不同。
   */
  async function handleStreamAddConfirm(field: string, val: string): Promise<void> {
    const id = state.activeId
    const key = getValue()?.key
    if (!id || !key || !field) return

    const res = await api.redis.xaddEntry(id, key, field, val)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.ok) {
      notify('err', res.data.message ?? t('追加失败'))
      return
    }
    notify('ok', res.data.message ?? t('已追加消息'))

    setAddingEntry(false)
    await refreshSelected({ silent: true })
  }

  return {
    streamMenu,
    viewingStreamEntry,
    setViewingStreamEntry,
    openStreamViewer,
    streamIdOf,
    copyStreamId,
    copyStreamFields,
    copyStreamAsCommand,
    streamToCommandFields,
    openStreamMenu,
    closeStreamMenu,
    runStreamMenuAction,
    shortEntryId,
    streamStats,
    streamView,
    streamAsText,
    copyStreamAll,
    exportStream,
    addingEntry,
    setAddingEntry,
    handleStreamAddConfirm,
  }
}

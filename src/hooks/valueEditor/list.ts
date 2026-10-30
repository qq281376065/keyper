import { useState } from 'react'
import { api } from '@/api'
import { t } from '@/i18n'
import { useRedis } from '@/store/useRedis'
import { copyText } from '@/utils/clipboard'
import { formatBytes, utf8Bytes } from '@/utils/format'
import type { ValueEditorContext } from './shared'

/**
 * list 值编辑器：
 * 行右键菜单、元素编辑/插入/追加/删除、复制（LSET 命令/JSON）与导出。
 * 行视图 lineView / 统计 listStats 在公共侧（list/set/zset/stream 共用）。
 */
export function useListEditor(
  ctx: ValueEditorContext,
  deps: {
    listStats: { total: number }
    selectedListIndex: number | null
    setSelectedListIndex: (value: number | null) => void
  },
) {
  const { getValue } = ctx
  const { listStats, setSelectedListIndex } = deps
  const { state, notify, askConfirm, replaceElementLocally, insertElementLocally, dropElementLocally } =
    useRedis()

  /** list 行右键菜单 / 编辑弹窗的目标 */
  const [listMenu, setListMenu] = useState<{
    row: { index: number; text: string }
    top: number
    left: number
  } | null>(null)
  const [editingListIndex, setEditingListIndex] = useState<{ index: number; value: string } | null>(null)
  /** 插入元素：在指定位置前/后插入 */
  const [insertingList, setInsertingList] = useState<{ index: number; position: 'before' | 'after' } | null>(
    null,
  )

  const LIST_MENU_WIDTH = 200
  const LIST_MENU_HEIGHT = 220

  /** 全部元素按行拼接 —— 复制与导出共用 */
  function listAsText(): string {
    const items = Array.isArray(getValue()?.value) ? (getValue()!.value as string[]) : []
    return items.join('\n')
  }

  async function copyListAll(): Promise<void> {
    if (!listStats.total) {
      notify('err', t('当前 list 没有元素'))
      return
    }
    const done = await copyText(listAsText())
    notify(
      done ? 'ok' : 'err',
      done ? t('已复制 {count} 项', { count: listStats.total }) : t('复制失败，请检查剪贴板权限'),
    )
  }

  async function exportList(): Promise<void> {
    const key = getValue()?.key ?? 'list'
    const res = await api.file.saveText({
      suggestedName: `${key.replace(/[\\/:*?"<>|]/g, '_')}.txt`,
      content: listAsText(),
    })
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.saved) {
      notify('ok', t('已取消导出'))
      return
    }
    notify('ok', t('已导出到 {path}', { path: res.data.path ?? t('本地文件') }))
  }

  async function copyListRow(row: { index: number; text: string }): Promise<void> {
    const done = await copyText(row.text)
    notify(
      done ? 'ok' : 'err',
      done
        ? t('已复制第 {index} 项', { index: row.index + 1 })
        : t('复制失败，请检查剪贴板权限'),
    )
  }

  async function copyListAsCommand(row: { index: number; text: string }): Promise<void> {
    const key = getValue()?.key ?? ''
    const done = await copyText(`LSET ${key} ${row.index} "${row.text}"`)
    notify(done ? 'ok' : 'err', done ? t('已复制 LSET 命令') : t('复制失败，请检查剪贴板权限'))
  }

  async function copyListAsJson(row: { index: number; text: string }): Promise<void> {
    const done = await copyText(JSON.stringify({ index: row.index, value: row.text }, null, 2))
    notify(done ? 'ok' : 'err', done ? t('已复制 JSON') : t('复制失败，请检查剪贴板权限'))
  }

  function openListMenu(event: React.MouseEvent, row: { index: number; text: string }): void {
    setSelectedListIndex(row.index)
    const left =
      event.clientX + LIST_MENU_WIDTH > window.innerWidth
        ? Math.max(4, event.clientX - LIST_MENU_WIDTH)
        : event.clientX
    const top =
      event.clientY + LIST_MENU_HEIGHT > window.innerHeight
        ? Math.max(4, window.innerHeight - LIST_MENU_HEIGHT - 4)
        : event.clientY
    setListMenu({ row, top, left })
  }

  function closeListMenu(): void {
    setListMenu(null)
  }

  /**
   * 右键菜单的统一执行入口。
   *
   * 为什么需要它：若写成 `runListAction(() => copyX(listMenu!.row))`，
   * 该箭头函数在**点击时才求值**，而此时 closeListMenu() 已把 listMenu 置为 null，
   * 于是 `listMenu!.row` 变成 `null.row` 并抛 TypeError —— 表现为"点了没反应"。
   * 改为先取出 row 再关菜单，并把 row 作为参数传给具体动作。
   */
  function runListMenuAction(action: (row: { index: number; text: string }) => void): void {
    const row = listMenu?.row
    if (!row) return
    closeListMenu()
    action(row)
  }

  /** 打开编辑弹窗 */
  function openListEditor(row: { index: number; text: string }): void {
    setEditingListIndex({ index: row.index, value: row.text })
  }

  /** 修改元素值 */
  async function handleListEditConfirm(next: string): Promise<void> {
    const target = editingListIndex
    const id = state.activeId
    const key = getValue()?.key
    if (!target || !id || !key) return

    const res = await api.redis.setListElement(id, key, target.index, next)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.ok) {
      notify('err', res.data.message ?? t('修改失败'))
      return
    }
    notify('ok', res.data.message ?? t('已修改'))
    setEditingListIndex(null)
    // 本地替换，避免整表重读：新值与目标位置都已知，无需回读服务端
    replaceElementLocally({ index: target.index }, next)
  }

  /** 插入 / 追加元素 */
  async function handleListInsertConfirm(next: string): Promise<void> {
    const target = insertingList
    const id = state.activeId
    const key = getValue()?.key
    if (!target || !id || !key) return

    // index 超出当前长度即视为追加到末尾（RPUSH 语义）
    const appending = target.index >= listStats.total
    if (!next) {
      notify('err', t('内容不能为空'))
      return
    }

    const res = appending
      ? await api.redis.appendListElement(id, key, next)
      : await api.redis.insertListElement(id, key, target.index, next, target.position)

    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.ok) {
      notify('err', res.data.message ?? t('插入失败'))
      return
    }
    notify('ok', appending ? t('已追加到末尾') : (res.data.message ?? t('已插入')))
    setInsertingList(null)

    // 本地插入，避免整表重读的骨架屏闪烁。
    // 插入结果完全可预期（内容由用户输入、位置由操作语义给定），无需回读服务端。
    if (appending) {
      insertElementLocally(next)
    } else {
      insertElementLocally(next, target.index, target.position)
    }
  }

  /** 打开插入弹窗 */
  function openInsertDialog(row: { index: number; text: string }, position: 'before' | 'after'): void {
    setInsertingList({ index: row.index, position })
  }

  /** 删除元素：不可撤销，走二次确认 */
  async function removeListElement(row: { index: number; text: string }): Promise<void> {
    const id = state.activeId
    const key = getValue()?.key
    if (!id || !key) return

    // 用真实下标（row.index）描述位置，与表格序号列一致。
    // 预览控制在 120 字符内：确认框内容区高度有限，
    // 过长的内容会被滚动裁掉 —— 而"待删内容"恰恰是用户最需要看清的。
    const truncated = row.text.length > 120
    const preview = truncated ? `${row.text.slice(0, 120)}…` : row.text

    const confirmed = await askConfirm({
      title: t('删除第 {index} 项', { index: row.index + 1 }),
      message: t('即将从列表中移除以下元素：'),
      details: [
        { label: t('键名'), value: key, mono: true },
        {
          label: t('位置'),
          value: t('第 {index} / {total} 项', { index: row.index + 1, total: listStats.total }),
          mono: true,
        },
        { label: t('大小'), value: formatBytes(utf8Bytes(row.text)), mono: true },
      ],
      preview: { label: t('待删除的内容'), text: preview, truncated },
      warning: t('删除后无法恢复，列表长度将减 1。'),
      confirmText: t('删除'),
      danger: true,
    })
    if (!confirmed) return

    const res = await api.redis.delListElement(id, key, row.index)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.ok) {
      notify('err', res.data.message ?? t('删除失败'))
      return
    }
    notify('ok', res.data.message ?? t('已删除'))
    // 本地移除该行，避免整表重读导致的骨架屏闪现；
    // 用真实下标匹配，与删除时使用的 row.index 保持一致
    const wasLast = (getValue()?.value as string[] | undefined)?.length === 1
    dropElementLocally((_item, index) => index === row.index)
    // 最后一个元素被删除时 Redis 会移除整个键，清空选中态避免停留在空壳上
    if (wasLast) state.selectedValue = null
  }

  return {
    listMenu,
    editingListIndex,
    setEditingListIndex,
    insertingList,
    setInsertingList,
    listAsText,
    copyListAll,
    exportList,
    copyListRow,
    copyListAsCommand,
    copyListAsJson,
    openListMenu,
    closeListMenu,
    runListMenuAction,
    openListEditor,
    handleListEditConfirm,
    handleListInsertConfirm,
    openInsertDialog,
    removeListElement,
  }
}

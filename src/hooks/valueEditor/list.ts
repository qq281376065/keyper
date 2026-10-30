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
      notify('err', t('valueEditorList.listNoElements'))
      return
    }
    const done = await copyText(listAsText())
    notify(
      done ? 'ok' : 'err',
      done ? t('valueEditorList.copiedCountItems', { count: listStats.total }) : t('common.copyFailedCheckClipboardPermissions'),
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
      notify('ok', t('common.exportCancelled'))
      return
    }
    notify('ok', t('common.exportedPath', { path: res.data.path ?? t('common.localFile') }))
  }

  async function copyListRow(row: { index: number; text: string }): Promise<void> {
    const done = await copyText(row.text)
    notify(
      done ? 'ok' : 'err',
      done
        ? t('valueEditorList.copiedItemIndex', { index: row.index + 1 })
        : t('common.copyFailedCheckClipboardPermissions'),
    )
  }

  async function copyListAsCommand(row: { index: number; text: string }): Promise<void> {
    const key = getValue()?.key ?? ''
    const done = await copyText(`LSET ${key} ${row.index} "${row.text}"`)
    notify(done ? 'ok' : 'err', done ? t('valueEditorList.copiedLsetCommand') : t('common.copyFailedCheckClipboardPermissions'))
  }

  async function copyListAsJson(row: { index: number; text: string }): Promise<void> {
    const done = await copyText(JSON.stringify({ index: row.index, value: row.text }, null, 2))
    notify(done ? 'ok' : 'err', done ? t('valueEditorList.copiedJson') : t('common.copyFailedCheckClipboardPermissions'))
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
      notify('err', res.data.message ?? t('common.updateFailed'))
      return
    }
    notify('ok', res.data.message ?? t('common.modified'))
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
      notify('err', t('valueEditorList.contentCannotEmpty'))
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
      notify('err', res.data.message ?? t('valueEditorList.insertFailed'))
      return
    }
    notify('ok', appending ? t('valueEditorList.appendedEnd') : (res.data.message ?? t('valueEditorList.inserted')))
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
      title: t('valueEditorList.deleteItemIndex', { index: row.index + 1 }),
      message: t('valueEditorList.elementsRemovedList'),
      details: [
        { label: t('common.keyName'), value: key, mono: true },
        {
          label: t('valueViewer.position'),
          value: t('valueEditorList.itemIndexTotal', { index: row.index + 1, total: listStats.total }),
          mono: true,
        },
        { label: t('common.size'), value: formatBytes(utf8Bytes(row.text)), mono: true },
      ],
      preview: { label: t('valueEditorList.contentDelete'), text: preview, truncated },
      warning: t('valueEditorList.cannotUndoneListLengthDecreases'),
      confirmText: t('common.delete'),
      danger: true,
    })
    if (!confirmed) return

    const res = await api.redis.delListElement(id, key, row.index)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.ok) {
      notify('err', res.data.message ?? t('common.deleteFailed'))
      return
    }
    notify('ok', res.data.message ?? t('common.deleted'))
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

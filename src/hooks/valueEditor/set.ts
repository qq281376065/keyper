import { useMemo, useState } from 'react'
import { utf8Bytes } from '@/utils/format'
import { api } from '@/api'
import { useRedis } from '@/store/useRedis'
import { copyText } from '@/utils/clipboard'
import type { ValueEditorContext } from './shared'

/**
 * set 值编辑器：
 * 行右键菜单、成员编辑/新增/删除、复制（SADD 命令/JSON）与导出。
 * 行视图 lineView 在公共侧（list/set/zset/stream 共用）。
 */
export function useSetEditor(
  ctx: ValueEditorContext,
  deps: { setSelectedListIndex: (value: number | null) => void },
) {
  const { getValue } = ctx
  const { setSelectedListIndex } = deps
  const { state, notify, askConfirm, dropElementLocally, insertElementLocally } = useRedis()

  /** set 行右键菜单 / 编辑弹窗的目标（按成员内容定位 —— set 无序，下标无操作意义） */
  const [setMenu, setSetMenu] = useState<{
    row: { index: number; text: string }
    top: number
    left: number
  } | null>(null)
  const [editingSetMember, setEditingSetMember] = useState<{ member: string; value: string } | null>(null)
  /** 新增成员弹窗 */
  const [addingMember, setAddingMember] = useState(false)

  const SET_MENU_WIDTH = 200
  const SET_MENU_HEIGHT = 210

  async function copySetMember(row: { index: number; text: string }): Promise<void> {
    const done = await copyText(row.text)
    notify(done ? 'ok' : 'err', done ? `已复制成员 ${row.text}` : '复制失败，请检查剪贴板权限')
  }

  async function copySetAsCommand(row: { index: number; text: string }): Promise<void> {
    const key = getValue()?.key ?? ''
    const done = await copyText(`SADD ${key} "${row.text}"`)
    notify(done ? 'ok' : 'err', done ? '已复制 SADD 命令' : '复制失败，请检查剪贴板权限')
  }

  async function copySetAsJson(row: { index: number; text: string }): Promise<void> {
    const done = await copyText(JSON.stringify(row.text, null, 2))
    notify(done ? 'ok' : 'err', done ? '已复制 JSON' : '复制失败，请检查剪贴板权限')
  }

  function openSetMenu(event: React.MouseEvent, row: { index: number; text: string }): void {
    setSelectedListIndex(row.index)
    const left =
      event.clientX + SET_MENU_WIDTH > window.innerWidth
        ? Math.max(4, event.clientX - SET_MENU_WIDTH)
        : event.clientX
    const top =
      event.clientY + SET_MENU_HEIGHT > window.innerHeight
        ? Math.max(4, window.innerHeight - SET_MENU_HEIGHT - 4)
        : event.clientY
    setSetMenu({ row, top, left })
  }

  function closeSetMenu(): void {
    setSetMenu(null)
  }

  /** 与 list 同理：先快照 row 再关菜单，避免置空后求值抛错 */
  function runSetMenuAction(action: (row: { index: number; text: string }) => void): void {
    const row = setMenu?.row
    if (!row) return
    closeSetMenu()
    action(row)
  }

  function openSetEditor(row: { index: number; text: string }): void {
    setEditingSetMember({ member: row.text, value: row.text })
  }

  /** 全部成员按行拼接 —— 复制与导出共用 */
  function setAsText(): string {
    const items = Array.isArray(getValue()?.value) ? (getValue()!.value as string[]) : []
    return items.join('\n')
  }

  /** set 统计信息 */
  /*
   * 字节统计用 useMemo 收敛。
   *
   * 原实现对每个元素 new Blob() 算字节数，且**每次渲染都重算** ——
   * 1000 个元素就是 1000 次 Blob 分配，与值是否变化无关。
   * setBytes / setLongest 只依赖元素数组本身。
   */
  const setItems = Array.isArray(getValue()?.value) ? (getValue()!.value as string[]) : []
  /*
   * 字节统计用 useMemo 收敛：原实现对每个元素 new Blob() 且每次渲染重算，
   * 1000 个成员就是 1000 次 Blob 分配，与值是否变化无关。
   */
  const { bytes: setBytes, longest: setLongest } = useMemo(() => {
    let bytes = 0
    let longest = -1
    let longestSize = -1
    setItems.forEach((item, index) => {
      const size = utf8Bytes(item)
      bytes += size
      if (size > longestSize) {
        longestSize = size
        longest = index + 1
      }
    })
    return { bytes, longest }
  }, [setItems])
  const setStats = {
    total: setItems.length,
    bytes: setBytes,
    longest: setLongest > 0 ? `#${setLongest}` : '-',
  }

  async function copySetAll(): Promise<void> {
    if (!setStats.total) {
      notify('err', '当前 set 没有成员')
      return
    }
    const done = await copyText(setAsText())
    notify(
      done ? 'ok' : 'err',
      done ? `已复制 ${setStats.total} 个成员` : '复制失败，请检查剪贴板权限',
    )
  }

  async function exportSet(): Promise<void> {
    const key = getValue()?.key ?? 'set'
    const res = await api.file.saveText({
      suggestedName: `${key.replace(/[\\/:*?"<>|]/g, '_')}.txt`,
      content: setAsText(),
    })
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.saved) {
      notify('ok', '已取消导出')
      return
    }
    notify('ok', `已导出到 ${res.data.path ?? '本地文件'}`)
  }

  /** 修改成员：set 成员本身即标识，改内容等价于删除旧成员 + 添加新成员 */
  async function handleSetMemberConfirm(next: string): Promise<void> {
    const target = editingSetMember
    const id = state.activeId
    const key = getValue()?.key
    if (!target || !id || !key) return

    const res = await api.redis.setSetMember(id, key, target.member, next)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.ok) {
      notify('err', res.data.message ?? '修改失败')
      return
    }
    notify('ok', res.data.message ?? '已修改')
    setEditingSetMember(null)

    // 本地更新：先移除旧成员，若新成员尚不存在则补上
    const existed = new Set((getValue()?.value as string[]) ?? []).has(next.trim())
    dropElementLocally((item) => item === target.member)
    if (!existed) insertElementLocally(next.trim())
  }

  /** 删除成员 */
  async function removeSetMember(member: string): Promise<void> {
    const id = state.activeId
    const key = getValue()?.key
    if (!id || !key) return

    const total = (getValue()?.value as string[] | undefined)?.length ?? 0
    const wasLast = total <= 1

    const confirmed = await askConfirm({
      title: '删除成员',
      message: '即将从该集合中移除以下成员：',
      details: [
        { label: '键名', value: key, mono: true },
        { label: '成员', value: member, mono: true, tone: 'danger' },
        { label: '成员数', value: `${total} → ${total - 1}`, mono: true },
      ],
      warning: wasLast
        ? '这是集合的最后一个成员，删除后整个键也会被移除。'
        : '删除后无法恢复。',
      confirmText: '删除',
      danger: true,
    })
    if (!confirmed) return

    const res = await api.redis.delSetMember(id, key, member)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.ok) {
      notify('err', res.data.message ?? '删除失败')
      return
    }
    notify('ok', res.data.message ?? '已删除')
    dropElementLocally((item) => item === member)
    if (wasLast) state.selectedValue = null
  }

  async function handleAddMemberConfirm(next: string): Promise<void> {
    const id = state.activeId
    const key = getValue()?.key
    if (!id || !key) return

    if (!next.trim()) {
      notify('err', '成员内容不能为空')
      return
    }

    const existed = new Set((getValue()?.value as string[]) ?? []).has(next.trim())
    const res = await api.redis.addSetMember(id, key, next.trim())
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.ok) {
      notify('err', res.data.message ?? '添加失败')
      return
    }
    notify('ok', res.data.message ?? '已添加')
    setAddingMember(false)

    // 本地更新（SADD 幂等，已存在则不再插入）
    if (!existed) insertElementLocally(next.trim())
  }

  return {
    setMenu,
    editingSetMember,
    setEditingSetMember,
    copySetMember,
    copySetAsCommand,
    copySetAsJson,
    openSetMenu,
    closeSetMenu,
    runSetMenuAction,
    openSetEditor,
    setAsText,
    copySetAll,
    exportSet,
    handleSetMemberConfirm,
    removeSetMember,
    addingMember,
    setAddingMember,
    handleAddMemberConfirm,
    setStats,
  }
}

import { useState } from 'react'
import { utf8Bytes } from '@/utils/format'
import { api } from '@/api'
import { useRedis } from '@/store/useRedis'
import { copyText } from '@/utils/clipboard'
import { splitPair, type ValueEditorContext } from './shared'

/**
 * zset 值编辑器：
 * 行右键菜单、成员编辑/新增/删除、复制（ZADD 命令/成员/score）与导出。
 * 行视图 lineView 在公共侧（list/set/zset/stream 共用）。
 */
export function useZsetEditor(
  ctx: ValueEditorContext,
  deps: { setSelectedListIndex: (value: number | null) => void },
) {
  const { getValue } = ctx
  const { setSelectedListIndex } = deps
  const { state, notify, askConfirm, dropElementLocally, refreshSelected } = useRedis()

  /**
   * zset 成员定位一律用「member 名」而非下标。
   * 原因：zset 会随 score 变化重排，下标随时可能改变；
   * member 是成员在集合中的唯一标识，稳定可靠。
   */
  const [zsetMenu, setZsetMenu] = useState<{
    row: { index: number; text: string; left?: string }
    top: number
    left: number
  } | null>(null)
  /** 编辑成员：携带 member、score 两项 */
  const [editingZset, setEditingZset] = useState<{ member: string; score: string } | null>(null)
  const [addingZset, setAddingZset] = useState(false)

  const ZSET_MENU_WIDTH = 200
  const ZSET_MENU_HEIGHT = 210

  /** zset 行的成员名 */
  function zsetMemberOf(row: { left?: string }): string {
    return row.left ?? ''
  }

  async function copyZsetMember(row: { left?: string }): Promise<void> {
    const member = zsetMemberOf(row)
    const done = await copyText(member)
    notify(done ? 'ok' : 'err', done ? `已复制成员 ${member}` : '复制失败，请检查剪贴板权限')
  }

  async function copyZsetScore(row: { text: string }): Promise<void> {
    const done = await copyText(row.text)
    notify(done ? 'ok' : 'err', done ? `已复制 score ${row.text}` : '复制失败，请检查剪贴板权限')
  }

  /** 复制为 ZADD 命令：排障时可直接粘进 redis-cli 复现 */
  async function copyZsetAsCommand(row: { left?: string; text: string }): Promise<void> {
    const key = getValue()?.key ?? ''
    const done = await copyText(`ZADD ${key} ${row.text} "${zsetMemberOf(row)}"`)
    notify(done ? 'ok' : 'err', done ? '已复制 ZADD 命令' : '复制失败，请检查剪贴板权限')
  }

  function openZsetMenu(
    event: React.MouseEvent,
    row: { index: number; text: string; left?: string },
  ): void {
    setSelectedListIndex(row.index)
    const left =
      event.clientX + ZSET_MENU_WIDTH > window.innerWidth
        ? Math.max(4, event.clientX - ZSET_MENU_WIDTH)
        : event.clientX
    const top =
      event.clientY + ZSET_MENU_HEIGHT > window.innerHeight
        ? Math.max(4, window.innerHeight - ZSET_MENU_HEIGHT - 4)
        : event.clientY
    setZsetMenu({ row, top, left })
  }

  function closeZsetMenu(): void {
    setZsetMenu(null)
  }

  /** 与 hash / list 同理：先快照 row 再关菜单 */
  function runZsetMenuAction(action: (row: { index: number; text: string; left?: string }) => void): void {
    const row = zsetMenu?.row
    if (!row) return
    closeZsetMenu()
    action(row)
  }

  function openZsetEditor(row: { index: number; text: string; left?: string }): void {
    setEditingZset({ member: zsetMemberOf(row), score: row.text })
  }

  /**
   * 保存 zset 成员。
   * member 与 score 都可能变化，因此不能像 set 那样"先删后插"——
   * 改名走 ZREM + ZADD，仅改 score 走 ZADD 更新（重名冲突由服务端如实告知）。
   */
  async function handleZsetConfirm(nextMember: string, nextScore: string): Promise<void> {
    const target = editingZset
    const id = state.activeId
    const key = getValue()?.key
    if (!target || !id || !key) return

    const score = Number(nextScore)
    if (!nextScore.trim() || Number.isNaN(score)) {
      notify('err', 'score 必须是数字')
      return
    }

    const res = await api.redis.setZsetMember(id, key, target.member, nextMember.trim(), score)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.ok) {
      notify('err', res.data.message ?? '修改失败')
      return
    }
    notify('ok', res.data.message ?? '已修改')
    setEditingZset(null)
    // zset 会因 score 变化重排，本地难以推断新顺序，回读一次（静默，不闪骨架屏）
    await refreshSelected({ silent: true })
  }

  async function removeZsetMember(member: string): Promise<void> {
    const id = state.activeId
    const key = getValue()?.key
    if (!id || !key) return

    const items = Array.isArray(getValue()?.value) ? (getValue()!.value as string[]) : []
    const total = items.length
    const score = items.map((raw) => splitPair(raw)).find(([m]) => m === member)?.[1]

    const confirmed = await askConfirm({
      title: '删除成员',
      message: '即将从该有序集合中移除以下成员：',
      details: [
        { label: '键名', value: key, mono: true },
        { label: '成员', value: member, mono: true, tone: 'danger' },
        ...(score ? [{ label: 'score', value: score, mono: true }] : []),
        { label: '成员数', value: `${total} → ${total - 1}`, mono: true },
      ],
      warning:
        total <= 1 ? '这是集合的最后一个成员，删除后整个键也会被移除。' : '删除后无法恢复。',
      confirmText: '删除',
      danger: true,
    })
    if (!confirmed) return

    const res = await api.redis.delZsetMember(id, key, member)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.ok) {
      notify('err', res.data.message ?? '删除失败')
      return
    }
    notify('ok', res.data.message ?? '已删除')
    dropElementLocally((item) => splitPair(item)[0] === member)
    if (total <= 1) state.selectedValue = null
  }

  async function handleAddZsetConfirm(member: string, score: string): Promise<void> {
    const id = state.activeId
    const key = getValue()?.key
    if (!id || !key) return

    const num = Number(score)
    if (!member.trim()) {
      notify('err', '成员内容不能为空')
      return
    }
    if (!score.trim() || Number.isNaN(num)) {
      notify('err', 'score 必须是数字')
      return
    }

    const res = await api.redis.addZsetMember(id, key, member.trim(), num)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.ok) {
      notify('err', res.data.message ?? '添加失败')
      return
    }
    notify('ok', res.data.message ?? '已添加')
    setAddingZset(false)
    // score 决定排序位置，本地插入难以保证顺序正确，静默回读
    await refreshSelected({ silent: true })
  }

  /** zset 统计：成员数、总字节、最高 / 最低 score */
  const zsetItems = Array.isArray(getValue()?.value) ? (getValue()!.value as string[]) : []
  const zsetBytes = zsetItems.reduce((sum, item) => sum + utf8Bytes(item), 0)
  let max = Number.NEGATIVE_INFINITY
  let min = Number.POSITIVE_INFINITY
  for (const item of zsetItems) {
    const scoreValue = Number(splitPair(item)[1])
    if (!Number.isNaN(scoreValue)) {
      if (scoreValue > max) max = scoreValue
      if (scoreValue < min) min = scoreValue
    }
  }
  const zsetStats = {
    total: zsetItems.length,
    bytes: zsetBytes,
    max: zsetItems.length ? max : 0,
    min: zsetItems.length ? min : 0,
  }

  /** 全部成员按行拼接（复制 / 导出共用） */
  function zsetAsText(): string {
    const items = Array.isArray(getValue()?.value) ? (getValue()!.value as string[]) : []
    return items.map((raw) => splitPair(raw).join(' :: ')).join('\n')
  }

  async function copyZsetAll(): Promise<void> {
    if (!zsetStats.total) {
      notify('err', '当前 zset 没有成员')
      return
    }
    const done = await copyText(zsetAsText())
    notify(
      done ? 'ok' : 'err',
      done ? `已复制 ${zsetStats.total} 个成员` : '复制失败，请检查剪贴板权限',
    )
  }

  async function exportZset(): Promise<void> {
    const key = getValue()?.key ?? 'zset'
    const res = await api.file.saveText({
      suggestedName: `${key.replace(/[\\/:*?"<>|]/g, '_')}.txt`,
      content: zsetAsText(),
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

  return {
    zsetMenu,
    editingZset,
    setEditingZset,
    addingZset,
    setAddingZset,
    zsetMemberOf,
    copyZsetMember,
    copyZsetScore,
    copyZsetAsCommand,
    openZsetMenu,
    closeZsetMenu,
    runZsetMenuAction,
    openZsetEditor,
    handleZsetConfirm,
    removeZsetMember,
    handleAddZsetConfirm,
    zsetStats,
    zsetAsText,
    copyZsetAll,
    exportZset,
  }
}

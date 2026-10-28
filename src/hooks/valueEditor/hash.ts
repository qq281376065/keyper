import { useEffect, useState } from 'react'
import { utf8Bytes } from '@/utils/format'
import { api } from '@/api'
import { useRedis } from '@/store/useRedis'
import { copyText } from '@/utils/clipboard'
import type { ValueEditorContext } from './shared'

/**
 * hash 值编辑器：
 * 字段视图/统计、行右键菜单、字段编辑/删除、字段级 TTL（7.4+）、
 * 复制（HSET 命令/JSON/字段名/字段值）与导出。
 */
export function useHashEditor(ctx: ValueEditorContext) {
  const { getValue, getKeyword, getSortKey, getSortAsc, getCapabilities } = ctx
  const {
    state,
    notify,
    refreshSelected,
    dropElementLocally,
    replaceElementLocally,
    renameFieldLocally,
    askConfirm,
  } = useRedis()

  const ROW_MENU_WIDTH = 200
  const ROW_MENU_HEIGHT = 268

  const value = getValue()
  const keyword = getKeyword()
  const sortKey = getSortKey()
  const sortAsc = getSortAsc()
  const capabilities = getCapabilities()

  /** 正在编辑的 hash 字段（null 表示未打开弹窗） */
  const [editingField, setEditingField] = useState<{ field: string; value: string } | null>(null)
  /** 正在新增 hash 字段（hash 补新增入口；false 表示未打开弹窗） */
  const [addingField, setAddingField] = useState(false)
  /** 正在设置 TTL 的 hash 字段 */
  const [ttlField, setTtlField] = useState<{ field: string; ttl: number } | null>(null)
  /** hash 字段级 TTL：字段名 → 剩余秒数；null 表示服务端不支持或尚未加载 */
  const [fieldTtls, setFieldTtls] = useState<Record<string, number> | null>(null)
  const [loadingTtls, setLoadingTtls] = useState(false)
  /** hash 行右键菜单：目标行与坐标 */
  const [rowMenu, setRowMenu] = useState<{
    row: { field: string; text: string }
    top: number
    left: number
  } | null>(null)
  /** 当前选中的 hash 字段行（单选，null 表示未选中） */
  const [selectedField, setSelectedField] = useState<string | null>(null)

  /** hash：仅按 field 匹配（结构化展示，不做美化），支持按列排序 */
  const record = (value?.value as Record<string, string>) ?? {}
  const total = Object.keys(record).length
  const hashRows = Object.entries(record)
    .filter(([field]) => !keyword || field.toLowerCase().includes(keyword))
    .map(([field, val]) => ({ field, text: val }))
  if (sortKey === 'field') {
    hashRows.sort(
      (a, b) => a.field.localeCompare(b.field, 'zh-CN', { numeric: true }) * (sortAsc ? 1 : -1),
    )
  } else if (sortKey === 'value') {
    hashRows.sort(
      (a, b) => a.text.localeCompare(b.text, 'zh-CN', { numeric: true }) * (sortAsc ? 1 : -1),
    )
  }
  // 序号在排序完成后再编，保证始终反映当前显示顺序
  const hashView = { rows: hashRows.map((row, index) => ({ ...row, index: index + 1 })), total }

  /** hash 统计信息：字段总数、值总字节数、最大字段 */
  const entries = Object.entries(record)
  const hashBytes = entries.reduce((sum, [field, val]) => sum + utf8Bytes(field) + utf8Bytes(val), 0)
  let largest = '-'
  let largestSize = -1
  for (const [field, val] of entries) {
    const size = utf8Bytes(field) + utf8Bytes(val)
    if (size > largestSize) {
      largestSize = size
      largest = field
    }
  }
  const hashStats = { total: entries.length, bytes: hashBytes, largest }

  /**
   * 加载 hash 字段的剩余 TTL。
   * 仅在服务端支持（Redis 7.4+）且当前键为 hash 时执行，避免无谓的命令往返。
   */
  async function loadFieldTtls(): Promise<void> {
    const id = state.activeId
    const current = getValue()
    if (!id || !current || current.type !== 'hash' || !getCapabilities().hashFieldTtl) {
      setFieldTtls(null)
      return
    }

    const fields = Object.keys((current.value as Record<string, string>) ?? {})
    if (!fields.length) {
      setFieldTtls({})
      return
    }

    setLoadingTtls(true)
    try {
      const res = await api.redis.hashFieldTtls(id, current.key, fields)
      setFieldTtls(res.ok ? res.data : null)
    } finally {
      setLoadingTtls(false)
    }
  }

  // 键或能力变化时重新拉取字段 TTL
  const currentKey = value?.key ?? ''
  const capabilityFlag = capabilities.hashFieldTtl
  useEffect(() => {
    void loadFieldTtls()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, capabilityFlag])

  /** 把全部字段序列化为 JSON —— 复制与导出共用，便于直接粘进代码 */
  function hashAsJson(): string {
    return JSON.stringify((getValue()?.value as Record<string, string>) ?? {}, null, 2)
  }

  async function copyHashAll(): Promise<void> {
    if (!hashView.total) {
      notify('err', '当前 hash 没有字段')
      return
    }
    const done = await copyText(hashAsJson())
    notify(done ? 'ok' : 'err', done ? `已复制 ${hashView.total} 个字段（JSON）` : '复制失败，请检查剪贴板权限')
  }

  /** 行内「复制」：同时给出字段名与字段值，避免两次操作 */
  async function copyFieldRow(row: { field: string; text: string }): Promise<void> {
    const done = await copyText(`${row.field}\t${row.text}`)
    notify(
      done ? 'ok' : 'err',
      done ? `已复制字段 ${row.field}（名称 + 值）` : '复制失败，请检查剪贴板权限',
    )
  }

  /** 只复制字段名 */
  async function copyFieldName(field: string): Promise<void> {
    const done = await copyText(field)
    notify(done ? 'ok' : 'err', done ? `已复制字段名 ${field}` : '复制失败，请检查剪贴板权限')
  }

  /** 只复制字段值 */
  async function copyFieldValue(row: { field: string; text: string }): Promise<void> {
    const done = await copyText(row.text)
    notify(done ? 'ok' : 'err', done ? `已复制 ${row.field} 的值` : '复制失败，请检查剪贴板权限')
  }

  /** 复制为 HSET 命令：排障时可直接粘进 redis-cli 复现 */
  async function copyAsCommand(row: { field: string; text: string }): Promise<void> {
    const key = getValue()?.key ?? ''
    const command = `HSET ${key} "${row.field}" "${row.text}"`
    const done = await copyText(command)
    notify(done ? 'ok' : 'err', done ? '已复制 HSET 命令' : '复制失败，请检查剪贴板权限')
  }

  /** 复制为 JSON 键值对：便于粘进配置或代码 */
  async function copyAsJsonEntry(row: { field: string; text: string }): Promise<void> {
    const done = await copyText(JSON.stringify({ [row.field]: row.text }, null, 2))
    notify(done ? 'ok' : 'err', done ? '已复制 JSON 键值对' : '复制失败，请检查剪贴板权限')
  }

  /** 单击选中行：再次点击同一行取消选中 */
  function selectRow(field: string): void {
    setSelectedField((prev) => (prev === field ? null : field))
  }

  function openFieldEditor(row: { field: string; text: string }): void {
    setEditingField({ field: row.field, value: row.text })
  }

  /** 双击字段值直接进入修改（最常用的操作，省去先找按钮） */
  function editRowByDoubleClick(row: { field: string; text: string }): void {
    openFieldEditor(row)
  }

  /**
   * 打开行右键菜单。
   * 菜单需要在视口内完整可见，靠近底部/右侧时自动向上/向左翻转。
   */
  function openRowMenu(event: React.MouseEvent, row: { field: string; text: string }): void {
    // 右键同时把该行设为选中，让菜单目标与视觉高亮一致
    setSelectedField(row.field)
    const left =
      event.clientX + ROW_MENU_WIDTH > window.innerWidth
        ? Math.max(4, event.clientX - ROW_MENU_WIDTH)
        : event.clientX
    const top =
      event.clientY + ROW_MENU_HEIGHT > window.innerHeight
        ? Math.max(4, window.innerHeight - ROW_MENU_HEIGHT - 4)
        : event.clientY

    setRowMenu({ row, top, left })
  }

  function closeRowMenu(): void {
    setRowMenu(null)
  }

  /**
   * hash 行菜单的统一执行入口。
   * 与 list 同理：先快照 row 再关菜单，避免 `rowMenu.row` 在置空后求值抛错。
   */
  function runRowMenuAction(action: (row: { field: string; text: string }) => void): void {
    const row = rowMenu?.row
    if (!row) return
    closeRowMenu()
    action(row)
  }

  async function handleFieldSaved(payload: {
    field: string
    value: string
    renamedFrom: string
  }): Promise<void> {
    setEditingField(null)
    setAddingField(false)

    /*
     * 新增字段（add 模式，renamedFrom 为空串）：
     * HSET 语义下字段已存在时是覆盖（本地按已存在处理同样正确——
     * 覆盖走 replace 分支、真新增走 append，两种结果都与服务端一致）。
     */
    if (payload.renamedFrom === '') {
      addFieldLocally(payload.field, payload.value)
      return
    }

    // 本地更新，避免整表重读：新值已知、位置已知
    if (payload.field !== payload.renamedFrom) {
      // 字段名变更：等价于 HDEL 旧 + HSET 新，本地按原顺序替换键名
      renameFieldLocally(payload.renamedFrom, payload.field, payload.value)
      // 该字段的 TTL 随 HSET 被清除，本地缓存同步重置为「无过期时间」
      setFieldTtls((prev) => {
        if (!prev || !(payload.renamedFrom in prev)) return prev
        const next = { ...prev }
        delete next[payload.renamedFrom]
        next[payload.field] = -1
        return next
      })
    } else {
      replaceElementLocally({ field: payload.field }, payload.value)
    }
  }

  /**
   * 本地新增一个 hash 字段（避免整表重读的骨架屏闪烁）。
   *
   * 与 renameFieldLocally 同构（改 state.selectedValue 联动 hashView/hashStats），
   * 差异：新增的 field 追加在 record 末尾（保持既有字段顺序），并占位进
   * 字段 TTL 缓存（-1 = 无过期时间，与 HSET 清 TTL 的服务端行为一致）。
   * 已存在的 field 走覆盖（对象键唯一，赋值即覆盖 —— HSET 语义）。
   */
  function addFieldLocally(field: string, val: string): void {
    const current = state.selectedValue
    if (!current || Array.isArray(current.value) || !current.value) return
    const currentRecord = current.value as Record<string, string>
    state.selectedValue = { ...current, value: { ...currentRecord, [field]: val } }
    setFieldTtls((prev) => (prev ? { ...prev, [field]: -1 } : prev))
  }

  async function handleFieldTtlSaved(): Promise<void> {
    setTtlField(null)
    // 静默刷新（不闪骨架屏），并重新拉取字段 TTL 列
    await refreshSelected({ silent: true })
    await loadFieldTtls()
  }

  async function exportHash(): Promise<void> {
    const key = getValue()?.key ?? 'hash'
    const res = await api.file.saveText({
      suggestedName: `${key.replace(/[\\/:*?"<>|]/g, '_')}.json`,
      content: hashAsJson(),
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

  async function copyField(field: string): Promise<void> {
    const done = await copyText(field)
    notify(done ? 'ok' : 'err', done ? `已复制字段名 ${field}` : '复制失败，请检查剪贴板权限')
  }

  async function removeField(field: string): Promise<void> {
    const id = state.activeId
    const key = getValue()?.key
    if (!id || !key) return

    const fieldValue = (getValue()?.value as Record<string, string> | undefined)?.[field] ?? ''
    const totalCount = hashStats.total

    const confirmed = await askConfirm({
      title: '删除字段',
      message: '即将从该 hash 中移除以下字段：',
      details: [
        { label: '键名', value: key, mono: true },
        { label: '字段', value: field, mono: true, tone: 'danger' },
        { label: '字段数', value: `${totalCount} → ${totalCount - 1}`, mono: true },
      ],
      preview: {
        label: '字段值',
        text: fieldValue.length > 120 ? `${fieldValue.slice(0, 120)}…` : fieldValue || '（空值）',
        truncated: fieldValue.length > 120,
      },
      warning:
        totalCount <= 1
          ? '这是该 hash 的最后一个字段，删除后整个键也会被移除。'
          : '删除后无法恢复。',
      confirmText: '删除',
      danger: true,
    })
    if (!confirmed) return

    const res = await api.redis.delHashField(id, key, field)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.ok) {
      notify('err', res.data.message ?? '删除失败')
      return
    }
    notify('ok', res.data.message ?? '已删除')

    // 先记下是否最后一个字段：Redis 在字段清空后会连带移除整个键，
    // 此时应清空选中态，而不是让界面停留在一个已不存在的空壳上
    const wasLastField = (getValue()?.length ?? 0) <= 1

    // 本地移除该字段（按字段名匹配），零 IPC 往返，避免整表重读的骨架屏闪烁
    dropElementLocally((item) => item === field)

    // 同步清理该字段的 TTL 缓存，否则会残留已不存在字段的过期数据
    setFieldTtls((prev) => {
      if (!prev) return prev
      const next = { ...prev }
      delete next[field]
      return next
    })

    if (wasLastField) state.selectedValue = null
  }

  return {
    editingField,
    setEditingField,
    ttlField,
    setTtlField,
    fieldTtls,
    loadingTtls,
    rowMenu,
    selectedField,
    hashView,
    hashStats,
    loadFieldTtls,
    copyHashAll,
    copyFieldRow,
    copyFieldName,
    copyFieldValue,
    copyAsCommand,
    copyAsJsonEntry,
    selectRow,
    openFieldEditor,
    editRowByDoubleClick,
    openRowMenu,
    closeRowMenu,
    runRowMenuAction,
    handleFieldSaved,
    addingField,
    setAddingField,
    handleFieldTtlSaved,
    exportHash,
    copyField,
    removeField,
  }
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '@/api'
import { BulkOpsPanel } from '@/components/BulkOpsPanel'
import { DialogIcon } from '@/components/DialogIcon'
import { VirtualStringLines } from '@/components/VirtualStringLines'
import { EditHashFieldDialog } from '@/components/EditHashFieldDialog'
import { EditHashFieldTtlDialog } from '@/components/EditHashFieldTtlDialog'
import { EditListElementDialog } from '@/components/EditListElementDialog'
import { EditValueDialog } from '@/components/EditValueDialog'
import { EditZsetMemberDialog } from '@/components/EditZsetMemberDialog'
import { PromptDialog } from '@/components/PromptDialog'
import { ServerOverview } from '@/components/ServerOverview'
import { SortIcon } from '@/components/SortIcon'
import { StreamAddEntryDialog } from '@/components/StreamAddEntryDialog'
import { ValueActions } from '@/components/ValueActions'
import { ViewStreamEntryDialog } from '@/components/ViewStreamEntryDialog'
import { tipProps } from '@/components/tip'
import { buildLineView } from '@/hooks/valueEditor/shared'
import { useHashEditor } from '@/hooks/valueEditor/hash'
import { useListEditor } from '@/hooks/valueEditor/list'
import { useSetEditor } from '@/hooks/valueEditor/set'
import { useStreamEditor } from '@/hooks/valueEditor/stream'
import { useStringEditor } from '@/hooks/valueEditor/string'
import { useZsetEditor } from '@/hooks/valueEditor/zset'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { useSessionStore } from '@/hooks/useSessionStore'
import { useTabBlur } from '@/hooks/useTabBlur'
import { formatBytes, formatTtl, ttlTone, utf8Bytes } from '@/utils/format'
import { resolveCapabilities } from '@/utils/redisCapability'
import { copyText } from '@/utils/clipboard'
import type { KeyValue } from '@shared/types'

/** 支持搜索的类型：含多个元素的容器按行过滤 */
const SEARCHABLE_TYPES = ['hash', 'list', 'set', 'zset', 'stream']

/** 自动刷新间隔（仅 hash / list / set / zset / stream 提供开关） */
const AUTO_REFRESH_INTERVAL = 5000

const DEFAULT_COL_WIDTH: Record<'hash' | 'zset', { field: number; value: number }> = {
  hash: { field: 200, value: 420 },
  zset: { field: 240, value: 160 },
}

/** 列宽约束：过窄内容不可读，过宽会挤掉后续列 */
const COL_MIN = 80
const COL_MAX = 900

/**
 * 固定列合计宽度（序号 40 + 操作 84）。
 * 这些列不可调整，计算中间列可用空间时必须先扣掉。
 */
const FIXED_COLS_HASH = 40 + 84
const FIXED_COLS_ZSET = 40 + 84

/** TTL 常用值：省去用户心算秒数 */
const TTL_PRESETS = [
  { label: '1 分钟', value: '60' },
  { label: '5 分钟', value: '300' },
  { label: '30 分钟', value: '1800' },
  { label: '1 小时', value: '3600' },
  { label: '1 天', value: '86400' },
  { label: '7 天', value: '604800' },
  { label: '永久', value: '0' },
]

/** 行内操作图标（与 Vue 版逐一对应，路径原样保留） */
const ICON_COPY = (
  <>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
  </>
)
const ICON_EDIT = <path d="M11.2 2.6a1.6 1.6 0 0 1 2.2 2.2l-6.6 6.6-2.9.7.7-2.9z" />
const ICON_DELETE = <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8" />
const ICON_TEXT = <path d="M3 3.5h10M3 7h10M3 10.5h6" />
const ICON_EYE = (
  <>
    <path d="M1.5 8S3.9 3.8 8 3.8 14.5 8 14.5 8 12.1 12.2 8 12.2 1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="2" />
  </>
)

/**
 * 值查看/编辑区（右侧主面板）。
 *
 * 结构：
 *   BulkOpsPanel（批量任务进行中独占）→ 骨架屏 → 值头 + 工具栏 + 表格 → 状态栏
 *   未选键时展示 ServerOverview（已连接）或占位提示。
 *
 * 移植说明：
 * - 7 个 editor hook 与 Vue 版一一对应（string/hash/list/set/zset/stream + lineView）；
 * - 模板里的 v-if 链改为按类型分支渲染的表单片段；
 * - 浮层菜单用 createPortal 挂到 body（与 Vue 的 Teleport 等价）。
 */
export function ValueViewer() {
  const { state, activeConnection, renameKey, setTtl, notify, refreshSelected } = useRedis()
  /* 订阅：本标签的会话（或全局）任一写入都重渲染 —— 与 Vue 的响应式粒度一致 */
  useObservable(useSessionStore())

  const value = state.selectedValue
  /** 正在读取键值：期间展示骨架屏，避免右侧看起来"卡住" */
  const loading = state.loadingValue
  /** 刷新当前键：值区叠加轻量 loading，页面结构保持不变 */
  const refreshingValue = state.refreshingValue

  /**
   * 服务端能力：由当前连接的 redis_version 推导。
   * hash 字段级 TTL 需要 Redis 7.4+，版本未知时按不支持处理。
   */
  const capabilities = resolveCapabilities(activeConnection?.version)

  const [filter, setFilter] = useState('')
  const [pretty, setPretty] = useState(true)
  /** 自动换行：关闭后超长单行可横向滚动，便于比对长串 */
  const [wrap, setWrap] = useState(true)

  const [renameVisible, setRenameVisible] = useState(false)
  const [ttlVisible, setTtlVisible] = useState(false)
  const [editVisible, setEditVisible] = useState(false)
  /** 自动刷新开关：开启后每 5 秒重新读取一次 */
  const [autoRefresh, setAutoRefresh] = useState(false)

  /** 排序键：field（hash 字段名）/ value（内容或 score）/ member（zset 成员、stream ID） */
  const [sortKey, setSortKey] = useState<'field' | 'value' | 'member' | null>(null)
  const [sortAsc, setSortAsc] = useState(true)

  /**
   * 列宽（仅 hash / zset，按类型独立记录，仅会话内有效 —— 按要求不持久化）。
   * 用 CSS 变量驱动栅格而非拼接 grid-template-columns 字符串。
   */
  const [colWidth, setColWidth] = useState({
    hash: { ...DEFAULT_COL_WIDTH.hash },
    zset: { ...DEFAULT_COL_WIDTH.zset },
  })

  /** 表格容器的实际可用宽度，用于约束拖拽上限 */
  const [tableWidth, setTableWidth] = useState(0)
  const tableRef = useRef<HTMLDivElement | null>(null)

  /*
   * 拖拽上下文：记录起始位置与起始宽度。
   * 用 ref 而非 state：拖拽过程每帧都读，state 会有批处理延迟。
   */
  const dragState = useRef<{
    type: 'hash' | 'zset'
    which: 'field' | 'value'
    startX: number
    startWidth: number
  } | null>(null)

  /**
   * 当前列可拖到的最大宽度。
   *
   * 不用固定 COL_MAX：中间列拖宽后总宽可能超出容器。
   * 虽然表格已允许横向滚动，但让用户拖到"需要滚动才能看见操作列"
   * 不是好的默认体验，因此上限按容器实测宽度推导。
   */
  function colMaxFor(type: 'hash' | 'zset'): number {
    if (!tableWidth) return COL_MAX
    const fixed = type === 'hash' ? FIXED_COLS_HASH : FIXED_COLS_ZSET
    const others =
      type === 'hash' ? (dragState.current?.which === 'field' ? colWidth.hash.value : colWidth.hash.field) : 0
    const available = tableWidth - fixed - others - 4
    return Math.max(COL_MIN, Math.min(COL_MAX, available))
  }

  /** 记录容器宽度，供拖拽上限计算使用 */
  function measureTable(): void {
    setTableWidth(tableRef.current?.clientWidth ?? 0)
  }

  /**
   * 提供给栅格的 CSS 变量。
   *
   * hash：两列都可拖，分别输出 --w-first（field）与 --w-second（value）。
   * zset：**只有 member 列可拖**，因此只输出 --w-first；
   *       score 列由 CSS 的 `minmax(80px, 1fr)` 自行吸收容器余量，
   *       若在这里输出 --w-second 会把它钉成固定值，导致操作列不贴右边界。
   */
  const colVars: Record<string, string> =
    value?.type === 'hash'
      ? { '--w-first': `${colWidth.hash.field}px`, '--w-second': `${colWidth.hash.value}px` }
      : value?.type === 'zset'
        ? { '--w-first': `${colWidth.zset.field}px` }
        : {}

  function onColResizeMove(event: MouseEvent): void {
    const st = dragState.current
    if (!st) return
    // 基于起始宽度 + 总位移计算，而非逐次累加 —— 避免亚像素偏差累积
    const delta = event.clientX - st.startX
    const next = Math.min(colMaxFor(st.type), Math.max(COL_MIN, st.startWidth + delta))
    setColWidth((prev) => ({ ...prev, [st.type]: { ...prev[st.type], [st.which]: next } }))
  }

  function stopColResize(): void {
    dragState.current = null
    document.body.classList.remove('col-resizing')
    window.removeEventListener('mousemove', onColResizeMove)
    window.removeEventListener('mouseup', stopColResize)
  }

  function startColResize(event: React.MouseEvent, which: 'field' | 'value'): void {
    const type = value?.type
    if (type !== 'hash' && type !== 'zset') return

    // 拖拽前提是测量容器宽度，否则 colMaxFor 只能退回固定上限
    measureTable()

    event.preventDefault()
    event.stopPropagation()
    dragState.current = {
      type,
      which,
      startX: event.clientX,
      startWidth: colWidth[type][which],
    }

    document.body.classList.add('col-resizing')
    window.addEventListener('mousemove', onColResizeMove)
    window.addEventListener('mouseup', stopColResize)
  }

  /** 双击手柄恢复该列默认宽度 */
  function resetColWidth(which: 'field' | 'value'): void {
    const type = value?.type
    if (type !== 'hash' && type !== 'zset') return
    setColWidth((prev) => ({ ...prev, [type]: { ...prev[type], [which]: DEFAULT_COL_WIDTH[type][which] } }))
  }

  const keyword = filter.trim().toLowerCase()

  /** editor hook 的上下文：用 getter 捕获当前渲染的最新值 */
  const ctx = {
    getValue: () => state.selectedValue,
    getKeyword: () => keyword,
    getPretty: () => pretty,
    getCapabilities: () => capabilities,
    getSortKey: () => sortKey,
    getSortAsc: () => sortAsc,
  }

  /** 行视图（list / set / zset / stream 共用） */
  const lineView = useMemo(
    () => buildLineView(value, keyword, sortKey, sortAsc),
    [value, keyword, sortKey, sortAsc],
  )

  const [selectedListIndex, setSelectedListIndex] = useState<number | null>(null)

  /*
   * list 统计信息用 useMemo 收敛。
   *
   * 原实现是 IIFE：每次渲染都对所有元素 new Blob() 算字节数。
   * string 值的 value 不是数组，这里 items 为空、开销看似为零，
   * 但一旦是 list/stream 类型（或父组件因任何原因重渲染），
   * 每个元素都要分配一个 Blob 对象 —— 1000 个元素就是 1000 次分配。
   * 元素内容与顺序不变时没有重算的必要。
   */
  const listStats = useMemo(() => {
    const items = Array.isArray(value?.value) ? (value!.value as string[]) : []
    let bytes = 0
    let largest = -1
    let largestSize = -1
    items.forEach((item, index) => {
      const size = utf8Bytes(item)
      bytes += size
      if (size > largestSize) {
        largestSize = size
        largest = index + 1
      }
    })
    return { total: items.length, bytes, largest: largest > 0 ? `#${largest}` : '-' }
  }, [value])

  const stringEditor = useStringEditor(ctx)
  const hashEditor = useHashEditor(ctx)
  const listEditor = useListEditor(ctx, { listStats, selectedListIndex, setSelectedListIndex })
  const setEditor = useSetEditor(ctx, { setSelectedListIndex })
  const zsetEditor = useZsetEditor(ctx, { setSelectedListIndex })
  const streamEditor = useStreamEditor(ctx, { lineView, setSelectedListIndex })

  /**
   * 关闭全部类型的行右键菜单。
   * 各类型的菜单是独立状态，Esc 与窗口缩放必须全部关闭 ——
   * 只关当前类型会残留其它类型的浮层。
   */
  function closeAllRowMenus(): void {
    hashEditor.closeRowMenu()
    listEditor.closeListMenu()
    setEditor.closeSetMenu()
    zsetEditor.closeZsetMenu()
    streamEditor.closeStreamMenu()
  }

  // 切换键时重置过滤词、排序与全部浮层状态，避免上一次的状态影响新键
  const valueKey = value?.key ?? ''
  useEffect(() => {
    setFilter('')
    setSortKey(null)
    setSortAsc(true)
    setSelectedListIndex(null)
    hashEditor.setEditingField(null)
    hashEditor.setTtlField(null)
    listEditor.setEditingListIndex(null)
    setEditor.setEditingSetMember(null)
    zsetEditor.setEditingZset(null)
    streamEditor.setViewingStreamEntry(null)
    closeAllRowMenus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey])

  useEffect(() => {
    measureTable()
  }, [valueKey, value?.type])

  /**
   * 标签切走时关闭全部 portal 浮层。
   * 这些菜单挂在 body 上，display:none 管不到它们，
   * 不主动关闭会带着上一个连接的数据留在屏幕上。
   */
  useTabBlur(closeAllRowMenus)

  /** 自动刷新：每 5 秒重读当前键 */
  const refreshing = useRef(false)

  async function tickAutoRefresh(): Promise<void> {
    if (refreshing.current) return
    /*
     * 三种情况刻意跳过刷新，避免打断用户操作或造成无谓请求：
     * 1. 有弹窗打开（编辑 / TTL / 重命名）—— 刷新会让弹窗依据的旧值突然变化；
     * 2. 右键菜单打开 —— 菜单锚定在具体行上，数据变化会让它指向错位；
     * 3. 上一次刷新尚未返回 —— 防止慢连接下请求堆积。
     */
    if (
      hashEditor.editingField ||
      hashEditor.addingField ||
      hashEditor.ttlField ||
      hashEditor.rowMenu ||
      renameVisible ||
      ttlVisible ||
      streamEditor.addingEntry ||
      streamEditor.viewingStreamEntry ||
      streamEditor.streamMenu
    ) {
      return
    }
    refreshing.current = true
    try {
      // 静默刷新：自动刷新同样不该触发骨架屏，否则每 5 秒整个值区闪一次
      await refreshSelected({ silent: true })
    } finally {
      refreshing.current = false
    }
  }

  useEffect(() => {
    if (!autoRefresh) return
    const timer = setInterval(() => void tickAutoRefresh(), AUTO_REFRESH_INTERVAL)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh])

  // 切换类型 / 断开连接时自动关闭：自动刷新对 string 无意义
  useEffect(() => {
    if (value?.type !== 'hash' && value?.type !== 'list' && value?.type !== 'set' && value?.type !== 'zset' && value?.type !== 'stream') {
      setAutoRefresh(false)
    }
  }, [value?.type])

  /** Esc 关闭行菜单；窗口尺寸变化时坐标会失效，一并关闭 */
  useEffect(() => {
    function onKeydown(event: KeyboardEvent): void {
      if (event.key === 'Escape') closeAllRowMenus()
    }
    function onResize(): void {
      closeAllRowMenus()
      measureTable()
    }
    window.addEventListener('keydown', onKeydown)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('resize', onResize)
      // 拖拽监听同理：销毁时若仍在拖拽会残留全局监听
      stopColResize()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---------------------------------------------------------------- 值级操作 */
  const searchPlaceholder =
    value?.type === 'hash'
      ? '搜索 field 或 value'
      : value?.type === 'zset'
        ? '搜索 member'
        : value?.type === 'stream'
          ? '搜索 ID 或字段内容'
          : '搜索元素内容'

  /** 点击表头排序：同列再次点击切换升降序，换列则重置为升序 */
  function toggleSort(key: 'field' | 'value' | 'member'): void {
    if (sortKey === key) {
      setSortAsc((prev) => !prev)
      return
    }
    setSortKey(key)
    // 默认升序；zset 未显式指定时的降序由 lineView 内的默认分支处理
    setSortAsc(true)
  }

  const matchedCount = !value ? 0 : value.type === 'string' ? 0 : value.type === 'hash' ? hashEditor.hashView.rows.length : lineView.rows.length
  const totalCount = !value ? 0 : value.type === 'hash' ? hashEditor.hashView.total : lineView.total
  const ttlLabel = formatTtl(value?.ttl ?? -2)
  const searchable = !!value && SEARCHABLE_TYPES.includes(value.type)

  async function copyValue(): Promise<void> {
    const text = stringEditor.stringView.text
    if (!text) {
      notify('err', '内容为空')
      return
    }
    const done = await copyText(text)
    notify(done ? 'ok' : 'err', done ? `已复制（${text.length} 字符）` : '复制失败，请检查剪贴板权限')
  }

  async function exportValue(): Promise<void> {
    const text = stringEditor.stringView.text
    const key = value?.key ?? 'value'
    // 键名可能含 : / * ? 等不适合做文件名的字符，统一替换
    const suggested = `${key.replace(/[\\/:*?"<>|]/g, '_')}.txt`
    const res = await api.file.saveText({ suggestedName: suggested, content: text })
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

  /**
   * 手动刷新当前键。
   * 传 silent：键没有变，只需在值区叠加轻量 loading，
   * 不走骨架屏 —— 否则整块内容重绘，看起来像切换了键。
   */
  async function refreshValue(): Promise<void> {
    await refreshSelected({ silent: true })
  }

  async function handleRename(next: string): Promise<void> {
    setRenameVisible(false)
    const target = next.trim()
    if (!target || target === value?.key) return
    await renameKey(value!.key, target)
  }

  async function handleTtl(next: string): Promise<void> {
    setTtlVisible(false)
    const seconds = Number(next)
    if (Number.isNaN(seconds)) {
      notify('err', 'TTL 需为数字（秒）')
      return
    }
    await setTtl(value!.key, seconds)
  }

  return (
    <section className="viewer s-value-viewer">
      {/*
        批量操作面板：必须有连接才显示。
        除了 store 在断开时会清理 bulkTask，这里再加一道渲染层的保险 ——
        面板里的「执行 / 取消」都依赖 activeId，无连接时露出来就是个死界面。
      */}
      {state.bulkTask && state.activeId ? <BulkOpsPanel /> : loading ? (
        <SkeletonValue />
      ) : value ? (
        <>
          {/*
            值区头部 —— 票根 + 水印（design/key-header-avant.html 方案 05）

            结构：
              ┌─┬──────────────────────────────────┐
              │竖│  键名                    ⋮ 菜单  │
              │排│  TTL | encoding | 大小           │
              │类│              ⌜S⌝ 大字水印        │
              └─┴──────────────────────────────────┘
              ↑ 26px 存根，右侧一排半圆撕口，旁边虚线压痕

            为什么这样设计：
              · 存根把"类型"从一行的第一个徽标挪到侧边竖排 —— 腾出整行给键名，
                长键名能多显示约 40px；
              · 半圆撕口 + 虚线压痕构成"可撕凭证"的隐喻，与"这是某条数据的
                快照"语义契合，比纯文字头部更有辨识度；
              · 水印是类型首字母，压在票面右侧、键名之下（z-index 低于文字），
                72px 字号在本就空着的右侧占位，不干扰阅读。
            高度固定 75px：三个部件（存根竖排字、两行文字、水印）都能容纳。
          */}
          <header className={`viewer-head ticket-head type-${value.type}`} data-letter={value.type.charAt(0).toUpperCase()}>
            {/* 存根：竖排类型名 + 右侧一排半圆撕口 */}
            <div className="ticket-stub" aria-hidden="true">
              <span>{value.type}</span>
            </div>
            {/* 虚线压痕：与撕口平行，强化"可撕"的观感 */}
            <div className="ticket-perf" aria-hidden="true" />

            <div className="ticket-body">
              <div className="key-line">
                <span className="key-name mono ellipsis" {...tipProps(value.key)}>
                  {value.key}
                </span>

                <span className="spacer" />

                <ValueActions onRename={() => setRenameVisible(true)} onSetTtl={() => setTtlVisible(true)} />
              </div>

              <div className="meta-line">
                <span>
                  TTL：<b className="mono">{ttlLabel}</b>
                </span>
                <span className="sep">|</span>
                <span>
                  encoding：<b className="mono">{value.encoding ?? '-'}</b>
                </span>
                <span className="sep">|</span>
                <span>
                  大小：<b className="mono">{value.length ?? '-'}</b>
                </span>
              </div>
            </div>
          </header>

          {/* ---------------- 工具栏（按类型分支） ---------------- */}
          {value.type === 'string' && !stringEditor.stringEditing ? (
            <div className="value-toolbar">
              {/*
                六个操作合成一个分段控件（iOS pill segmented）。

                前四个是「动作」，后两个是「视图开关」—— 语义上不同组，
                但按 design/toolbar-10-schemes.html 方案 02 的取舍：
                视觉整齐度优先，用「是否有激活态」让开关自己浮出来。
                开关项（JSON 美化 / 自动换行）默认常开，所以常态下
                这两个块是浮起的，动作块是平的，一眼能分辨两类。
              */}
              <div className="seg-group">
                <button className="tool" {...tipProps('进入编辑（也可双击值区域）')} onClick={stringEditor.enterStringEditExplicit}>
                  <DialogIcon name="edit" size={12} className="ti" />
                  编辑
                </button>
                <button className="tool" {...tipProps('复制全部内容')} onClick={copyValue}>
                  <DialogIcon name="copy" size={12} className="ti" />
                  复制
                </button>
                <button
                  className={`tool${pretty ? ' on' : ''}`}
                  {...tipProps(pretty ? '已开启 JSON 美化，点击查看原始内容' : '点击按 JSON 缩进重排')}
                  onClick={() => setPretty((prev) => !prev)}
                >
                  <DialogIcon name="info" size={12} className="ti" />
                  JSON 美化
                </button>
                <button
                  className={`tool${wrap ? ' on' : ''}`}
                  {...tipProps(wrap ? '已开启自动换行，点击改为横向滚动' : '点击恢复自动换行')}
                  onClick={() => setWrap((prev) => !prev)}
                >
                  <DialogIcon name="text" size={12} className="ti" />
                  自动换行
                </button>
                <button className="tool" {...tipProps('导出为本地文件')} onClick={exportValue}>
                  <DialogIcon name="export" size={12} className="ti" />
                  导出
                </button>
                <button className="tool" {...tipProps('重新读取该键')} onClick={refreshValue}>
                  <DialogIcon name="refresh" size={12} className="ti" />
                  刷新
                </button>
              </div>
              <span className="spacer" />
              <FilterBox value={filter} onChange={setFilter} placeholder="搜索值内容" className="string-filter" />
            </div>
          ) : value.type === 'hash' ? (
            <div className="value-toolbar">
              {/* 操作合成一个分段控件，与 string 类型同一套视觉 */}
              <div className="seg-group">
              <button className="tool" {...tipProps('以 JSON 格式复制全部字段')} onClick={hashEditor.copyHashAll}>
                <DialogIcon name="copy" size={12} className="ti" />
                复制
              </button>
              <button className="tool" {...tipProps('导出为 JSON 文件')} onClick={hashEditor.exportHash}>
                <DialogIcon name="export" size={12} className="ti" />
                导出
              </button>
              <button
                className="tool"
                {...tipProps('新增字段（已存在则覆盖其值）')}
                onClick={() => hashEditor.setAddingField(true)}
              >
                <DialogIcon name="add" size={12} className="ti" />
                新增
              </button>
              <button className="tool" {...tipProps('重新读取该键')} onClick={refreshValue}>
                <DialogIcon name="refresh" size={12} className="ti" />
                刷新
              </button>
              {/* 分隔线：动作按钮与「自动刷新」开关语义不同，用一条竖线分组 */}
              <span className="seg-divider" aria-hidden="true" />
              <AutoRefreshSwitch value={autoRefresh} onChange={setAutoRefresh} />
              </div>

              <span className="spacer" />
              <FilterBox value={filter} onChange={setFilter} placeholder="搜索 field" className="field-filter" />
            </div>
          ) : value.type === 'list' ? (
            <div className="value-toolbar">
              {/* 操作合成一个分段控件，与 string 类型同一套视觉 */}
              <div className="seg-group">
              <button className="tool" {...tipProps('复制全部元素（每行一项）')} onClick={listEditor.copyListAll}>
                <DialogIcon name="copy" size={12} className="ti" />
                复制
              </button>
              <button className="tool" {...tipProps('导出为文本文件')} onClick={listEditor.exportList}>
                <DialogIcon name="export" size={12} className="ti" />
                导出
              </button>
              <button
                className="tool"
                {...tipProps('在末尾追加元素')}
                onClick={() => listEditor.openInsertDialog({ index: listStats.total - 1, text: '' }, 'after')}
              >
                <DialogIcon name="add" size={12} className="ti" />
                追加
              </button>
              <button className="tool" {...tipProps('重新读取该键')} onClick={refreshValue}>
                <DialogIcon name="refresh" size={12} className="ti" />
                刷新
              </button>
              {/* 分隔线：动作按钮与「自动刷新」开关语义不同，用一条竖线分组 */}
              <span className="seg-divider" aria-hidden="true" />
              <AutoRefreshSwitch value={autoRefresh} onChange={setAutoRefresh} />
              </div>

              <span className="spacer" />
              <FilterBox value={filter} onChange={setFilter} placeholder="搜索元素" className="list-filter" />
            </div>
          ) : value.type === 'set' ? (
            <div className="value-toolbar">
              {/* 操作合成一个分段控件，与 string 类型同一套视觉 */}
              <div className="seg-group">
              <button className="tool" {...tipProps('复制全部成员（每行一个）')} onClick={setEditor.copySetAll}>
                <DialogIcon name="copy" size={12} className="ti" />
                复制
              </button>
              <button className="tool" {...tipProps('导出为文本文件')} onClick={setEditor.exportSet}>
                <DialogIcon name="export" size={12} className="ti" />
                导出
              </button>
              <button
                className="tool"
                {...tipProps('新增成员（已存在则不会重复添加）')}
                onClick={() => setEditor.setAddingMember(true)}
              >
                <DialogIcon name="add" size={12} className="ti" />
                新增
              </button>
              <button className="tool" {...tipProps('重新读取该键')} onClick={refreshValue}>
                <DialogIcon name="refresh" size={12} className="ti" />
                刷新
              </button>
              {/* 分隔线：动作按钮与「自动刷新」开关语义不同，用一条竖线分组 */}
              <span className="seg-divider" aria-hidden="true" />
              <AutoRefreshSwitch value={autoRefresh} onChange={setAutoRefresh} />
              </div>

              <span className="spacer" />
              <FilterBox value={filter} onChange={setFilter} placeholder="搜索成员" className="list-filter" />
            </div>
          ) : value.type === 'zset' ? (
            <div className="value-toolbar">
              {/* 操作合成一个分段控件，与 string 类型同一套视觉 */}
              <div className="seg-group">
              <button
                className="tool"
                {...tipProps('复制全部成员（member :: score，每行一个）')}
                onClick={zsetEditor.copyZsetAll}
              >
                <DialogIcon name="copy" size={12} className="ti" />
                复制
              </button>
              <button className="tool" {...tipProps('导出为文本文件')} onClick={zsetEditor.exportZset}>
                <DialogIcon name="export" size={12} className="ti" />
                导出
              </button>
              <button
                className="tool"
                {...tipProps('新增成员（已存在则更新 score）')}
                onClick={() => zsetEditor.setAddingZset(true)}
              >
                <DialogIcon name="add" size={12} className="ti" />
                新增
              </button>
              <button className="tool" {...tipProps('重新读取该键')} onClick={refreshValue}>
                <DialogIcon name="refresh" size={12} className="ti" />
                刷新
              </button>
              {/* 分隔线：动作按钮与「自动刷新」开关语义不同，用一条竖线分组 */}
              <span className="seg-divider" aria-hidden="true" />
              <AutoRefreshSwitch value={autoRefresh} onChange={setAutoRefresh} />
              </div>

              <span className="spacer" />
              <FilterBox value={filter} onChange={setFilter} placeholder="搜索 member" className="list-filter" />
            </div>
          ) : value.type === 'stream' ? (
            /* stream 为只读日志：历史 entry 只读，但提供 XADD 追加新消息 */
            <div className="value-toolbar">
              {/* 操作合成一个分段控件，与 string 类型同一套视觉 */}
              <div className="seg-group">
              <button
                className="tool"
                {...tipProps('复制全部 entry（entry ID + 字段，每行一条）')}
                onClick={streamEditor.copyStreamAll}
              >
                <DialogIcon name="copy" size={12} className="ti" />
                复制
              </button>
              <button className="tool" {...tipProps('导出为文本文件')} onClick={streamEditor.exportStream}>
                <DialogIcon name="export" size={12} className="ti" />
                导出
              </button>
              <button
                className="tool"
                {...tipProps('追加一条消息（XADD，ID 自动生成）')}
                onClick={() => streamEditor.setAddingEntry(true)}
              >
                <DialogIcon name="add" size={12} className="ti" />
                追加
              </button>
              <button className="tool" {...tipProps('重新读取该键')} onClick={refreshValue}>
                <DialogIcon name="refresh" size={12} className="ti" />
                刷新
              </button>
              {/* 分隔线：动作按钮与「自动刷新」开关语义不同，用一条竖线分组 */}
              <span className="seg-divider" aria-hidden="true" />
              <AutoRefreshSwitch value={autoRefresh} onChange={setAutoRefresh} />
              </div>

              <span className="spacer" />
              <FilterBox value={filter} onChange={setFilter} placeholder="搜索 entry" className="list-filter" />
            </div>
          ) : searchable ? (
            <div className="value-toolbar">
              <FilterBox value={filter} onChange={setFilter} placeholder={searchPlaceholder} />
              <span className="counter mono">
                {matchedCount} / {totalCount}
              </span>
            </div>
          ) : null}

          {/* 值区外层：承载刷新时的轻量 loading 遮罩（不改变内部布局） */}
          <div className="value-area">
            <div className="value-body">
              {value.type === 'string' && !keyword && stringEditor.stringEditing ? (
                /* string 行内编辑态：取消/保存按钮置于文本框上方 */
                <div className="text-edit-area">
                  <div className="edit-actions">
                    <span className="edit-hint">编辑中 · Esc 取消，Ctrl+Enter 保存</span>
                    <span className="spacer" />
                    <button className="tool" disabled={stringEditor.stringSaving} onClick={stringEditor.cancelStringEdit}>
                      <DialogIcon name="cancel" size={12} className="ti" />
                      取消
                    </button>
                    <button
                      className="tool primary"
                      disabled={stringEditor.stringSaving}
                      onClick={() => void stringEditor.saveStringEdit()}
                    >
                      <DialogIcon name="save" size={12} className="ti" />
                      {stringEditor.stringSaving ? '保存中…' : '保存'}
                    </button>
                  </div>
                  <textarea
                    ref={stringEditor.stringEditRef}
                    value={stringEditor.stringDraft}
                    onChange={(event) => stringEditor.setStringDraft(event.target.value)}
                    className="text-edit mono"
                    wrap={wrap ? 'soft' : 'off'}
                    spellCheck={false}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        stringEditor.cancelStringEdit()
                      } else if (event.key === 'Enter' && event.ctrlKey) {
                        event.preventDefault()
                        void stringEditor.saveStringEdit()
                      }
                    }}
                  />
                </div>
              ) : value.type === 'string' && !keyword ? (
                /*
                 * string：无搜索时逐行渲染（左侧行号列 + 行文本，双击进入编辑）。
                 *
                 * 用虚拟滚动而不是「超过 N 行就整块渲染」——
                 * 后者会让大值完全没有行号（getConfigPub 140 行即踩中），
                 * 用户看到的就是"行号消失、内容错位"。
                 * 虚拟滚动下 DOM 节点数只与视口高度有关，行号在任何行数下都存在。
                 */
                <>
                  <VirtualStringLines
                    lines={stringEditor.stringLines}
                    wrap={wrap}
                    onDoubleClick={stringEditor.enterStringEditExplicit}
                  />
                  {/*
                    只读标记：与 hash/list/set/zset/stream 放在同一位置 ——
                    值区底部的 .row-tip 行。其它类型的表格用 sticky 吸底，
                    string 是纯文本块，这里用普通吸底行达成同样的视觉位置：
                    贴住值区底边、始终可见（不随文本滚动）。

                    位置统一的意义：用户在任意类型下"只读"都在同一个地方，
                    不用每换一种类型就重新找一遍。
                  */}
                  <p className="row-tip text-row-tip">
                    <span className="tip-text">双击文本可进入编辑 · 或用操作栏「编辑」</span>
                    <span
                      className="readonly-tag"
                      {...tipProps('值区域仅作只读展示，修改请用操作栏「编辑」或双击文本')}
                    >
                      只读
                    </span>
                  </p>
                </>
              ) : value.type === 'string' ? (
                /* string 搜索态：只显示命中行（带原始行号），命中片段高亮。同样虚拟滚动 */
                stringEditor.stringFilteredLines.length ? (
                  <VirtualStringLines
                    lines={stringEditor.stringFilteredLines}
                    wrap={wrap}
                    renderLine={(line) =>
                      stringEditor.highlightSegments(line.text).map((seg, i) =>
                        seg.hit ? (
                          <mark key={i} className="hit">
                            {seg.text}
                          </mark>
                        ) : (
                          <span key={i}>{seg.text}</span>
                        ),
                      )
                    }
                  />
                ) : (
                  <p className="lines-empty">没有匹配的行，清除搜索条件可查看完整内容</p>
                )
              ) : value.type === 'hash' ? (
                /* hash：field / value 两列 */
                <div ref={tableRef} className="pair-table" style={colVars as React.CSSProperties}>
                  <div className={`pair-head resizable${capabilities.hashFieldTtl ? ' with-ttl' : ''}`}>
                    <span className="th idx-head">#</span>
                    <div className="th-cell">
                      <button className={`th sortable${sortKey === 'field' ? ' on' : ''}`} onClick={() => toggleSort('field')}>
                        field
                        <SortIcon direction={sortKey === 'field' ? (sortAsc ? 'asc' : 'desc') : null} />
                      </button>
                      <span
                        className="col-handle"
                        {...tipProps('拖动调整列宽，双击恢复默认')}
                        onMouseDown={(event) => startColResize(event, 'field')}
                        onDoubleClick={(event) => {
                          event.stopPropagation()
                          resetColWidth('field')
                        }}
                      />
                    </div>
                    <div className="th-cell">
                      <button className={`th sortable${sortKey === 'value' ? ' on' : ''}`} onClick={() => toggleSort('value')}>
                        value
                        <SortIcon direction={sortKey === 'value' ? (sortAsc ? 'asc' : 'desc') : null} />
                      </button>
                      <span
                        className="col-handle"
                        {...tipProps('拖动调整列宽，双击恢复默认')}
                        onMouseDown={(event) => startColResize(event, 'value')}
                        onDoubleClick={(event) => {
                          event.stopPropagation()
                          resetColWidth('value')
                        }}
                      />
                    </div>
                    {/* 字段级 TTL 列仅在服务端支持时渲染（Redis 7.4+） */}
                    {capabilities.hashFieldTtl ? (
                      <span className="th ttl-head" {...tipProps('字段级 TTL（Redis 7.4+）')}>
                        TTL
                      </span>
                    ) : null}
                    <span className="th ops-head">操作</span>
                  </div>
                  {hashEditor.hashView.rows.map((row) => (
                    <div
                      key={row.field}
                      className={`pair-row${capabilities.hashFieldTtl ? ' with-ttl' : ''}${
                        hashEditor.selectedField === row.field ? ' selected' : ''
                      }`}
                      onClick={() => hashEditor.selectRow(row.field)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        hashEditor.openRowMenu(event, row)
                      }}
                      onDoubleClick={() => hashEditor.editRowByDoubleClick(row)}
                    >
                      <span className="pair-idx mono">{row.index}</span>
                      <span className="pair-key mono ellipsis" {...tipProps(row.field)}>
                        {row.field}
                      </span>
                      <pre
                        className="pair-value mono"
                        onContextMenu={(event) => {
                          event.preventDefault()
                          hashEditor.openRowMenu(event, row)
                        }}
                        onDoubleClick={() => hashEditor.editRowByDoubleClick(row)}
                      >
                        {row.text}
                      </pre>
                      {capabilities.hashFieldTtl ? (
                        <span className="pair-ttl">
                          <button
                            className={`ttl-chip mono ${ttlTone(hashEditor.fieldTtls?.[row.field] ?? -1)}`}
                            {...tipProps(`设置 ${row.field} 的过期时间`)}
                            onClick={() =>
                              hashEditor.setTtlField({ field: row.field, ttl: hashEditor.fieldTtls?.[row.field] ?? -1 })
                            }
                          >
                            {hashEditor.loadingTtls ? '…' : formatTtl(hashEditor.fieldTtls?.[row.field] ?? -1)}
                          </button>
                        </span>
                      ) : null}
                      <span className="pair-ops">
                        <button className="op" {...tipProps('复制字段名与值')} onClick={() => void hashEditor.copyFieldRow(row)}>
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_COPY}
                          </svg>
                        </button>
                        <button className="op" {...tipProps('修改该字段（field / value）')} onClick={() => hashEditor.openFieldEditor(row)}>
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_EDIT}
                          </svg>
                        </button>
                        <button className="op danger" {...tipProps('删除该字段')} onClick={() => void hashEditor.removeField(row.field)}>
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_DELETE}
                          </svg>
                        </button>
                      </span>
                    </div>
                  ))}
                  {/* 底部占位：始终渲染，承接 flex 剩余空间，保证表格底边不悬空 */}
                  <p className="row-tip">
                    <span className="tip-text">
                      {hashEditor.hashView.rows.length
                        ? '双击行可修改字段 · 右键唤出更多操作'
                        : totalCount
                          ? '没有匹配的 field，清除搜索条件可查看全部'
                          : '该 hash 暂无字段，可通过 ⋮ 菜单编辑值来添加'}
                    </span>
                    <span className="readonly-tag" {...tipProps('表格仅作只读展示，修改请通过右键菜单或双击行')}>
                      只读
                    </span>
                  </p>
                </div>
              ) : value.type === 'list' ? (
                <div className="pair-table">
                  <div className="pair-head list-head">
                    <span className="th idx-head">#</span>
                    <button className={`th sortable${sortKey === 'value' ? ' on' : ''}`} onClick={() => toggleSort('value')}>
                      value
                      <SortIcon direction={sortKey === 'value' ? (sortAsc ? 'asc' : 'desc') : null} />
                    </button>
                    <span className="th ops-head">操作</span>
                  </div>
                  {lineView.rows.map((row) => (
                    <div
                      key={row.index}
                      className={`pair-row list-row${selectedListIndex === row.index ? ' selected' : ''}`}
                      onClick={() => setSelectedListIndex((prev) => (prev === row.index ? null : row.index))}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        listEditor.openListMenu(event, row)
                      }}
                      onDoubleClick={() => listEditor.openListEditor(row)}
                    >
                      <span className="pair-idx mono" {...tipProps('列表中的真实位置')}>
                        {row.index + 1}
                      </span>
                      <pre className="pair-value mono">{row.text}</pre>
                      <span className="pair-ops">
                        <button
                          className="op"
                          {...tipProps('复制该项内容')}
                          onClick={(event) => {
                            event.stopPropagation()
                            void listEditor.copyListRow(row)
                          }}
                        >
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_COPY}
                          </svg>
                        </button>
                        <button
                          className="op"
                          {...tipProps('修改该项（双击）')}
                          onClick={(event) => {
                            event.stopPropagation()
                            listEditor.openListEditor(row)
                          }}
                        >
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_EDIT}
                          </svg>
                        </button>
                        <button
                          className="op danger"
                          {...tipProps('删除该项')}
                          onClick={(event) => {
                            event.stopPropagation()
                            void listEditor.removeListElement(row)
                          }}
                        >
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_DELETE}
                          </svg>
                        </button>
                      </span>
                    </div>
                  ))}
                  <p className="row-tip">
                    <span className="tip-text">
                      {lineView.rows.length
                        ? '双击行可修改元素 · 右键唤出更多操作'
                        : totalCount
                          ? '没有匹配的元素，清除搜索条件可查看全部'
                          : '该 list 暂无元素'}
                    </span>
                    <span className="readonly-tag" {...tipProps('表格仅作只读展示，修改请通过右键菜单或双击行')}>
                      只读
                    </span>
                  </p>
                </div>
              ) : value.type === 'set' ? (
                /* set：表格形态，但无序 —— 无排序、无插入，表头仅序号 / member / 操作 */
                <div className="pair-table">
                  <div className="pair-head list-head">
                    <span className="th idx-head">#</span>
                    <span className="th">member</span>
                    <span className="th ops-head">操作</span>
                  </div>
                  {lineView.rows.map((row) => (
                    <div
                      key={row.index}
                      className={`pair-row list-row${selectedListIndex === row.index ? ' selected' : ''}`}
                      onClick={() => setSelectedListIndex((prev) => (prev === row.index ? null : row.index))}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        setEditor.openSetMenu(event, row)
                      }}
                      onDoubleClick={() => setEditor.openSetEditor(row)}
                    >
                      <span className="pair-idx mono" {...tipProps('仅作行计数，不代表存储顺序')}>
                        {row.position}
                      </span>
                      <pre className="pair-value mono">{row.text}</pre>
                      <span className="pair-ops">
                        <button
                          className="op"
                          {...tipProps('复制成员')}
                          onClick={(event) => {
                            event.stopPropagation()
                            void setEditor.copySetMember(row)
                          }}
                        >
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_COPY}
                          </svg>
                        </button>
                        <button
                          className="op"
                          {...tipProps('修改成员（双击）')}
                          onClick={(event) => {
                            event.stopPropagation()
                            setEditor.openSetEditor(row)
                          }}
                        >
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_EDIT}
                          </svg>
                        </button>
                        <button
                          className="op danger"
                          {...tipProps('删除成员')}
                          onClick={(event) => {
                            event.stopPropagation()
                            void setEditor.removeSetMember(row.text)
                          }}
                        >
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_DELETE}
                          </svg>
                        </button>
                      </span>
                    </div>
                  ))}
                  <p className="row-tip">
                    <span className="tip-text">
                      {lineView.rows.length
                        ? '双击行可修改成员 · 右键唤出更多操作 · 集合无序，序号仅作计数'
                        : totalCount
                          ? '没有匹配的成员，清除搜索条件可查看全部'
                          : '该 set 暂无成员'}
                    </span>
                    <span className="readonly-tag" {...tipProps('表格仅作只读展示，修改请通过右键菜单或双击行')}>
                      只读
                    </span>
                  </p>
                </div>
              ) : value.type === 'zset' ? (
                /* zset：表格形态，member / score 两列，序号即当前排名 */
                <div ref={tableRef} className="pair-table" style={colVars as React.CSSProperties}>
                  <div className="pair-head zset-head resizable">
                    <span className="th idx-head">#</span>
                    <div className="th-cell">
                      <button className={`th sortable${sortKey === 'member' ? ' on' : ''}`} onClick={() => toggleSort('member')}>
                        member
                        <SortIcon direction={sortKey === 'member' ? (sortAsc ? 'asc' : 'desc') : null} />
                      </button>
                      {/* 仅 member 列可拖拽；score 列由余量驱动，不提供手柄 */}
                      <span
                        className="col-handle"
                        {...tipProps('拖动调整列宽，双击恢复默认')}
                        onMouseDown={(event) => startColResize(event, 'field')}
                        onDoubleClick={(event) => {
                          event.stopPropagation()
                          resetColWidth('field')
                        }}
                      />
                    </div>
                    <div className="th-cell">
                      <button
                        className={`th sortable score-head${sortKey === 'value' ? ' on' : ''}`}
                        onClick={() => toggleSort('value')}
                      >
                        score
                        <SortIcon direction={sortKey === 'value' ? (sortAsc ? 'asc' : 'desc') : null} />
                      </button>
                    </div>
                    <span className="th ops-head">操作</span>
                  </div>
                  {lineView.rows.map((row) => (
                    <div
                      key={row.index}
                      className={`pair-row zset-row${selectedListIndex === row.index ? ' selected' : ''}`}
                      onClick={() => setSelectedListIndex((prev) => (prev === row.index ? null : row.index))}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        zsetEditor.openZsetMenu(event, row)
                      }}
                      onDoubleClick={() => zsetEditor.openZsetEditor(row)}
                    >
                      <span className="pair-idx mono" {...tipProps('当前排名（按 score 降序）')}>
                        {row.position}
                      </span>
                      <span className="pair-key mono ellipsis" {...tipProps(row.left)}>
                        {row.left}
                      </span>
                      <pre className="pair-value mono score">{row.text}</pre>
                      <span className="pair-ops">
                        <button
                          className="op"
                          {...tipProps('复制成员')}
                          onClick={(event) => {
                            event.stopPropagation()
                            void zsetEditor.copyZsetMember(row)
                          }}
                        >
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_COPY}
                          </svg>
                        </button>
                        <button
                          className="op"
                          {...tipProps('修改成员（双击）')}
                          onClick={(event) => {
                            event.stopPropagation()
                            zsetEditor.openZsetEditor(row)
                          }}
                        >
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_EDIT}
                          </svg>
                        </button>
                        <button
                          className="op danger"
                          {...tipProps('删除成员')}
                          onClick={(event) => {
                            event.stopPropagation()
                            void zsetEditor.removeZsetMember(zsetEditor.zsetMemberOf(row))
                          }}
                        >
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_DELETE}
                          </svg>
                        </button>
                      </span>
                    </div>
                  ))}
                  <p className="row-tip">
                    <span className="tip-text">
                      {lineView.rows.length
                        ? '双击行可修改成员 · 右键唤出更多操作 · 点表头可按 member / score 排序'
                        : totalCount
                          ? '没有匹配的成员，清除搜索条件可查看全部'
                          : '该 zset 暂无成员'}
                    </span>
                    <span className="readonly-tag" {...tipProps('表格仅作只读展示，修改请通过右键菜单或双击行')}>
                      只读
                    </span>
                  </p>
                </div>
              ) : (
                /* stream：表格形态，entry ID / 字段 两列；只读，操作列仅复制与查看 */
                <div className="pair-table" style={colVars as React.CSSProperties}>
                  <div className="pair-head stream-head">
                    <span className="th idx-head">#</span>
                    <button className={`th sortable${sortKey === 'member' ? ' on' : ''}`} onClick={() => toggleSort('member')}>
                      entry ID
                      <SortIcon direction={sortKey === 'member' ? (sortAsc ? 'asc' : 'desc') : null} />
                    </button>
                    <div className="th-cell">
                      <span className="th">字段</span>
                      {/* stream 只读，字段列不提供拖拽 */}
                    </div>
                    <span className="th ops-head">操作</span>
                  </div>
                  {streamEditor.streamView.rows.map((row) => (
                    <div
                      key={row.index}
                      className={`pair-row stream-row${selectedListIndex === row.index ? ' selected' : ''}`}
                      onClick={() => setSelectedListIndex((prev) => (prev === row.index ? null : row.index))}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        streamEditor.openStreamMenu(event, row)
                      }}
                    >
                      <span className="pair-idx mono">{row.index + 1}</span>
                      <span className="pair-key mono ellipsis" {...tipProps(streamEditor.streamIdOf(row))}>
                        {row.left}
                      </span>
                      <pre className="pair-value mono" {...tipProps(row.text)}>
                        {row.text}
                      </pre>
                      <span className="pair-ops">
                        <button
                          className="op"
                          {...tipProps('复制 entry ID')}
                          onClick={(event) => {
                            event.stopPropagation()
                            void streamEditor.copyStreamId(row)
                          }}
                        >
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_COPY}
                          </svg>
                        </button>
                        <button
                          className="op"
                          {...tipProps('复制字段内容')}
                          onClick={(event) => {
                            event.stopPropagation()
                            void streamEditor.copyStreamFields(row)
                          }}
                        >
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_TEXT}
                          </svg>
                        </button>
                        <button
                          className="op"
                          {...tipProps('查看完整内容')}
                          onClick={(event) => {
                            event.stopPropagation()
                            streamEditor.openStreamViewer(row)
                          }}
                        >
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_EYE}
                          </svg>
                        </button>
                      </span>
                    </div>
                  ))}
                  <div className="row-tip">
                    <span className="tip-text">
                      {streamEditor.streamView.rows.length
                        ? 'stream 为只读日志 · 右键唤出更多操作'
                        : totalCount
                          ? '没有匹配的 entry，清除搜索条件可查看全部'
                          : '该 stream 暂无 entry'}
                    </span>
                    <span className="readonly-tag" {...tipProps('stream 为追加写日志，不支持修改历史 entry')}>
                      只读
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* 刷新当前键：值区居中 loading，不改动内部布局 */}
            {refreshingValue ? (
              <div className="value-refreshing">
                <span className="spinner" />
                <span className="refresh-text">正在刷新…</span>
              </div>
            ) : null}
          </div>

          <footer className="viewer-foot">
            <span className="mono">{value.type}</span>

            {value.type === 'string' ? (
              <>
                <span className="sep">·</span>
                <span className="mono stat-item">字符 {stringEditor.stringStats.chars}</span>
                <span className="sep">·</span>
                <span className="mono stat-item">{stringEditor.stringStats.lines} 行</span>
                <span className="sep">·</span>
                <span className="mono stat-item" {...tipProps('原始值的字节大小（同 Redis STRLEN 语义）')}>
                  {formatBytes(stringEditor.stringStats.bytes)}
                </span>
                <span className="sep">·</span>
                <span className="mono stat-item" {...tipProps('当前显示文本中最长的一行（含行号）')}>
                  最长行 <b>{stringEditor.stringStats.longest}</b>
                </span>
                {stringEditor.stringView.jsonOk ? (
                  <span className="stat-item version-note" {...tipProps('内容为合法 JSON，可用操作栏「JSON 美化」缩进重排')}>
                    JSON 格式
                  </span>
                ) : null}
              </>
            ) : value.type === 'hash' ? (
              <>
                <span className="sep">·</span>
                <span className="mono stat-item">字段 {hashEditor.hashStats.total}</span>
                {keyword ? <span className="mono stat-item filtered">匹配 {hashEditor.hashView.rows.length}</span> : null}
                <span className="sep">·</span>
                <span className="mono stat-item">{formatBytes(hashEditor.hashStats.bytes)}</span>
                <span className="sep">·</span>
                <span className="mono stat-item">
                  最大字段 <b>{hashEditor.hashStats.largest}</b>
                </span>
                {sortKey ? (
                  <span className="mono stat-item">
                    排序：{sortKey === 'field' ? 'field' : 'value'} {sortAsc ? '升序' : '降序'}
                  </span>
                ) : null}
                {!capabilities.hashFieldTtl ? (
                  <span className="stat-item version-note">
                    字段级 TTL 需 Redis 7.4+（当前 {capabilities.version?.raw ?? '版本未知'}）
                  </span>
                ) : null}
                {hashEditor.selectedField ? (
                  <span className="mono stat-item selected-note">
                    已选中 <b>{hashEditor.selectedField}</b>
                  </span>
                ) : null}
              </>
            ) : value.type === 'list' ? (
              <>
                <span className="sep">·</span>
                <span className="mono stat-item">元素 {listStats.total}</span>
                {keyword ? <span className="mono stat-item filtered">匹配 {lineView.rows.length}</span> : null}
                <span className="sep">·</span>
                <span className="mono stat-item">{formatBytes(listStats.bytes)}</span>
                <span className="sep">·</span>
                <span className="mono stat-item">
                  最长 <b>{listStats.largest}</b>
                </span>
                {sortKey === 'value' ? (
                  <span className="mono stat-item">排序：value {sortAsc ? '升序' : '降序'}</span>
                ) : null}
                {selectedListIndex !== null ? (
                  <span className="mono stat-item selected-note">
                    已选中 <b>#{selectedListIndex + 1}</b>
                  </span>
                ) : null}
              </>
            ) : value.type === 'set' ? (
              <>
                <span className="sep">·</span>
                <span className="mono stat-item">成员 {setEditor.setStats.total}</span>
                {keyword ? <span className="mono stat-item filtered">匹配 {lineView.rows.length}</span> : null}
                <span className="sep">·</span>
                <span className="mono stat-item">{formatBytes(setEditor.setStats.bytes)}</span>
                <span className="sep">·</span>
                <span className="mono stat-item">
                  最长 <b>{setEditor.setStats.longest}</b>
                </span>
                <span className="stat-item version-note">无序集合，序号仅作计数</span>
              </>
            ) : value.type === 'zset' ? (
              <>
                <span className="sep">·</span>
                <span className="mono stat-item">成员 {zsetEditor.zsetStats.total}</span>
                {keyword ? <span className="mono stat-item filtered">匹配 {lineView.rows.length}</span> : null}
                <span className="sep">·</span>
                <span className="mono stat-item">{formatBytes(zsetEditor.zsetStats.bytes)}</span>
                <span className="sep">·</span>
                <span className="mono stat-item">
                  score <b>{zsetEditor.zsetStats.min}</b> ~ <b>{zsetEditor.zsetStats.max}</b>
                </span>
                <span className="mono stat-item">
                  排序：
                  {sortKey === 'member'
                    ? `member ${sortAsc ? '升序' : '降序'}`
                    : `score ${sortKey === 'value' && sortAsc ? '升序' : '降序'}`}
                </span>
              </>
            ) : (
              <>
                <span className="sep">·</span>
                <span className="mono stat-item">entry {streamEditor.streamStats.total}</span>
                {keyword ? <span className="mono stat-item filtered">匹配 {streamEditor.streamStats.matched}</span> : null}
                <span className="sep">·</span>
                <span className="mono stat-item">{formatBytes(streamEditor.streamStats.bytes)}</span>
                {streamEditor.streamStats.firstId ? (
                  <>
                    <span className="sep">·</span>
                    <span
                      className="mono stat-item"
                      {...tipProps(`首个 ${streamEditor.streamStats.firstId}，末个 ${streamEditor.streamStats.lastId}`)}
                    >
                      ID <b>{streamEditor.shortEntryId(streamEditor.streamStats.firstId)}</b> ~{' '}
                      <b>{streamEditor.shortEntryId(streamEditor.streamStats.lastId)}</b>
                    </span>
                  </>
                ) : null}
                {sortKey === 'member' ? (
                  <span className="mono stat-item">排序：entry ID {sortAsc ? '升序' : '降序'}</span>
                ) : null}
              </>
            )}

            <span className="spacer" />
            {searchable ? (
              <span className="mono">
                {matchedCount} / {totalCount} 项
              </span>
            ) : value.type === 'string' && keyword ? (
              <span className="mono stat-item filtered">
                匹配 {stringEditor.stringFilteredLines.length} / {stringEditor.stringStats.lines} 行
              </span>
            ) : value.type === 'string' ? (
              <span className="mono">STRLEN {value.length ?? 0} 字节</span>
            ) : (
              <span className="mono">{value.length ?? 0} 字符</span>
            )}
          </footer>
        </>
      ) : activeConnection ? (
        /*
          未选中键时展示服务端概览：连接成功后这块区域最容易"空着"，
          给出身份与负载信息比一句占位文案更有用。
        */
        <ServerOverview />
      ) : (
        <div className="blank">
          <div className="blank-inner">
            <span className="blank-badge">RedisDocter</span>
            <p>从中间列表选择一个键，查看其内容</p>
            <p className="blank-hint">支持 string / hash / list / set / zset / stream 六种类型的浏览</p>
          </div>
        </div>
      )}
      {/* ---------------- 行右键菜单（Teleport 到 body，五套按类型共用 RowMenuMask） ---------------- */}
      {hashEditor.rowMenu ? (
        <RowMenuMask onClose={hashEditor.closeRowMenu}>
          <div
            className="row-menu s-value-viewer"
            style={{ top: `${hashEditor.rowMenu.top}px`, left: `${hashEditor.rowMenu.left}px` }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="rm-head mono ellipsis" {...tipProps(hashEditor.rowMenu.row.field)}>
              {hashEditor.rowMenu.row.field}
            </div>

            {/* 分组一：复制字段本身 */}
            <div className="rm-group">字段</div>
            <button className="rm-item" onClick={() => hashEditor.runRowMenuAction((row) => void hashEditor.copyFieldName(row.field))}>
              <DialogIcon name="copy" size={13} className="rm-icon" />
              <span>复制字段名</span>
            </button>
            <button className="rm-item" onClick={() => hashEditor.runRowMenuAction(hashEditor.copyFieldValue)}>
              <DialogIcon name="copy" size={13} className="rm-icon" />
              <span>复制字段值</span>
            </button>
            <button className="rm-item" onClick={() => hashEditor.runRowMenuAction(hashEditor.copyFieldRow)}>
              <DialogIcon name="copy" size={13} className="rm-icon" />
              <span>复制名称与值</span>
            </button>

            {/* 分组二：复制为可直接执行的命令 / 结构 */}
            <div className="rm-group">其他格式</div>
            <button className="rm-item" onClick={() => hashEditor.runRowMenuAction(hashEditor.copyAsCommand)}>
              <DialogIcon name="terminal" size={13} className="rm-icon" />
              <span>复制为 HSET 命令</span>
            </button>
            <button className="rm-item" onClick={() => hashEditor.runRowMenuAction(hashEditor.copyAsJsonEntry)}>
              <DialogIcon name="document" size={13} className="rm-icon" />
              <span>复制为 JSON 键值对</span>
            </button>
          </div>
        </RowMenuMask>
      ) : null}

      {listEditor.listMenu ? (
        <RowMenuMask onClose={listEditor.closeListMenu}>
          <div
            className="row-menu s-value-viewer"
            style={{ top: `${listEditor.listMenu.top}px`, left: `${listEditor.listMenu.left}px` }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="rm-head mono">第 {listEditor.listMenu.row.index + 1} 项</div>

            <div className="rm-group">复制</div>
            <button className="rm-item" onClick={() => listEditor.runListMenuAction(listEditor.copyListRow)}>
              <DialogIcon name="copy" size={13} className="rm-icon" />
              <span>复制字段值</span>
            </button>
            <button className="rm-item" onClick={() => listEditor.runListMenuAction(listEditor.copyListAsCommand)}>
              <DialogIcon name="terminal" size={13} className="rm-icon" />
              <span>复制为 LSET 命令</span>
            </button>
            <button className="rm-item" onClick={() => listEditor.runListMenuAction(listEditor.copyListAsJson)}>
              <DialogIcon name="document" size={13} className="rm-icon" />
              <span>复制为 JSON</span>
            </button>

            <div className="rm-group">位置</div>
            <button
              className="rm-item"
              onClick={() => listEditor.runListMenuAction((row) => listEditor.openInsertDialog(row, 'before'))}
            >
              <DialogIcon name="arrow-up" size={13} className="rm-icon" />
              <span>在此项前插入</span>
            </button>
            <button
              className="rm-item"
              onClick={() => listEditor.runListMenuAction((row) => listEditor.openInsertDialog(row, 'after'))}
            >
              <DialogIcon name="arrow-down" size={13} className="rm-icon" />
              <span>在此项后插入</span>
            </button>
          </div>
        </RowMenuMask>
      ) : null}

      {setEditor.setMenu ? (
        <RowMenuMask onClose={setEditor.closeSetMenu}>
          <div
            className="row-menu s-value-viewer"
            style={{ top: `${setEditor.setMenu.top}px`, left: `${setEditor.setMenu.left}px` }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="rm-head mono ellipsis" {...tipProps(setEditor.setMenu.row.text)}>
              {setEditor.setMenu.row.text}
            </div>

            <div className="rm-group">复制</div>
            <button className="rm-item" onClick={() => setEditor.runSetMenuAction(setEditor.copySetMember)}>
              <DialogIcon name="copy" size={13} className="rm-icon" />
              <span>复制成员内容</span>
            </button>
            <button className="rm-item" onClick={() => setEditor.runSetMenuAction(setEditor.copySetAsCommand)}>
              <DialogIcon name="terminal" size={13} className="rm-icon" />
              <span>复制为 SADD 命令</span>
            </button>
            <button className="rm-item" onClick={() => setEditor.runSetMenuAction(setEditor.copySetAsJson)}>
              <DialogIcon name="document" size={13} className="rm-icon" />
              <span>复制为 JSON</span>
            </button>
          </div>
        </RowMenuMask>
      ) : null}

      {zsetEditor.zsetMenu ? (
        <RowMenuMask onClose={zsetEditor.closeZsetMenu}>
          <div
            className="row-menu s-value-viewer"
            style={{ top: `${zsetEditor.zsetMenu.top}px`, left: `${zsetEditor.zsetMenu.left}px` }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="rm-head mono ellipsis" {...tipProps(zsetEditor.zsetMenu.row.left ?? '')}>
              {zsetEditor.zsetMemberOf(zsetEditor.zsetMenu.row)}
              <span className="rm-score">score {zsetEditor.zsetMenu.row.text}</span>
            </div>

            <div className="rm-group">复制</div>
            <button className="rm-item" onClick={() => zsetEditor.runZsetMenuAction(zsetEditor.copyZsetMember)}>
              <DialogIcon name="copy" size={13} className="rm-icon" />
              <span>复制成员</span>
            </button>
            <button className="rm-item" onClick={() => zsetEditor.runZsetMenuAction(zsetEditor.copyZsetScore)}>
              <DialogIcon name="text" size={13} className="rm-icon" />
              <span>复制 score</span>
            </button>
            <button className="rm-item" onClick={() => zsetEditor.runZsetMenuAction(zsetEditor.copyZsetAsCommand)}>
              <DialogIcon name="terminal" size={13} className="rm-icon" />
              <span>复制为 ZADD 命令</span>
            </button>
          </div>
        </RowMenuMask>
      ) : null}

      {streamEditor.streamMenu ? (
        <RowMenuMask onClose={streamEditor.closeStreamMenu}>
          <div
            className="row-menu s-value-viewer"
            style={{ top: `${streamEditor.streamMenu.top}px`, left: `${streamEditor.streamMenu.left}px` }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="rm-head mono ellipsis" {...tipProps(streamEditor.streamIdOf(streamEditor.streamMenu.row))}>
              {streamEditor.streamIdOf(streamEditor.streamMenu.row)}
            </div>

            {/* 查看排在最前：表格里的字段是截断的，右键的第一诉求通常是看全 */}
            <button className="rm-item" onClick={() => streamEditor.runStreamMenuAction(streamEditor.openStreamViewer)}>
              <DialogIcon name="eye" size={13} className="rm-icon" />
              <span>查看完整内容</span>
            </button>

            <div className="rm-group">复制</div>
            <button className="rm-item" onClick={() => streamEditor.runStreamMenuAction(streamEditor.copyStreamId)}>
              <DialogIcon name="copy" size={13} className="rm-icon" />
              <span>复制 entry ID</span>
            </button>
            <button className="rm-item" onClick={() => streamEditor.runStreamMenuAction(streamEditor.copyStreamFields)}>
              <DialogIcon name="copy" size={13} className="rm-icon" />
              <span>复制字段内容</span>
            </button>

            <div className="rm-group">其他格式</div>
            <button className="rm-item" onClick={() => streamEditor.runStreamMenuAction(streamEditor.copyStreamAsCommand)}>
              <DialogIcon name="terminal" size={13} className="rm-icon" />
              <span>复制为 XADD 命令</span>
            </button>
          </div>
        </RowMenuMask>
      ) : null}

      {/* ---------------- 弹窗 ---------------- */}
      {editVisible && value ? <EditValueDialog initial={value as KeyValue} onClose={() => setEditVisible(false)} /> : null}

      {hashEditor.editingField && value ? (
        <EditHashFieldDialog
          keyName={value.key}
          field={hashEditor.editingField.field}
          value={hashEditor.editingField.value}
          onClose={() => hashEditor.setEditingField(null)}
          onSaved={hashEditor.handleFieldSaved}
        />
      ) : null}

      {/* hash 新增字段弹窗（add 模式：HSET upsert，saved 走同一 handleFieldSaved） */}
      {hashEditor.addingField && value ? (
        <EditHashFieldDialog
          mode="add"
          keyName={value.key}
          onClose={() => hashEditor.setAddingField(false)}
          onSaved={hashEditor.handleFieldSaved}
        />
      ) : null}

      {hashEditor.ttlField && value ? (
        <EditHashFieldTtlDialog
          keyName={value.key}
          field={hashEditor.ttlField.field}
          currentTtl={hashEditor.ttlField.ttl}
          onClose={() => hashEditor.setTtlField(null)}
          onSaved={hashEditor.handleFieldTtlSaved}
        />
      ) : null}

      {/* stream entry 查看弹窗（只读：字段拆成键值对，长值换行不截断） */}
      {streamEditor.viewingStreamEntry && value ? (
        <ViewStreamEntryDialog
          keyName={value.key}
          entryId={streamEditor.viewingStreamEntry.entryId}
          fields={streamEditor.viewingStreamEntry.fields}
          position={streamEditor.viewingStreamEntry.position}
          total={streamEditor.streamStats.total}
          onClose={() => streamEditor.setViewingStreamEntry(null)}
        />
      ) : null}

      {/* stream 追加消息弹窗（XADD：ID 服务端自动生成） */}
      {streamEditor.addingEntry && value ? (
        <StreamAddEntryDialog
          keyName={value.key}
          total={streamEditor.streamStats.total}
          onConfirm={streamEditor.handleStreamAddConfirm}
          onCancel={() => streamEditor.setAddingEntry(false)}
        />
      ) : null}

      {/* zset 成员编辑弹窗（member + score 双字段） */}
      {zsetEditor.editingZset && value ? (
        <EditZsetMemberDialog
          mode="edit"
          keyName={value.key}
          total={zsetEditor.zsetStats.total}
          initialMember={zsetEditor.editingZset.member}
          initialScore={zsetEditor.editingZset.score}
          duplicatedScore
          onConfirm={zsetEditor.handleZsetConfirm}
          onCancel={() => zsetEditor.setEditingZset(null)}
        />
      ) : null}

      {/* zset 新增成员弹窗 */}
      {zsetEditor.addingZset && value ? (
        <EditZsetMemberDialog
          mode="add"
          keyName={value.key}
          total={zsetEditor.zsetStats.total}
          onConfirm={zsetEditor.handleAddZsetConfirm}
          onCancel={() => zsetEditor.setAddingZset(false)}
        />
      ) : null}

      {/* list 元素编辑弹窗（含底部状态栏统计） */}
      {listEditor.editingListIndex && value ? (
        <EditListElementDialog
          mode="edit"
          keyName={value.key}
          index={listEditor.editingListIndex.index}
          total={listStats.total}
          initialValue={listEditor.editingListIndex.value}
          onConfirm={listEditor.handleListEditConfirm}
          onCancel={() => listEditor.setEditingListIndex(null)}
        />
      ) : null}

      {/* list 插入 / 追加元素弹窗（与修改弹窗同形态，仅操作不同） */}
      {listEditor.insertingList && value ? (
        <EditListElementDialog
          mode="insert"
          keyName={value.key}
          index={listEditor.insertingList.index}
          total={listStats.total}
          position={listEditor.insertingList.position}
          appending={listEditor.insertingList.index >= listStats.total}
          onConfirm={listEditor.handleListInsertConfirm}
          onCancel={() => listEditor.setInsertingList(null)}
        />
      ) : null}

      {/* set 成员编辑弹窗（无序集合：称「成员」且不显示位置） */}
      {setEditor.editingSetMember && value ? (
        <EditListElementDialog
          mode="edit"
          keyType="set"
          itemLabel="成员"
          showPosition={false}
          keyName={value.key}
          index={0}
          total={setEditor.setStats.total}
          initialValue={setEditor.editingSetMember.value}
          onConfirm={setEditor.handleSetMemberConfirm}
          onCancel={() => setEditor.setEditingSetMember(null)}
        />
      ) : null}

      {/* set 新增成员弹窗 */}
      {setEditor.addingMember && value ? (
        <EditListElementDialog
          mode="insert"
          keyType="set"
          itemLabel="成员"
          showPosition={false}
          keyName={value.key}
          index={0}
          total={setEditor.setStats.total}
          onConfirm={setEditor.handleAddMemberConfirm}
          onCancel={() => setEditor.setAddingMember(false)}
        />
      ) : null}

      {renameVisible && value ? (
        <PromptDialog
          title="重命名键"
          label="新的键名"
          initialValue={value.key}
          hint="重命名会连同键的 TTL 一起迁移；若目标键已存在会被覆盖。"
          confirmText="重命名"
          onConfirm={(next) => void handleRename(next)}
          onCancel={() => setRenameVisible(false)}
        />
      ) : null}

      {ttlVisible && value ? (
        <PromptDialog
          title="设置 TTL"
          label="存活时间（秒）"
          inputType="number"
          initialValue={value.ttl > 0 ? String(value.ttl) : ''}
          placeholder="留空或 0 表示永久"
          hint="输入 0 或留空即取消过期时间，设为永久键。"
          confirmText="应用"
          presets={TTL_PRESETS}
          onConfirm={(next) => void handleTtl(next)}
          onCancel={() => setTtlVisible(false)}
        />
      ) : null}
    </section>
  )
}


export default ValueViewer
/** 骨架屏：读取中保留尺寸，避免内容出现时的跳变 */
function SkeletonValue() {
  return (
    <>
      {/*
        骨架屏要复用票根外壳，而不是另写一个 .viewer-head。
        实际头部是 75px 的 ticket（存根 + 压痕 + 票面），骨架若是旧的
        10/8px padding 双行头，数据到达的瞬间整块高度会跳一下。
        data-letter 留空：骨架阶段还不知道类型，别印错字母。
      */}
      <header className="viewer-head ticket-head" data-letter="">
        <div className="ticket-stub" aria-hidden="true" />
        <div className="ticket-perf" aria-hidden="true" />

        <div className="ticket-body">
          <div className="key-line">
            <span className="sk sk-title" />
          </div>
          <div className="meta-line">
            <span className="sk sk-meta" />
          </div>
        </div>
      </header>

      <div className="value-toolbar">
        <span className="sk sk-tool" />
        <span className="sk sk-tool" />
        <span className="sk sk-tool" />
      </div>

      <div className="value-body">
        <div className="sk-table">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <span key={n} className="sk sk-row" style={{ animationDelay: `${n * 70}ms` }} />
          ))}
        </div>
      </div>

      <footer className="viewer-foot">
        <span className="sk sk-foot" />
      </footer>
    </>
  )
}

/** 通用搜索框（带清除按钮） */
function FilterBox({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  className?: string
}) {
  return (
    <label className={`search-box${className ? ` ${className}` : ''}`}>
      <svg viewBox="0 0 16 16" className="s-icon" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5 14 14" />
      </svg>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="filter mono"
        placeholder={placeholder}
      />
      {value ? (
        <button className="s-clear" {...tipProps('清除搜索')} onClick={() => onChange('')}>
          <DialogIcon name="cancel" size={10} />
        </button>
      ) : null}
    </label>
  )
}

/** 自动刷新开关（hash / list / set / zset / stream 共用） */
function AutoRefreshSwitch({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className={`switch${value ? ' on' : ''}`} {...tipProps('开启后每 5 秒自动更新列表')}>
      <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
      <span className="track">
        <span className="thumb" />
      </span>
      <span className="switch-label">自动刷新</span>
      {value ? <span className="switch-dot" /> : null}
    </label>
  )
}

/** 行右键菜单的遮罩层：点击空白或再次右键均关闭 */
function RowMenuMask({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return createPortal(
    <div
      className="row-menu-mask s-value-viewer"
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

import { Activity, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '@/api'
import { BulkOpsPanel } from '@/components/BulkOpsPanel'
import { DialogIcon } from '@/components/DialogIcon'
import { VirtualStringLines } from '@/components/VirtualStringLines'
import { VirtualRows } from '@/components/VirtualRows'
import { EditHashFieldDialog } from '@/components/EditHashFieldDialog'
import { EditHashFieldTtlDialog } from '@/components/EditHashFieldTtlDialog'
import { EditListElementDialog } from '@/components/EditListElementDialog'
import { EditValueDialog } from '@/components/EditValueDialog'
import { EditZsetMemberDialog } from '@/components/EditZsetMemberDialog'
import { FilterBox } from '@/components/FilterBox'
import { PromptDialog } from '@/components/PromptDialog'
import { ServerOverview } from '@/components/ServerOverview'
import { MemcachedOverview } from '@/components/MemcachedOverview'
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
import { useI18n } from '@/i18n'
import type { MsgKey } from '@shared/i18n'
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

/** 虚拟滚动的稳定取键函数（模块级：避免每次渲染触发窗口重算） */
const keyByField = (row: { field: string }): string => row.field
const keyByIndex = (row: { index: number }): number => row.index

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
const TTL_PRESETS: Array<{ label: MsgKey; value: string }> = [
  { label: 'common.oneMinute', value: '60' },
  { label: 'common.fiveMinutes', value: '300' },
  { label: 'common.thirtyMinutes', value: '1800' },
  { label: 'common.oneHour', value: '3600' },
  { label: 'common.oneDay', value: '86400' },
  { label: 'common.sevenDays', value: '604800' },
  { label: 'common.noExpiration', value: '0' },
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
 * 书签名渲染：中间省略（保留头尾），省略号单独包一层。
 * Redis 键的唯一性通常落在尾部（租户 / endpoint / 版本号），只截尾部会切掉
 * 区分度最高的那一段；截断标记单独用三个点并着色，一眼能看出名字没显示全。
 */
function tabLabel(
  text: string,
  t: (key: MsgKey) => string,
  head = 12,
  tail = 8,
): React.ReactNode {
  if (text.length <= head + tail + 1) return text
  return (
    <>
      {text.slice(0, head)}
      <span className="vt-ell" aria-label={t('memcachedValueViewer.nameTruncated')}>
        ...
      </span>
      {text.slice(-tail)}
    </>
  )
}

/**
 * 值查看/编辑区（右侧主面板）。
 *
 * 每个打开的书签各自常驻一个 ValueDetailPane，由 <Activity> 控制显隐：
 * 切走的标签只是隐藏，筛选、排序、编辑草稿与滚动位置全部保留。
 * 值按 key 缓存在本层 —— 切回已读过的标签时先用缓存即时呈现，
 * 同时静默重读一次，避免看到过期数据。
 *
 * 结构：
 *   BulkOpsPanel（批量任务进行中独占）→ 各书签面板 → ServerOverview
 *   未选键时展示 ServerOverview（已连接）或占位提示。
 */
export function ValueViewer() {
  const { state, activeConnection, selectKey, markSelected } = useRedis()
  /* 订阅：书签条、键列表与选中值都来自会话 store */
  useObservable(useSessionStore())
  const { t } = useI18n()

  /* ---------------- 底部键书签（方案 05） ----------------
   * 每个连接各自一套书签：切走时把集合存进 tabStoreRef，切回时恢复。
   * 不同连接的键绝不混排 —— 连接之间互不污染。
   */
  const [openTabs, setOpenTabs] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<'detail' | string>('detail')
  const [tabMenuOpen, setTabMenuOpen] = useState(false)
  const [tabQuery, setTabQuery] = useState('')
  const [tabArrows, setTabArrows] = useState({ left: false, right: false })
  const [tabHover, setTabHover] = useState<{
    key: string
    left: number
    top: number
    side: 'above' | 'below'
    caret: number
  } | null>(null)

  /**
   * 各书签最近一次读到的值。
   * 隐藏标签的数据源：保留自己的最后快照，切回时先行呈现。
   */
  const [tabValues, setTabValues] = useState<Record<string, KeyValue>>({})

  const tabStripRef = useRef<HTMLDivElement | null>(null)
  const tabMenuInputRef = useRef<HTMLInputElement | null>(null)
  const tabHoverTimer = useRef<number | null>(null)
  const tabConnRef = useRef<string | null>(state.activeId)
  const tabDbRef = useRef(state.activeDb)
  /** 渲染期快照：连接切换的 effect 里要读上一刻的集合 */
  const tabStateRef = useRef({ open: openTabs, active: activeTab })
  tabStateRef.current = { open: openTabs, active: activeTab }
  const tabStoreRef = useRef<Record<string, { open: string[]; active: string }>>({})

  /** store 读到的最新值写入对应书签的缓存（只接受与选中键同名的结果） */
  useEffect(() => {
    const key = state.selectedKey
    const value = state.selectedValue
    if (!key || !value || value.key !== key) return
    setTabValues((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }))
  }, [state.selectedKey, state.selectedValue])

  /** 连接切换：保存旧连接的书签，恢复新连接的；没有记录则从选中键起步 */
  useEffect(() => {
    const prevId = tabConnRef.current
    const nextId = state.activeId
    if (prevId === nextId) return
    if (prevId) tabStoreRef.current[prevId] = { ...tabStateRef.current }
    tabConnRef.current = nextId
    setTabMenuOpen(false)
    setTabQuery('')
    cancelTabHover()
    /* 旧连接的值快照一律作废：新连接的键可能同名，但内容无关 */
    setTabValues({})
    if (!nextId) {
      setOpenTabs([])
      setActiveTab('detail')
      return
    }
    const saved = tabStoreRef.current[nextId]
    const nextOpen = saved ? saved.open : state.selectedKey ? [state.selectedKey] : []
    const nextActive = saved ? saved.active : state.selectedKey ?? 'detail'
    setOpenTabs(nextOpen)
    setActiveTab(nextActive)
    // 恢复到的键不是当前会话选中项时补一次读取（不同连接各自恢复自己的键）
    if (nextActive !== 'detail' && nextActive !== state.selectedKey) void selectKey(nextActive)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeId])

  /** 切库：同一连接内键集合已变，旧书签与旧快照作废 */
  useEffect(() => {
    if (tabDbRef.current === state.activeDb) return
    tabDbRef.current = state.activeDb
    setOpenTabs([])
    setActiveTab('detail')
    setTabMenuOpen(false)
    setTabValues({})
    const id = state.activeId
    if (id) tabStoreRef.current[id] = { open: [], active: 'detail' }
  }, [state.activeDb, state.activeId])

  /** 外部选键（键列表 / 搜索 / 新建）：打开并激活对应书签 */
  useEffect(() => {
    const key = state.selectedKey
    if (!key) {
      setActiveTab('detail')
      return
    }
    /*
     * 右键只 markSelected、不读取值：此时不抢走当前标签 ——
     * 用户只是看了看菜单，值区不该突然被清空或换成概览。
     * 真正打开（loadingValue 转 true）或已有缓存时再切换。
     */
    if (!state.loadingValue && state.selectedValue?.key !== key && !tabValues[key]) return
    setOpenTabs((prev) => (prev.includes(key) ? prev : [...prev, key]))
    setActiveTab(key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.selectedKey])

  /*
   * 详情页时再次点同一个键：selectedKey 没变，靠 loadingValue 转 true 判断。
   * 静默刷新走 refreshingValue，不会把用户从详情页拽回去。
   */
  useEffect(() => {
    if (!state.loadingValue || !state.selectedKey) return
    const key = state.selectedKey
    setOpenTabs((prev) => (prev.includes(key) ? prev : [...prev, key]))
    setActiveTab(key)
  }, [state.loadingValue, state.selectedKey])

  /** 关闭书签后丢弃它的缓存，避免下次打开看到旧内容 */
  useEffect(() => {
    setTabValues((prev) => {
      const stale = Object.keys(prev).filter((key) => !openTabs.includes(key))
      if (!stale.length) return prev
      const next = { ...prev }
      for (const key of stale) delete next[key]
      return next
    })
  }, [openTabs])

  /** 把当前书签集合写回所属连接，供切走再切回时恢复 */
  useEffect(() => {
    const id = tabConnRef.current
    if (id) tabStoreRef.current[id] = { open: openTabs, active: activeTab }
  }, [openTabs, activeTab])

  useEffect(() => {
    if (tabMenuOpen) tabMenuInputRef.current?.focus()
  }, [tabMenuOpen])

  useEffect(() => {
    if (!tabMenuOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setTabMenuOpen(false)
        setTabQuery('')
        cancelTabHover()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [tabMenuOpen])

  useEffect(
    () => () => {
      if (tabHoverTimer.current) window.clearTimeout(tabHoverTimer.current)
    },
    [],
  )

  /** 页面滚动 / 窗口变化时收起悬停卡，避免卡片悬在旧位置 */
  useEffect(() => {
    const cancel = (): void => cancelTabHover()
    window.addEventListener('scroll', cancel, true)
    window.addEventListener('resize', cancel)
    return () => {
      window.removeEventListener('scroll', cancel, true)
      window.removeEventListener('resize', cancel)
    }
  }, [])

  /** 滚轮 → 横向滚动 + 容器尺寸变化时刷新箭头可用态 */
  useEffect(() => {
    const strip = tabStripRef.current
    if (!strip) return
    const onWheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
      event.preventDefault()
      strip.scrollLeft += event.deltaY
    }
    strip.addEventListener('wheel', onWheel, { passive: false })
    const observer = new ResizeObserver(() => syncTabArrows())
    observer.observe(strip)
    syncTabArrows()
    return () => {
      strip.removeEventListener('wheel', onWheel)
      observer.disconnect()
    }
  }, [activeConnection, openTabs.length])

  /** 激活标签滚进可视区：只动横向，不带动整页滚动 */
  useEffect(() => {
    const strip = tabStripRef.current
    if (!strip) return
    syncTabArrows()
    if (activeTab === 'detail') return
    const target = Array.from(strip.children).find(
      (child) => (child as HTMLElement).dataset.vtab === activeTab,
    ) as HTMLElement | undefined
    if (!target) return
    /*
     * 用视口坐标换算滚动位置：offsetLeft 的参照物是最近的定位祖先
     * （.viewer-tabs，包含「详情」和箭头），直接拿来滚会多滚一截，
     * 把标签开头切掉。
     */
    const rect = target.getBoundingClientRect()
    const stripRect = strip.getBoundingClientRect()
    const left = rect.left - stripRect.left + strip.scrollLeft
    const right = left + rect.width
    if (left < strip.scrollLeft) {
      strip.scrollTo({ left: left - 2, behavior: 'smooth' })
    } else if (right > strip.scrollLeft + strip.clientWidth) {
      strip.scrollTo({ left: right - strip.clientWidth + 2, behavior: 'smooth' })
    }
  }, [activeTab, openTabs])

  function syncTabArrows(): void {
    const strip = tabStripRef.current
    if (!strip) {
      setTabArrows({ left: false, right: false })
      return
    }
    const left = strip.scrollLeft > 1
    const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1
    setTabArrows((prev) => (prev.left === left && prev.right === right ? prev : { left, right }))
  }

  function scrollTabs(direction: -1 | 1): void {
    const strip = tabStripRef.current
    if (!strip) return
    strip.scrollBy({ left: direction * Math.max(88, strip.clientWidth * 0.72), behavior: 'smooth' })
  }

  /** 书签的元信息（类型 / TTL / 内存）：优先取缓存值，其次键列表 */
  function tabMeta(key: string): { key: string; type: KeyValue['type']; ttl: number; size?: number } | null {
    const current = tabValues[key] ?? null
    const item = state.keys.find((entry) => entry.key === key)
    if (item) {
      /* 扫描结果通常不带 size，已打开的那个键可以用值里的真实占用补上 */
      if (item.size == null && current?.size != null) {
        return { key, type: item.type, ttl: item.ttl, size: current.size }
      }
      return item
    }
    if (current) return { key, type: current.type, ttl: current.ttl, size: current.size }
    return null
  }

  /** 切换书签：有缓存先静默重读（内容即时可见），没有则走骨架屏读取 */
  function openTabValue(key: string): void {
    if (state.selectedKey === key) {
      /* 已是选中键却还没有内容（右键选中后切过来）：补一次读取 */
      if (!tabValues[key] && !state.loadingValue) void selectKey(key)
      return
    }
    const cached = tabValues[key]
    /*
     * 按缓存里已加载的条数重读：大 key 翻过几页后切走再切回，
     * 若按默认首页读取，已加载的后续页会凭空消失。
     */
    const loaded = cached
      ? Array.isArray(cached.value)
        ? cached.value.length
        : cached.value
          ? Object.keys(cached.value).length
          : 0
      : 0
    void selectKey(key, cached ? { silent: true, limit: loaded || undefined } : undefined)
  }

  function activateTab(key: string): void {
    cancelTabHover()
    setTabMenuOpen(false)
    setTabQuery('')
    setActiveTab(key)
    openTabValue(key)
  }

  function showDetailTab(): void {
    cancelTabHover()
    setTabMenuOpen(false)
    setTabQuery('')
    setActiveTab('detail')
  }

  /** 关闭书签：关的是当前项就切到邻近项，全关则回详情 */
  function closeTab(key: string): void {
    cancelTabHover()
    const index = openTabs.indexOf(key)
    const next = openTabs[index + 1] ?? openTabs[index - 1] ?? null
    const rest = openTabs.filter((item) => item !== key)
    setOpenTabs(rest)
    if (!rest.length) {
      setTabMenuOpen(false)
      setTabQuery('')
    }
    if (activeTab !== key) return
    if (next && rest.includes(next)) {
      setActiveTab(next)
      openTabValue(next)
    } else {
      setActiveTab('detail')
      markSelected(null)
    }
  }

  /** 更多菜单的批量关闭：详情页时视为“没有当前键”，关闭全部 */
  function runTabBulk(action: 'others' | 'right' | 'all'): void {
    cancelTabHover()
    setTabMenuOpen(false)
    setTabQuery('')
    const index = activeTab === 'detail' ? -1 : openTabs.indexOf(activeTab)
    if (action === 'all' || index < 0) {
      setOpenTabs([])
      setActiveTab('detail')
      markSelected(null)
      return
    }
    if (action === 'others') {
      setOpenTabs([activeTab])
      return
    }
    setOpenTabs(openTabs.slice(0, index + 1))
  }

  function cancelTabHover(): void {
    if (tabHoverTimer.current) {
      window.clearTimeout(tabHoverTimer.current)
      tabHoverTimer.current = null
    }
    setTabHover(null)
  }

  /** 悬停 90ms 后展示统计卡：带卡片尺寸的视口内钳制 */
  function queueTabHover(key: string, el: HTMLElement): void {
    cancelTabHover()
    if (tabMenuOpen) return
    tabHoverTimer.current = window.setTimeout(() => {
      const rect = el.getBoundingClientRect()
      if (!rect.width) return
      const width = 268
      const left = Math.min(
        Math.max(8, rect.left + rect.width / 2 - width / 2),
        window.innerWidth - width - 8,
      )
      const side: 'above' | 'below' = rect.top > 180 ? 'above' : 'below'
      setTabHover({
        key,
        left,
        top: side === 'above' ? rect.top - 8 : rect.bottom + 8,
        side,
        caret: Math.min(Math.max(14, rect.left + rect.width / 2 - left), width - 14),
      })
    }, 90)
  }

  /** 重命名成功：书签、激活项与悬停卡一起迁到新键名 */
  function handleKeyRenamed(from: string, to: string): void {
    setOpenTabs((prev) => Array.from(new Set(prev.map((key) => (key === from ? to : key)))))
    setActiveTab((prev) => (prev === from ? to : prev))
    setTabHover((prev) => (prev?.key === from ? { ...prev, key: to } : prev))
    setTabValues((prev) => {
      if (!(from in prev)) return prev
      const next = { ...prev }
      delete next[from]
      return next
    })
  }

  /*
   * 书签渲染取当前连接的数据。
   * 连接刚切换、effect 尚未跑完的这一帧里 tabConnRef 还是旧 id ——
   * 此时宁可先不显示标签，也绝不把上一个连接的键画到新连接上。
   */
  const tabsReady = tabConnRef.current === state.activeId
  const shownTabs = tabsReady ? openTabs : []
  const shownActive = tabsReady ? activeTab : 'detail'
  const tabKeyword = tabQuery.trim().toLowerCase()
  const visibleTabs = tabKeyword
    ? openTabs.filter((key) => key.toLowerCase().includes(tabKeyword))
    : openTabs
  const bulkActive = !!state.bulkTask && !!state.activeId
  const activeValue = shownActive === 'detail' ? null : tabValues[shownActive] ?? null
  const activeLoading =
    shownActive !== 'detail' && state.loadingValue && state.selectedKey === shownActive
  /*
   * 没有可展示内容时回到概览：详情书签、右键短暂选中（尚未读取）、
   * 或读取失败（无值且不在 loading）都属于这一类。
   */
  const overviewActive =
    !!activeConnection && !bulkActive && (shownActive === 'detail' || (!activeLoading && !activeValue))
  const hoverMeta = tabHover ? tabMeta(tabHover.key) : null
  const hoverValue = tabHover ? tabValues[tabHover.key] ?? null : null

  return (
    <section className="viewer s-value-viewer">
      {/*
        批量操作面板：必须有连接才显示。
        除了 store 在断开时会清理 bulkTask，这里再加一道渲染层的保险 ——
        面板里的「执行 / 取消」都依赖 activeId，无连接时露出来就是个死界面。
      */}
      {bulkActive ? <BulkOpsPanel /> : null}

      {/*
        每个书签一个常驻面板。隐藏的书签不卸载，筛选、排序、列宽、
        滚动位置与编辑草稿都留在各自的实例里。
      */}
      {shownTabs.map((key) => {
        const isActive = !bulkActive && !overviewActive && shownActive === key
        const cached = tabValues[key] ?? null
        const selectedNow = state.selectedKey === key
        return (
          <Activity key={`${state.activeId}:${key}`} mode={isActive ? 'visible' : 'hidden'}>
            <ValueDetailPane
              value={cached}
              loading={isActive && !cached && state.loadingValue && selectedNow}
              refreshing={
                isActive && !!cached && selectedNow && (state.refreshingValue || state.loadingValue)
              }
              active={isActive}
              onRenamed={handleKeyRenamed}
            />
          </Activity>
        )
      })}

      {overviewActive ? (
        /* 未选中键 / 「详情」标签：服务端概览。按引擎分流，与原分支一致 */
        activeConnection!.engine === 'memcached' ? (
          <MemcachedOverview />
        ) : (
          <ServerOverview />
        )
      ) : null}

      {!activeConnection && !bulkActive ? (
        <div className="blank">
          <div className="blank-inner">
            <span className="blank-badge">Keyper</span>
            <p>{t('valueViewer.selectKeyMiddleListView')}</p>
            <p className="blank-hint">
              {t('valueViewer.browseAllSixTypes')}
            </p>
          </div>
        </div>
      ) : null}

      {/* ---------------- 底部键书签（方案 05）：固定详情 + 横向书签 + 更多 ---------------- */}
      {activeConnection && !bulkActive ? (
        <div className="viewer-tabs" role="tablist" aria-label={t('memcachedValueViewer.openKeys')}>
          <button
            type="button"
            role="tab"
            aria-selected={shownActive === 'detail'}
            className={`vt-home${shownActive === 'detail' ? ' active' : ''}`}
            onClick={showDetailTab}
            {...tipProps(t('memcachedValueViewer.currentConnectionDetails'))}
          >
            <DialogIcon name="home" size={13} />
            <span>{t('common.details')}</span>
          </button>

          <button
            type="button"
            className="vt-arrow"
            disabled={!tabArrows.left}
            onClick={() => scrollTabs(-1)}
            aria-label={t('common.scrollLeft')}
            {...tipProps(t('common.scrollLeft'))}
          >
            ‹
          </button>

          <div
            className="vt-strip"
            ref={tabStripRef}
            onScroll={syncTabArrows}
            onMouseLeave={cancelTabHover}
          >
            {shownTabs.length === 0 ? (
              <span className="vt-empty">{t('memcachedValueViewer.noKeyOpenSelectOne')}</span>
            ) : (
              shownTabs.map((key) => {
                const meta = tabMeta(key)
                const isActive = shownActive === key
                return (
                  <div
                    key={key}
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={0}
                    data-vtab={key}
                    className={`vt-tab${isActive ? ' active' : ''}`}
                    /* 类型色只在激活顶线与圆点上体现，不给整块标签上色 */
                    style={
                      meta
                        ? ({ '--vt-tc': `var(--badge-${meta.type}-fg)` } as React.CSSProperties)
                        : undefined
                    }
                    onMouseEnter={(event) => queueTabHover(key, event.currentTarget)}
                    onClick={() => activateTab(key)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        activateTab(key)
                      }
                    }}
                    onAuxClick={(event) => {
                      if (event.button === 1) {
                        event.preventDefault()
                        closeTab(key)
                      }
                    }}
                  >
                    <span className={`vt-dot${meta ? '' : ' unknown'}`} />
                    {/* 不加 title / tipProps：书签悬停已有统计卡（含完整键名），
                        再挂一层提示会两个气泡叠在一起 */}
                    <span className="vt-name">
                      {tabLabel(key, t)}
                    </span>
                    <button
                      type="button"
                      className="vt-x"
                      aria-label={t('memcachedValueViewer.closeKey', { key })}
                      {...tipProps(t('common.close'))}
                      onClick={(event) => {
                        event.stopPropagation()
                        closeTab(key)
                      }}
                    >
                      ×
                    </button>
                  </div>
                )
              })
            )}
          </div>

          <button
            type="button"
            className="vt-arrow"
            disabled={!tabArrows.right}
            onClick={() => scrollTabs(1)}
            aria-label={t('common.scrollRight')}
            {...tipProps(t('common.scrollRight'))}
          >
            ›
          </button>

          <button
            type="button"
            className={`vt-more${tabMenuOpen ? ' on' : ''}`}
            disabled={!shownTabs.length}
            onClick={() => {
              cancelTabHover()
              setTabMenuOpen((prev) => !prev)
              setTabQuery('')
            }}
            {...tipProps(t('common.moreActions'))}
          >
            ⋯
          </button>

          {tabMenuOpen && shownTabs.length ? (
            <>
              <div
                className="popover-mask"
                onClick={() => {
                  setTabMenuOpen(false)
                  setTabQuery('')
                }}
              />
              <div className="vt-menu" role="menu">
                <div className="vt-menu-hd">
                  <b className="mono">
                    {tabKeyword ? `${visibleTabs.length} / ${shownTabs.length}` : shownTabs.length}
                  </b>
                  <span>{t('memcachedValueViewer.openKeysCountSuffix')}</span>
                  <button
                    type="button"
                    className="vt-menu-x"
                    aria-label={t('common.close')}
                    {...tipProps(t('memcachedValueViewer.close'))}
                    onClick={() => {
                      setTabMenuOpen(false)
                      setTabQuery('')
                    }}
                  >
                    {/* 内联叉号：DialogIcon 的 close 是「退出」图标，语义不对 */}
                    <svg viewBox="0 0 24 24" width={11} height={11} aria-hidden="true">
                      <path
                        d="m6 6 12 12M18 6 6 18"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2.2}
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>

                <label className="vt-menu-search">
                  <DialogIcon name="search" size={12} />
                  <input
                    ref={tabMenuInputRef}
                    className="mono"
                    value={tabQuery}
                    spellCheck={false}
                    placeholder={t('memcachedValueViewer.searchOpenKeys')}
                    aria-label={t('memcachedValueViewer.searchOpenKeys')}
                    onChange={(event) => setTabQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        const first = visibleTabs[0]
                        if (first) activateTab(first)
                      } else if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        const firstItem = document.querySelector<HTMLElement>('.vt-menu .vt-mi')
                        firstItem?.focus()
                      }
                    }}
                  />
                </label>

                <div className="vt-menu-list">
                  {visibleTabs.length ? (
                    visibleTabs.map((key) => {
                      const meta = tabMeta(key)
                      return (
                        <div
                          key={key}
                          role="menuitem"
                          tabIndex={0}
                          className={`vt-mi${shownActive === key ? ' active' : ''}`}
                          onMouseEnter={cancelTabHover}
                          onClick={() => activateTab(key)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              activateTab(key)
                            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                              event.preventDefault()
                              const items = Array.from(
                                document.querySelectorAll<HTMLElement>('.vt-menu .vt-mi'),
                              )
                              const current = items.indexOf(event.currentTarget)
                              const next = items[current + (event.key === 'ArrowDown' ? 1 : -1)]
                              if (next) next.focus()
                              else if (event.key === 'ArrowUp') tabMenuInputRef.current?.focus()
                            }
                          }}
                        >
                          <span className={`vt-t${meta ? ` type-${meta.type}` : ''}`}>
                            {meta ? meta.type.charAt(0).toUpperCase() : '?'}
                          </span>
                          <span className="vt-mi-k mono" {...tipProps(key)}>
                            {tabLabel(key, t, 20, 10)}
                          </span>
                          <button
                            type="button"
                            className="vt-mi-x"
                            aria-label={t('memcachedValueViewer.closeKey', { key })}
                            {...tipProps(t('common.close'))}
                            onClick={(event) => {
                              event.stopPropagation()
                              closeTab(key)
                            }}
                          >
                            ×
                          </button>
                        </div>
                      )
                    })
                  ) : (
                    <div className="vt-menu-empty">{t('common.noMatchingKeys')}</div>
                  )}
                </div>

                <div className="vt-menu-acts">
                  <button
                    type="button"
                    className="vt-act"
                    disabled={openTabs.length < 2}
                    onClick={() => runTabBulk('others')}
                  >
                    <DialogIcon name="clone" size={11} />
                    <span>{t('memcachedValueViewer.closeOthers')}</span>
                  </button>
                  <button
                    type="button"
                    className="vt-act"
                    disabled={
                      shownActive === 'detail' ||
                      openTabs.indexOf(shownActive) >= openTabs.length - 1
                    }
                    onClick={() => runTabBulk('right')}
                  >
                    <DialogIcon name="expand" size={11} />
                    <span>{t('memcachedValueViewer.closeRight')}</span>
                  </button>
                  <button
                    type="button"
                    className="vt-act danger"
                    onClick={() => runTabBulk('all')}
                  >
                    <DialogIcon name="trash" size={11} />
                    <span>{t('memcachedValueViewer.closeAll')}</span>
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {/*
        书签悬停统计卡：挂到 body，避免被 .value-area 的 overflow 裁掉。
        只读展示，pointer-events: none —— 卡片本身不接事件，鼠标离开标签即消失。
      */}
      {!bulkActive && tabHover && hoverMeta
        ? createPortal(
            <div
              className="vt-pop"
              data-side={tabHover.side}
              role="tooltip"
              style={{
                left: `${tabHover.left}px`,
                top: `${tabHover.top}px`,
                ['--vt-caret' as string]: `${tabHover.caret}px`,
              }}
            >
              <div className="vp-k">
                <span className={`vt-t type-${hoverMeta.type}`}>
                  {hoverMeta.type.charAt(0).toUpperCase()}
                </span>
                <span className="vp-name mono">{tabHover.key}</span>
                <span className="vp-type">{hoverMeta.type}</span>
              </div>

              <div className="vp-row">
                <i>TTL</i>
                <b className={`mono ${ttlTone(hoverMeta.ttl)}`}>
                  {formatTtl(hoverMeta.ttl)}
                  {ttlTone(hoverMeta.ttl) === 'urgent' ? <span className="vp-chip">{t('memcachedValueViewer.expiringSoon')}</span> : null}
                </b>
              </div>

              <div className="vp-row">
                <i>{t('common.memory')}</i>
                <b className="mono">{hoverMeta.size != null ? formatBytes(hoverMeta.size) : '—'}</b>
              </div>

              {hoverValue ? (
                <>
                  <div className="vp-row">
                    <i>{t('valueViewer.encoding')}</i>
                    <b className="mono">{hoverValue.encoding ?? '—'}</b>
                  </div>
                  <div className="vp-row">
                    <i>{t('valueViewer.length')}</i>
                    <b className="mono">
                      {hoverValue.length != null ? hoverValue.length : '—'}
                      {hoverValue.size != null ? ` · ${formatBytes(hoverValue.size)}` : ''}
                    </b>
                  </div>
                </>
              ) : null}

              <div className="vp-hint">{t('memcachedValueViewer.clickSwitchCloseScroll')}</div>
            </div>,
            document.body,
          )
        : null}
    </section>
  )
}

/**
 * 大 key 分页的「加载更多」按钮。
 *
 * 只在 nextCursor 非空（还有未加载元素）时出现；已加载量与总数一起显示，
 * 让用户知道当前看到的只是键的一部分，而不是全部内容。
 */
function LoadMoreButton({
  value,
  loading,
  onLoad,
}: {
  value: KeyValue
  loading: boolean
  onLoad: () => void
}) {
  const { t } = useI18n()
  if (value.nextCursor == null) return null
  const loaded = Array.isArray(value.value) ? value.value.length : value.value ? Object.keys(value.value).length : 0
  const total = value.length ?? loaded
  return (
    <button
      className="btn btn-ghost load-more"
      disabled={loading}
      onClick={onLoad}
      {...tipProps(t('valueViewer.loadMoreHint'))}
    >
      <DialogIcon name="arrow-down" size={12} className={loading ? 'spin' : undefined} />
      {loading ? t('valueViewer.loadingMore') : t('valueViewer.loadMoreCount', { loaded, total })}
    </button>
  )
}

interface ValueDetailPaneProps {
  /** 该标签对应键的值快照（由书签层缓存并传入） */
  value: KeyValue | null
  /** 首次读取该键：展示骨架屏 */
  loading: boolean
  /** 重新读取该键：叠加轻量刷新遮罩 */
  refreshing: boolean
  /** 是否为当前激活标签：portal 浮层只在激活时挂载 */
  active: boolean
  /** 重命名成功：把书签与缓存迁移到新键名 */
  onRenamed: (from: string, to: string) => void
}

/**
 * 单个键标签的内容面板。
 *
 * 每个打开的书签各挂一个实例，外层用 <Activity> 控制显隐：
 * 切走的标签只是隐藏，编辑器草稿、筛选、排序与列宽全部保留，
 * 切回来无需重新挂载。数据由外层缓存传入，刷新走同一个 store。
 */
function ValueDetailPane({ value, loading, refreshing, active, onRenamed }: ValueDetailPaneProps) {
  const {
    state: sessionState,
    activeConnection,
    renameKey,
    setTtl,
    notify,
    refreshSelected,
    loadMoreValue,
  } = useRedis()
  /* 订阅：本标签的会话（或全局）任一写入都重渲染 —— 与 Vue 的响应式粒度一致 */
  useObservable(useSessionStore())
  const { t } = useI18n()

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
  const areaRef = useRef<HTMLDivElement | null>(null)

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
    getValue: () => value,
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
    /*
     * total 用服务端总数而不是已加载条数：分页后界面只持有前几页，
     * 「追加到末尾 / 删除确认里的第 N 项，共 M 项」必须以真实总数为准；
     * loaded 保留本地条数，供复制、字节统计等只针对已加载内容的逻辑使用。
     */
    return {
      total: value?.length ?? items.length,
      loaded: items.length,
      bytes,
      largest: largest > 0 ? `#${largest}` : '-',
    }
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

  /*
   * 切换键时重置过滤词、排序与全部浮层状态，避免上一次的状态影响新键。
   * 必须用 ref 判断「键真的变了」：<Activity> 隐藏会销毁并重建 effect，
   * 若照旧无条件重置，每次切回标签都会把筛选与排序清掉，
   * 那正是保活要避免的。
   */
  const valueKey = value?.key ?? ''
  const lastValueKey = useRef(valueKey)
  useEffect(() => {
    if (lastValueKey.current === valueKey) return
    lastValueKey.current = valueKey
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

  /*
   * 滚动位置记忆。
   * Activity 隐藏时 display:none 会销毁布局盒，浏览器顺手把 scrollTop 归零。
   * 在 scroll 事件里持续记录（只在有高度时记，隐藏瞬间的 0 不会覆盖），
   * 重新激活后再由 layout effect 写回。
   */
  const scrollMemory = useRef(new Map<HTMLElement, { top: number; left: number }>())

  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    const onScroll = (event: Event): void => {
      const el = event.target
      if (!(el instanceof HTMLElement) || el === area || !el.clientHeight) return
      scrollMemory.current.set(el, { top: el.scrollTop, left: el.scrollLeft })
    }
    area.addEventListener('scroll', onScroll, true)
    return () => area.removeEventListener('scroll', onScroll, true)
  }, [valueKey])

  useLayoutEffect(() => {
    if (!active) return
    for (const [el, pos] of scrollMemory.current) {
      if (!el.isConnected) {
        scrollMemory.current.delete(el)
        continue
      }
      if (el.scrollTop !== pos.top) el.scrollTop = pos.top
      if (el.scrollLeft !== pos.left) el.scrollLeft = pos.left
    }
  }, [active])

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
  const autoRefreshing = useRef(false)

  async function tickAutoRefresh(): Promise<void> {
    if (autoRefreshing.current) return
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
    autoRefreshing.current = true
    try {
      // 静默刷新：自动刷新同样不该触发骨架屏，否则每 5 秒整个值区闪一次
      await refreshSelected({ silent: true })
    } finally {
      autoRefreshing.current = false
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
      ? t('valueViewer.searchFieldValue')
      : value?.type === 'zset'
        ? t('valueViewer.searchMemberPlaceholder')
        : value?.type === 'stream'
          ? t('valueViewer.searchIdFieldContent')
          : t('valueViewer.searchElementContent')

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
      notify('err', t('memcachedValueViewer.contentEmpty'))
      return
    }
    const done = await copyText(text)
    notify(
      done ? 'ok' : 'err',
      done ? t('memcachedValueViewer.copied', { count: text.length }) : t('common.copyFailedCheckClipboardPermissions'),
    )
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
      notify('ok', t('common.exportCancelled'))
      return
    }
    notify('ok', t('common.exportedPath', { path: res.data.path ?? t('common.localFile') }))
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
    const from = value!.key
    await renameKey(from, target)
    // 重命名不新增书签：把原书签与缓存原地改名，避免留下旧键名的死标签
    onRenamed(from, target)
  }

  async function handleTtl(next: string): Promise<void> {
    setTtlVisible(false)
    const seconds = Number(next)
    if (Number.isNaN(seconds)) {
      notify('err', t('editHashFieldTtlDialog.ttlNumber'))
      return
    }
    await setTtl(value!.key, seconds)
  }

  return (
    <>
      {value ? (
        <>
          {/* 值区头部 · 报头（design/key-info-20-schemes.html 方案 11） */}
          <header className="viewer-head masthead" data-type={value.type}>
            <span className="mast-eyebrow">
              <span className="mast-pill">{value.type}</span>
            </span>
            <div className="mast-actions">
              <ValueActions onRename={() => setRenameVisible(true)} onSetTtl={() => setTtlVisible(true)} />
            </div>

            <span className="key-name ellipsis" {...tipProps(value.key)}>
              {value.key}
            </span>

            <div className="meta-line">
              <span>
                <em>{t('valueViewer.ttlLabel')}</em>
                <b className="mono">{ttlLabel}</b>
              </span>
              <span>
                <em>{t('valueViewer.encodingLabel')}</em>
                <b className="mono">{value.encoding ?? '-'}</b>
              </span>
              <span>
                <em>{t('memcachedValueViewer.size')}</em>
                <b className="mono">{value.length ?? '-'}</b>
              </span>
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
                <button className="tool" {...tipProps(t('memcachedValueViewer.enterEditMode'))} onClick={stringEditor.enterStringEditExplicit}>
                  <DialogIcon name="edit" size={12} className="ti" />
                  {t('common.edit')}
                </button>
                <button className="tool" {...tipProps(t('memcachedValueViewer.copyAllContent'))} onClick={copyValue}>
                  <DialogIcon name="copy" size={12} className="ti" />
                  {t('common.copy')}
                </button>
                <button
                  className={`tool${pretty ? ' on' : ''}`}
                  {...tipProps(pretty ? t('memcachedValueViewer.jsonFormattingClickViewRaw') : t('memcachedValueViewer.clickReformatJson'))}
                  onClick={() => setPretty((prev) => !prev)}
                >
                  <DialogIcon name="info" size={12} className="ti" />
                  {t('memcachedValueViewer.prettyPrintJson')}
                </button>
                <button
                  className={`tool${wrap ? ' on' : ''}`}
                  {...tipProps(wrap ? t('memcachedValueViewer.wordWrapClickSwitch') : t('memcachedValueViewer.clickRestoreWordWrap'))}
                  onClick={() => setWrap((prev) => !prev)}
                >
                  <DialogIcon name="text" size={12} className="ti" />
                  {t('memcachedValueViewer.wordWrap')}
                </button>
                <button className="tool" {...tipProps(t('memcachedValueViewer.exportLocalFile'))} onClick={exportValue}>
                  <DialogIcon name="export" size={12} className="ti" />
                  {t('valueViewer.export')}
                </button>
                <button className="tool" {...tipProps(t('valueViewer.reloadKey'))} onClick={refreshValue}>
                  <DialogIcon name="refresh" size={12} className="ti" />
                  {t('common.refresh')}
                </button>
              </div>
              <span className="spacer" />
              <FilterBox value={filter} onChange={setFilter} placeholder={t('memcachedValueViewer.searchValueContent')} className="string-filter" />
            </div>
          ) : value.type === 'hash' ? (
            <div className="value-toolbar">
              {/* 操作合成一个分段控件，与 string 类型同一套视觉 */}
              <div className="seg-group">
              <button className="tool" {...tipProps(t('valueViewer.copyAllFieldsJson'))} onClick={hashEditor.copyHashAll}>
                <DialogIcon name="copy" size={12} className="ti" />
                {t('common.copy')}
              </button>
              <button className="tool" {...tipProps(t('valueViewer.exportJsonFile'))} onClick={hashEditor.exportHash}>
                <DialogIcon name="export" size={12} className="ti" />
                {t('valueViewer.export')}
              </button>
              <button
                className="tool"
                {...tipProps(t('valueViewer.addField'))}
                onClick={() => hashEditor.setAddingField(true)}
              >
                <DialogIcon name="add" size={12} className="ti" />
                {t('valueViewer.add')}
              </button>
              <button className="tool" {...tipProps(t('valueViewer.reloadKey'))} onClick={refreshValue}>
                <DialogIcon name="refresh" size={12} className="ti" />
                {t('common.refresh')}
              </button>
              {/* 分隔线：动作按钮与「自动刷新」开关语义不同，用一条竖线分组 */}
              <span className="seg-divider" aria-hidden="true" />
              <AutoRefreshSwitch value={autoRefresh} onChange={setAutoRefresh} />
              </div>

              <span className="spacer" />
              <FilterBox value={filter} onChange={setFilter} placeholder={t('valueViewer.searchFields')} className="field-filter" />
            </div>
          ) : value.type === 'list' ? (
            <div className="value-toolbar">
              {/* 操作合成一个分段控件，与 string 类型同一套视觉 */}
              <div className="seg-group">
              <button className="tool" {...tipProps(t('valueViewer.copyAllElements'))} onClick={listEditor.copyListAll}>
                <DialogIcon name="copy" size={12} className="ti" />
                {t('common.copy')}
              </button>
              <button className="tool" {...tipProps(t('valueViewer.exportTextFile'))} onClick={listEditor.exportList}>
                <DialogIcon name="export" size={12} className="ti" />
                {t('valueViewer.export')}
              </button>
              <button
                className="tool"
                {...tipProps(t('valueViewer.appendElementEnd'))}
                onClick={() => listEditor.openInsertDialog({ index: listStats.total, text: '' }, 'after')}
              >
                <DialogIcon name="add" size={12} className="ti" />
                {t('valueViewer.append')}
              </button>
              <button className="tool" {...tipProps(t('valueViewer.reloadKey'))} onClick={refreshValue}>
                <DialogIcon name="refresh" size={12} className="ti" />
                {t('common.refresh')}
              </button>
              {/* 分隔线：动作按钮与「自动刷新」开关语义不同，用一条竖线分组 */}
              <span className="seg-divider" aria-hidden="true" />
              <AutoRefreshSwitch value={autoRefresh} onChange={setAutoRefresh} />
              </div>

              <span className="spacer" />
              <FilterBox value={filter} onChange={setFilter} placeholder={t('valueViewer.searchElements')} className="list-filter" />
            </div>
          ) : value.type === 'set' ? (
            <div className="value-toolbar">
              {/* 操作合成一个分段控件，与 string 类型同一套视觉 */}
              <div className="seg-group">
              <button className="tool" {...tipProps(t('valueViewer.copyMembers'))} onClick={setEditor.copySetAll}>
                <DialogIcon name="copy" size={12} className="ti" />
                {t('common.copy')}
              </button>
              <button className="tool" {...tipProps(t('valueViewer.exportTextFile'))} onClick={setEditor.exportSet}>
                <DialogIcon name="export" size={12} className="ti" />
                {t('valueViewer.export')}
              </button>
              <button
                className="tool"
                {...tipProps(t('valueViewer.addMemberUnique'))}
                onClick={() => setEditor.setAddingMember(true)}
              >
                <DialogIcon name="add" size={12} className="ti" />
                {t('valueViewer.add')}
              </button>
              <button className="tool" {...tipProps(t('valueViewer.reloadKey'))} onClick={refreshValue}>
                <DialogIcon name="refresh" size={12} className="ti" />
                {t('common.refresh')}
              </button>
              {/* 分隔线：动作按钮与「自动刷新」开关语义不同，用一条竖线分组 */}
              <span className="seg-divider" aria-hidden="true" />
              <AutoRefreshSwitch value={autoRefresh} onChange={setAutoRefresh} />
              </div>

              <span className="spacer" />
              <FilterBox value={filter} onChange={setFilter} placeholder={t('valueViewer.searchMembers')} className="list-filter" />
            </div>
          ) : value.type === 'zset' ? (
            <div className="value-toolbar">
              {/* 操作合成一个分段控件，与 string 类型同一套视觉 */}
              <div className="seg-group">
              <button
                className="tool"
                {...tipProps(t('valueViewer.copyMembersWithScore'))}
                onClick={zsetEditor.copyZsetAll}
              >
                <DialogIcon name="copy" size={12} className="ti" />
                {t('common.copy')}
              </button>
              <button className="tool" {...tipProps(t('valueViewer.exportTextFile'))} onClick={zsetEditor.exportZset}>
                <DialogIcon name="export" size={12} className="ti" />
                {t('valueViewer.export')}
              </button>
              <button
                className="tool"
                {...tipProps(t('valueViewer.addMemberUpdateScore'))}
                onClick={() => zsetEditor.setAddingZset(true)}
              >
                <DialogIcon name="add" size={12} className="ti" />
                {t('valueViewer.add')}
              </button>
              <button className="tool" {...tipProps(t('valueViewer.reloadKey'))} onClick={refreshValue}>
                <DialogIcon name="refresh" size={12} className="ti" />
                {t('common.refresh')}
              </button>
              {/* 分隔线：动作按钮与「自动刷新」开关语义不同，用一条竖线分组 */}
              <span className="seg-divider" aria-hidden="true" />
              <AutoRefreshSwitch value={autoRefresh} onChange={setAutoRefresh} />
              </div>

              <span className="spacer" />
              <FilterBox value={filter} onChange={setFilter} placeholder={t('valueViewer.searchMemberPlaceholder')} className="list-filter" />
            </div>
          ) : value.type === 'stream' ? (
            /* stream 为只读日志：历史 entry 只读，但提供 XADD 追加新消息 */
            <div className="value-toolbar">
              {/* 操作合成一个分段控件，与 string 类型同一套视觉 */}
              <div className="seg-group">
              <button
                className="tool"
                {...tipProps(t('valueViewer.copyAllEntries'))}
                onClick={streamEditor.copyStreamAll}
              >
                <DialogIcon name="copy" size={12} className="ti" />
                {t('common.copy')}
              </button>
              <button className="tool" {...tipProps(t('valueViewer.exportTextFile'))} onClick={streamEditor.exportStream}>
                <DialogIcon name="export" size={12} className="ti" />
                {t('valueViewer.export')}
              </button>
              <button
                className="tool"
                {...tipProps(t('valueViewer.appendMessage'))}
                onClick={() => streamEditor.setAddingEntry(true)}
              >
                <DialogIcon name="add" size={12} className="ti" />
                {t('valueViewer.append')}
              </button>
              <button className="tool" {...tipProps(t('valueViewer.reloadKey'))} onClick={refreshValue}>
                <DialogIcon name="refresh" size={12} className="ti" />
                {t('common.refresh')}
              </button>
              {/* 分隔线：动作按钮与「自动刷新」开关语义不同，用一条竖线分组 */}
              <span className="seg-divider" aria-hidden="true" />
              <AutoRefreshSwitch value={autoRefresh} onChange={setAutoRefresh} />
              </div>

              <span className="spacer" />
              <FilterBox value={filter} onChange={setFilter} placeholder={t('valueViewer.searchEntries')} className="list-filter" />
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
          <div className="value-area" ref={areaRef}>
            <div className="value-body">
              {value.type === 'string' && !keyword && stringEditor.stringEditing ? (
                /* string 行内编辑态：取消/保存按钮置于文本框上方 */
                <div className="text-edit-area">
                  <div className="edit-actions">
                    <span className="edit-hint">{t('memcachedValueViewer.editingEscCancelCtrlEnter')}</span>
                    <span className="spacer" />
                    <button className="tool" disabled={stringEditor.stringSaving} onClick={stringEditor.cancelStringEdit}>
                      <DialogIcon name="cancel" size={12} className="ti" />
                      {t('common.cancel')}
                    </button>
                    <button
                      className="tool primary"
                      disabled={stringEditor.stringSaving}
                      onClick={() => void stringEditor.saveStringEdit()}
                    >
                      <DialogIcon name="save" size={12} className="ti" />
                      {stringEditor.stringSaving ? t('common.saving') : t('common.save')}
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
                    <span className="tip-text">{t('memcachedValueViewer.doubleClickTextEditUse')}</span>
                    <span
                      className="readonly-tag"
                      {...tipProps(t('memcachedValueViewer.valueAreaReadOnlyModify'))}
                    >
                      {t('valueViewer.readOnly')}
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
                  <p className="lines-empty">{t('memcachedValueViewer.noMatchingLinesClearSearch')}</p>
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
                        {...tipProps(t('valueViewer.dragResizeColumnDoubleClick'))}
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
                        {...tipProps(t('valueViewer.dragResizeColumnDoubleClick'))}
                        onMouseDown={(event) => startColResize(event, 'value')}
                        onDoubleClick={(event) => {
                          event.stopPropagation()
                          resetColWidth('value')
                        }}
                      />
                    </div>
                    {/* 字段级 TTL 列仅在服务端支持时渲染（Redis 7.4+） */}
                    {capabilities.hashFieldTtl ? (
                      <span className="th ttl-head" {...tipProps(t('valueViewer.fieldLevelTtl'))}>
                        TTL
                      </span>
                    ) : null}
                    <span className="th ops-head">{t('common.operation')}</span>
                  </div>
                  <VirtualRows
                    rows={hashEditor.hashView.rows}
                    rowKey={keyByField}
                    scrollRef={tableRef}
                    renderRow={(row) => (
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
                            {...tipProps(t('valueViewer.setExpirationForField', { field: row.field }))}
                            onClick={() =>
                              hashEditor.setTtlField({ field: row.field, ttl: hashEditor.fieldTtls?.[row.field] ?? -1 })
                            }
                          >
                            {hashEditor.loadingTtls ? '…' : formatTtl(hashEditor.fieldTtls?.[row.field] ?? -1)}
                          </button>
                        </span>
                      ) : null}
                      <span className="pair-ops">
                        <button className="op" {...tipProps(t('valueViewer.copyFieldNameValue'))} onClick={() => void hashEditor.copyFieldRow(row)}>
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_COPY}
                          </svg>
                        </button>
                        <button className="op" {...tipProps(t('valueViewer.editField'))} onClick={() => hashEditor.openFieldEditor(row)}>
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_EDIT}
                          </svg>
                        </button>
                        <button className="op danger" {...tipProps(t('valueViewer.deleteField'))} onClick={() => void hashEditor.removeField(row.field)}>
                          <svg viewBox="0 0 16 16" className="ico" aria-hidden="true">
                            {ICON_DELETE}
                          </svg>
                        </button>
                      </span>
                    </div>
                    )}
                  />
                  {/* 底部占位：始终渲染，承接 flex 剩余空间，保证表格底边不悬空 */}
                  <p className="row-tip">
                    <span className="tip-text">
                      {hashEditor.hashView.rows.length
                        ? t('valueViewer.doubleClickRowEditField')
                        : totalCount
                          ? t('valueViewer.noMatchingFieldsClearSearch')
                          : t('valueViewer.hashNoFieldsYetUse')}
                    </span>
                    <LoadMoreButton
                      value={value}
                      loading={sessionState.loadingMoreValue}
                      onLoad={() => void loadMoreValue()}
                    />
                    <span className="readonly-tag" {...tipProps(t('valueViewer.tableReadOnlyUseContext'))}>
                      {t('valueViewer.readOnly')}
                    </span>
                  </p>
                </div>
              ) : value.type === 'list' ? (
                <div ref={tableRef} className="pair-table">
                  <div className="pair-head list-head">
                    <span className="th idx-head">#</span>
                    <button className={`th sortable${sortKey === 'value' ? ' on' : ''}`} onClick={() => toggleSort('value')}>
                      value
                      <SortIcon direction={sortKey === 'value' ? (sortAsc ? 'asc' : 'desc') : null} />
                    </button>
                    <span className="th ops-head">{t('common.operation')}</span>
                  </div>
                  <VirtualRows
                    rows={lineView.rows}
                    rowKey={keyByIndex}
                    scrollRef={tableRef}
                    renderRow={(row) => (
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
                      <span className="pair-idx mono" {...tipProps(t('valueViewer.actualPositionList'))}>
                        {row.index + 1}
                      </span>
                      <pre className="pair-value mono">{row.text}</pre>
                      <span className="pair-ops">
                        <button
                          className="op"
                          {...tipProps(t('valueViewer.copyItemsContent'))}
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
                          {...tipProps(t('valueViewer.editItem'))}
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
                          {...tipProps(t('valueViewer.deleteItem'))}
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
                    )}
                  />
                  <p className="row-tip">
                    <span className="tip-text">
                      {lineView.rows.length
                        ? t('valueViewer.doubleClickRowEditElement')
                        : totalCount
                          ? t('valueViewer.noMatchingElementsClearSearch')
                          : t('valueViewer.listNoElementsYet')}
                    </span>
                    <LoadMoreButton
                      value={value}
                      loading={sessionState.loadingMoreValue}
                      onLoad={() => void loadMoreValue()}
                    />
                    <span className="readonly-tag" {...tipProps(t('valueViewer.tableReadOnlyUseContext'))}>
                      {t('valueViewer.readOnly')}
                    </span>
                  </p>
                </div>
              ) : value.type === 'set' ? (
                /* set：表格形态，但无序 —— 无排序、无插入，表头仅序号 / member / 操作 */
                <div ref={tableRef} className="pair-table">
                  <div className="pair-head list-head">
                    <span className="th idx-head">#</span>
                    <span className="th">member</span>
                    <span className="th ops-head">{t('common.operation')}</span>
                  </div>
                  <VirtualRows
                    rows={lineView.rows}
                    rowKey={keyByIndex}
                    scrollRef={tableRef}
                    renderRow={(row) => (
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
                      <span className="pair-idx mono" {...tipProps(t('valueViewer.lineCountOnlyNotStorage'))}>
                        {row.position}
                      </span>
                      <pre className="pair-value mono">{row.text}</pre>
                      <span className="pair-ops">
                        <button
                          className="op"
                          {...tipProps(t('valueViewer.copyMember'))}
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
                          {...tipProps(t('valueViewer.editMember'))}
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
                          {...tipProps(t('common.deleteMember'))}
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
                    )}
                  />
                  <p className="row-tip">
                    <span className="tip-text">
                      {lineView.rows.length
                        ? t('valueViewer.setMemberHint')
                        : totalCount
                          ? t('valueViewer.noMatchingMembersClearSearch')
                          : t('valueViewer.setNoMembersYet')}
                    </span>
                    <LoadMoreButton
                      value={value}
                      loading={sessionState.loadingMoreValue}
                      onLoad={() => void loadMoreValue()}
                    />
                    <span className="readonly-tag" {...tipProps(t('valueViewer.tableReadOnlyUseContext'))}>
                      {t('valueViewer.readOnly')}
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
                        {...tipProps(t('valueViewer.dragResizeColumnDoubleClick'))}
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
                    <span className="th ops-head">{t('common.operation')}</span>
                  </div>
                  <VirtualRows
                    rows={lineView.rows}
                    rowKey={keyByIndex}
                    scrollRef={tableRef}
                    renderRow={(row) => (
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
                      <span className="pair-idx mono" {...tipProps(t('valueViewer.currentRanking'))}>
                        {row.position}
                      </span>
                      <span className="pair-key mono ellipsis" {...tipProps(row.left)}>
                        {row.left}
                      </span>
                      <pre className="pair-value mono score">{row.text}</pre>
                      <span className="pair-ops">
                        <button
                          className="op"
                          {...tipProps(t('valueViewer.copyMember'))}
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
                          {...tipProps(t('valueViewer.editMember'))}
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
                          {...tipProps(t('common.deleteMember'))}
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
                    )}
                  />
                  <p className="row-tip">
                    <span className="tip-text">
                      {lineView.rows.length
                        ? t('valueViewer.memberHintSort')
                        : totalCount
                          ? t('valueViewer.noMatchingMembersClearSearch')
                          : t('valueViewer.zsetNoMembersYet')}
                    </span>
                    <LoadMoreButton
                      value={value}
                      loading={sessionState.loadingMoreValue}
                      onLoad={() => void loadMoreValue()}
                    />
                    <span className="readonly-tag" {...tipProps(t('valueViewer.tableReadOnlyUseContext'))}>
                      {t('valueViewer.readOnly')}
                    </span>
                  </p>
                </div>
              ) : (
                /* stream：表格形态，entry ID / 字段 两列；只读，操作列仅复制与查看 */
                <div ref={tableRef} className="pair-table" style={colVars as React.CSSProperties}>
                  <div className="pair-head stream-head">
                    <span className="th idx-head">#</span>
                    <button className={`th sortable${sortKey === 'member' ? ' on' : ''}`} onClick={() => toggleSort('member')}>
                      entry ID
                      <SortIcon direction={sortKey === 'member' ? (sortAsc ? 'asc' : 'desc') : null} />
                    </button>
                    <div className="th-cell">
                      <span className="th">{t('common.field')}</span>
                      {/* stream 只读，字段列不提供拖拽 */}
                    </div>
                    <span className="th ops-head">{t('common.operation')}</span>
                  </div>
                  <VirtualRows
                    rows={streamEditor.streamView.rows}
                    rowKey={keyByIndex}
                    scrollRef={tableRef}
                    renderRow={(row) => (
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
                          {...tipProps(t('valueViewer.copyEntryId'))}
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
                          {...tipProps(t('valueViewer.copyFieldContent'))}
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
                          {...tipProps(t('valueViewer.viewFullContent'))}
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
                    )}
                  />
                  <div className="row-tip">
                    <span className="tip-text">
                      {streamEditor.streamView.rows.length
                        ? t('valueViewer.streamReadOnlyLogRight')
                        : totalCount
                          ? t('valueViewer.noMatchingEntriesClearSearch')
                          : t('valueViewer.streamNoEntriesYet')}
                    </span>
                    <LoadMoreButton
                      value={value}
                      loading={sessionState.loadingMoreValue}
                      onLoad={() => void loadMoreValue()}
                    />
                    <span className="readonly-tag" {...tipProps(t('valueViewer.streamAppendOnlyLogHistorical'))}>
                      {t('valueViewer.readOnly')}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* 刷新当前键：值区居中 loading，不改动内部布局 */}
            {refreshing ? (
              <div className="value-refreshing">
                <span className="spinner" />
                <span className="refresh-text">{t('memcachedValueViewer.refreshing')}</span>
              </div>
            ) : null}
          </div>

        </>
      ) : loading ? (
        <SkeletonValue />
      ) : (
        <div className="blank">
          <div className="blank-inner">
            <span className="blank-badge">Keyper</span>
            <p>{t('valueViewer.selectKeyMiddleListView')}</p>
            <p className="blank-hint">
              {t('valueViewer.browseAllSixTypes')}
            </p>
          </div>
        </div>
      )}

      {/* ---------------- 行右键菜单（Teleport 到 body，五套按类型共用 RowMenuMask） ---------------- */}
      {/*
        所有 portal 浮层只在激活标签上挂载。
        portal 挂在 body 上，Activity 的 display:none 管不到它们；
        不按 active 门控的话，切走后隐藏标签的菜单 / 弹窗会留在屏幕上。
        这里只卸载浮层本身，浮层的开关状态（如 renameVisible）仍保留，
        切回来时能恢复原样。
      */}
      {active ? (
        <>
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
            <div className="rm-group">{t('common.field')}</div>
            <button className="rm-item" onClick={() => hashEditor.runRowMenuAction((row) => void hashEditor.copyFieldName(row.field))}>
              <DialogIcon name="copy" size={13} className="rm-icon" />
              <span>{t('valueViewer.copyFieldName')}</span>
            </button>
            <button className="rm-item" onClick={() => hashEditor.runRowMenuAction(hashEditor.copyFieldValue)}>
              <DialogIcon name="copy" size={13} className="rm-icon" />
              <span>{t('valueViewer.copyFieldValue')}</span>
            </button>
            <button className="rm-item" onClick={() => hashEditor.runRowMenuAction(hashEditor.copyFieldRow)}>
              <DialogIcon name="copy" size={13} className="rm-icon" />
              <span>{t('valueViewer.copyNameValue')}</span>
            </button>

            {/* 分组二：复制为可直接执行的命令 / 结构 */}
            <div className="rm-group">{t('valueViewer.otherFormats')}</div>
            <button className="rm-item" onClick={() => hashEditor.runRowMenuAction(hashEditor.copyAsCommand)}>
              <DialogIcon name="terminal" size={13} className="rm-icon" />
              <span>{t('valueViewer.copyHsetCommand')}</span>
            </button>
            <button className="rm-item" onClick={() => hashEditor.runRowMenuAction(hashEditor.copyAsJsonEntry)}>
              <DialogIcon name="document" size={13} className="rm-icon" />
              <span>{t('valueViewer.copyJsonKeyValuePairs')}</span>
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
            <div className="rm-head mono">{t('valueViewer.itemIndex', { index: listEditor.listMenu.row.index + 1 })}</div>

            <div className="rm-group">{t('common.copy')}</div>
            <button className="rm-item" onClick={() => listEditor.runListMenuAction(listEditor.copyListRow)}>
              <DialogIcon name="copy" size={13} className="rm-icon" />
              <span>{t('valueViewer.copyFieldValue')}</span>
            </button>
            <button className="rm-item" onClick={() => listEditor.runListMenuAction(listEditor.copyListAsCommand)}>
              <DialogIcon name="terminal" size={13} className="rm-icon" />
              <span>{t('valueViewer.copyLsetCommand')}</span>
            </button>
            <button className="rm-item" onClick={() => listEditor.runListMenuAction(listEditor.copyListAsJson)}>
              <DialogIcon name="document" size={13} className="rm-icon" />
              <span>{t('valueViewer.copyJson')}</span>
            </button>

            <div className="rm-group">{t('valueViewer.position')}</div>
            <button
              className="rm-item"
              onClick={() => listEditor.runListMenuAction((row) => listEditor.openInsertDialog(row, 'before'))}
            >
              <DialogIcon name="arrow-up" size={13} className="rm-icon" />
              <span>{t('valueViewer.insertBeforeItem')}</span>
            </button>
            <button
              className="rm-item"
              onClick={() => listEditor.runListMenuAction((row) => listEditor.openInsertDialog(row, 'after'))}
            >
              <DialogIcon name="arrow-down" size={13} className="rm-icon" />
              <span>{t('valueViewer.insertAfterItem')}</span>
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

            <div className="rm-group">{t('common.copy')}</div>
            <button className="rm-item" onClick={() => setEditor.runSetMenuAction(setEditor.copySetMember)}>
              <DialogIcon name="copy" size={13} className="rm-icon" />
              <span>{t('valueViewer.copyMemberContent')}</span>
            </button>
            <button className="rm-item" onClick={() => setEditor.runSetMenuAction(setEditor.copySetAsCommand)}>
              <DialogIcon name="terminal" size={13} className="rm-icon" />
              <span>{t('valueViewer.copySaddCommand')}</span>
            </button>
            <button className="rm-item" onClick={() => setEditor.runSetMenuAction(setEditor.copySetAsJson)}>
              <DialogIcon name="document" size={13} className="rm-icon" />
              <span>{t('valueViewer.copyJson')}</span>
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

            <div className="rm-group">{t('common.copy')}</div>
            <button className="rm-item" onClick={() => zsetEditor.runZsetMenuAction(zsetEditor.copyZsetMember)}>
              <DialogIcon name="copy" size={13} className="rm-icon" />
              <span>{t('valueViewer.copyMember')}</span>
            </button>
            <button className="rm-item" onClick={() => zsetEditor.runZsetMenuAction(zsetEditor.copyZsetScore)}>
              <DialogIcon name="text" size={13} className="rm-icon" />
              <span>{t('valueViewer.copyScore')}</span>
            </button>
            <button className="rm-item" onClick={() => zsetEditor.runZsetMenuAction(zsetEditor.copyZsetAsCommand)}>
              <DialogIcon name="terminal" size={13} className="rm-icon" />
              <span>{t('valueViewer.copyZaddCommand')}</span>
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
              <span>{t('valueViewer.viewFullContent')}</span>
            </button>

            <div className="rm-group">{t('common.copy')}</div>
            <button className="rm-item" onClick={() => streamEditor.runStreamMenuAction(streamEditor.copyStreamId)}>
              <DialogIcon name="copy" size={13} className="rm-icon" />
              <span>{t('valueViewer.copyEntryId')}</span>
            </button>
            <button className="rm-item" onClick={() => streamEditor.runStreamMenuAction(streamEditor.copyStreamFields)}>
              <DialogIcon name="copy" size={13} className="rm-icon" />
              <span>{t('valueViewer.copyFieldContent')}</span>
            </button>

            <div className="rm-group">{t('valueViewer.otherFormats')}</div>
            <button className="rm-item" onClick={() => streamEditor.runStreamMenuAction(streamEditor.copyStreamAsCommand)}>
              <DialogIcon name="terminal" size={13} className="rm-icon" />
              <span>{t('valueViewer.copyXaddCommand')}</span>
            </button>
          </div>
        </RowMenuMask>
      ) : null}

      {/*

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
          title={t('common.renameKey')}
          label={t('common.newKeyName')}
          initialValue={value.key}
          hint={t('valueViewer.renamingMigratesKeysTtlWell')}
          confirmText={t('common.rename')}
          onConfirm={(next) => void handleRename(next)}
          onCancel={() => setRenameVisible(false)}
        />
      ) : null}

      {ttlVisible && value ? (
        <PromptDialog
          title={t('common.setTtl')}
          label={t('keyBrowser.timeLive')}
          inputType="number"
          initialValue={value.ttl > 0 ? String(value.ttl) : ''}
          placeholder={t('keyBrowser.blank0MeansNoExpiration')}
          hint={t('keyBrowser.enter0LeaveBlankRemove')}
          confirmText={t('keyBrowser.apply')}
          presets={TTL_PRESETS.map((preset) => ({ ...preset, label: t(preset.label) }))}
          onConfirm={(next) => void handleTtl(next)}
          onCancel={() => setTtlVisible(false)}
        />
      ) : null}
        </>
      ) : null}
    </>
  )
}
/** 骨架屏：读取中保留尺寸，避免内容出现时的跳变 */
function SkeletonValue() {
  return (
    <>
      {/* 骨架沿用报头外壳，数据到达时不跳高度 */}
      <header className="viewer-head masthead">
        <span className="mast-eyebrow">
          <span className="mast-pill sk-pill">
            <span className="sk sk-eyebrow" />
          </span>
        </span>
        <span className="key-name">
          <span className="sk sk-title" />
        </span>
        <div className="meta-line">
          <span className="sk sk-meta" />
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
    </>
  )
}

/** 自动刷新开关（hash / list / set / zset / stream 共用） */
function AutoRefreshSwitch({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  const { t } = useI18n()
  return (
    <label className={`switch${value ? ' on' : ''}`} {...tipProps(t('valueViewer.updatesListAutomaticallyEvery5'))}>
      <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
      <span className="track">
        <span className="thumb" />
      </span>
      <span className="switch-label">{t('valueViewer.autoRefresh')}</span>
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

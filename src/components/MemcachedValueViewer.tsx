import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DialogIcon } from '@/components/DialogIcon'
import { FilterBox } from '@/components/FilterBox'
import { MemcachedOverview } from '@/components/MemcachedOverview'
import { PromptDialog } from '@/components/PromptDialog'
import { VirtualStringLines } from '@/components/VirtualStringLines'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
import { api } from '@/api'
import { useRedis } from '@/store/useRedis'
import { useSessionStore } from '@/hooks/useSessionStore'
import { useTabBlur } from '@/hooks/useTabBlur'
import { useObservable } from '@/store/subscription'
import { copyText } from '@/utils/clipboard'
import { emitMcKeysChanged, onMcKeysChanged } from '@/utils/memcachedEvents'
import { formatBytes, formatTtl, prettyJson, ttlTone } from '@/utils/format'
import type { TFunction } from '@shared/i18n'

/**
 * Memcached 单个键的值查看器。
 *
 * Memcached 只有一种值形态：一段不透明字节。因此这里等价于 Redis 的
 * string 分支，并完整复用它的交互外壳与内容组件：
 *   · 票根式头部（存根 + 压痕 + 水印）与右上角 ⋮ 操作菜单；
 *   · 分段式工具栏：编辑 / 复制 / JSON 美化 / 自动换行 / 导出 / 刷新；
 *   · 值内容搜索（按行过滤 + 命中高亮）；
 *   · 逐行行号视图（VirtualStringLines）；
 *   · 双击值区域或点「编辑」进入行内编辑，Esc 取消、Ctrl+Enter 保存；
 *   · 底部提示行与琥珀色「只读」标签；
 *   · 底部键书签（方案 05）：固定详情 + 横向标签 + 更多面板。
 *
 * TTL 只有服务端支持 meta get（Memcached 1.6+）时才拿得到；
 * 拿不到时头部显示「—」，编辑保存会退化为永久键，并在提示文案里说明。
 */

interface LoadedValue {
  key: string
  data: string
  bytes: number
  flags: number
  /** -1 = 永久；undefined = 服务端不支持 meta，无法读取 */
  ttl?: number
}

/** 书签的统计快照：TTL / 大小 / flags 在每次读到值后记下，供悬停卡展示 */
interface McTabStat {
  ttl?: number
  bytes?: number
  flags?: number
}

const MENU_WIDTH = 196

/**
 * 书签名渲染：中间省略（保留头尾），省略号单独包一层。
 * Memcached 键名常用于拼装命名空间 + 业务标识，区分度多在尾部；
 * 截断标记单独用三个点并着色，一眼能看出名字没显示全。
 */
function tabLabel(text: string, t: TFunction, head = 12, tail = 8): React.ReactNode {
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

export function MemcachedValueViewer({ connectionId }: { connectionId: string }) {
  const { t } = useI18n()
  const { state, notify, askConfirm, markSelected } = useRedis()
  /*
   * 必须订阅本会话的 store，不能只靠 useRedis()。
   *
   * useRedis() 返回的 state 是个代理：在标签树外读的是全局 store。
   * 少了这一行订阅，左栏写入 selectedKey 后本组件不会重渲染 ——
   * 表现为"点了键，右边一直是概览"。ValueViewer 用的是同一套模式。
   */
  useObservable(useSessionStore())
  const selectedKey = state.selectedKey

  const [value, setValue] = useState<LoadedValue | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)

  const [wrap, setWrap] = useState(true)
  const [pretty, setPretty] = useState(true)
  const [filter, setFilter] = useState('')

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [renaming, setRenaming] = useState(false)

  /* ---------------- 底部键书签（方案 05） ----------------
   * 每个连接的 Workspace 各自挂载一个本组件，书签因此天然按连接隔离：
   * 切换连接就是切换 Workspace，两个实例的集合不会混排。
   */
  const [openTabs, setOpenTabs] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<'detail' | string>('detail')
  const [tabStats, setTabStats] = useState<Record<string, McTabStat>>({})
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

  const tabStripRef = useRef<HTMLDivElement | null>(null)
  const tabMenuInputRef = useRef<HTMLInputElement | null>(null)
  const tabHoverTimer = useRef<number | null>(null)

  const editRef = useRef<HTMLTextAreaElement | null>(null)
  /** 广播回调里要判断"是否正在编辑"；用 ref 避免每次编辑切换都重订阅事件 */
  const editingRef = useRef(false)
  editingRef.current = editing

  useEffect(() => {
    if (!selectedKey) {
      setValue(null)
      setError(null)
      setEditing(false)
      setDraft('')
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    setFilter('')
    setEditing(false)
    setDraft('')
    /* 切到另一个键时先撤下旧值：否则加载期间头部与内容仍是上一个键，容易误删 */
    setValue((prev) => (prev && prev.key === selectedKey ? prev : null))
    void (async () => {
      try {
        const res = await api.memcached.get(connectionId, selectedKey)
        if (!alive) return
        if (!res.ok) throw new Error(res.error)
        if (!res.data.found) {
          /* 键可能在读列表与点开之间过期了 —— 明确说明，而不是显示空值 */
          setValue(null)
          setError(t('memcachedValueViewer.keyExpiredDeleted'))
          return
        }
        setValue({
          key: selectedKey,
          data: res.data.data,
          bytes: res.data.bytes,
          flags: res.data.flags,
          ttl: res.data.ttl,
        })
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : t('common.loadFailed'))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [connectionId, selectedKey])

  async function readValue(key: string): Promise<void> {
    const res = await api.memcached.get(connectionId, key)
    if (!res.ok) throw new Error(res.error)
    if (!res.data.found) {
      setValue(null)
      setError(t('memcachedValueViewer.keyExpiredDeleted'))
      return
    }
    setError(null)
    setValue({
      key,
      data: res.data.data,
      bytes: res.data.bytes,
      flags: res.data.flags,
      ttl: res.data.ttl,
    })
  }

  /* 左栏覆盖写入同一个键时 selectedKey 不变，值区需要收到广播后自行重读 */
  useEffect(() => {
    if (!selectedKey) return
    return onMcKeysChanged(() => {
      /* 重命名刚把 selectedKey 改到新键：旧闭包不能再读旧键 */
      if (state.selectedKey !== selectedKey || !state.selectedKey) return
      /* 编辑中的草稿优先，不能被后台刷新覆盖 */
      if (editingRef.current) return
      void refreshValue(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, selectedKey])

  async function refreshValue(silent = false): Promise<void> {
    if (!selectedKey) return
    setReloading(true)
    try {
      await readValue(selectedKey)
      if (!silent) notify('ok', t('memcachedValueViewer.refreshed'))
    } catch (err) {
      notify('err', err instanceof Error ? err.message : t('memcachedValueViewer.refreshFailed'))
    } finally {
      setReloading(false)
    }
  }

  /* ---------------------------------------------------------------- 底部键书签 */

  /** 外部选键（左栏 / 搜索 / 新建键）：打开并激活对应书签 */
  useEffect(() => {
    if (!selectedKey) {
      setActiveTab('detail')
      return
    }
    setOpenTabs((prev) => (prev.includes(selectedKey) ? prev : [...prev, selectedKey]))
    setActiveTab(selectedKey)
  }, [selectedKey])

  /** 值读取成功后记下统计快照：书签悬停卡用，切到别的键后仍然保留 */
  useEffect(() => {
    if (!value) return
    setTabStats((prev) => ({
      ...prev,
      [value.key]: { ttl: value.ttl, bytes: value.bytes, flags: value.flags },
    }))
  }, [value])

  /** 标签失焦（切到其它连接标签）：收起悬停卡与「更多」面板，避免浮层残留 */
  useTabBlur(() => {
    cancelTabHover()
    setTabMenuOpen(false)
    setTabQuery('')
  })

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
  }, [connectionId, openTabs.length])

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
     * （.viewer-tabs，包含「详情」和箭头），直接拿来滚会多滚一截。
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

  /** 书签的统计快照：没有读到过值的书签回退为空对象（悬停卡显示 —） */
  function tabStat(key: string): McTabStat {
    return tabStats[key] ?? {}
  }

  function activateTab(key: string): void {
    cancelTabHover()
    setTabMenuOpen(false)
    setTabQuery('')
    setActiveTab(key)
    if (state.selectedKey !== key) markSelected(key)
  }

  function showDetailTab(): void {
    cancelTabHover()
    setTabMenuOpen(false)
    setTabQuery('')
    setActiveTab('detail')
    /*
     * Memcached 左栏用 markSelected（没有 selectKey 的「重复选中可重开」语义），
     * 因此回详情时一并清空选中：再点同一个键才能重新打开它的书签。
     */
    if (state.selectedKey) markSelected(null)
  }

  /** 关闭书签：关的是当前项就切到邻近项，全关则回详情 */
  function closeTab(key: string): void {
    cancelTabHover()
    const index = openTabs.indexOf(key)
    const next = openTabs[index + 1] ?? openTabs[index - 1] ?? null
    const rest = openTabs.filter((item) => item !== key)
    setOpenTabs(rest)
    setTabStats((prev) => {
      if (!(key in prev)) return prev
      const stats = { ...prev }
      delete stats[key]
      return stats
    })
    if (!rest.length) {
      setTabMenuOpen(false)
      setTabQuery('')
    }
    /*
     * 当前查看的就是这个键（activeTab 或 selectedKey 任一命中）才切走。
     * 删除键的场景里两者短暂不一致，不能只看 activeTab。
     */
    if (activeTab !== key && state.selectedKey !== key) return
    if (next && rest.includes(next)) {
      setActiveTab(next)
      markSelected(next)
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
      setTabStats({})
      setActiveTab('detail')
      markSelected(null)
      return
    }
    if (action === 'others') {
      setOpenTabs([activeTab])
      setTabStats((prev) => (prev[activeTab] ? { [activeTab]: prev[activeTab] } : {}))
      return
    }
    const kept = openTabs.slice(0, index + 1)
    setOpenTabs(kept)
    setTabStats((prev) => {
      const stats: Record<string, McTabStat> = {}
      for (const key of kept) if (prev[key]) stats[key] = prev[key]
      return stats
    })
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

  /* ---------------------------------------------------------------- 视图派生 */

  const raw = value?.data ?? ''
  const parsed = useMemo(() => prettyJson(raw), [raw])
  /** JSON 美化只影响展示；不合法 JSON 或关闭时原样显示 */
  const displayText = pretty && parsed.ok ? parsed.text : raw

  const lines = useMemo(
    () => (displayText ? displayText.split('\n').map((text, index) => ({ no: index + 1, text })) : []),
    [displayText],
  )

  const keyword = filter.trim().toLowerCase()
  const filteredLines = useMemo(
    () => (keyword ? lines.filter((line) => line.text.toLowerCase().includes(keyword)) : lines),
    [keyword, lines],
  )

  /** 命中片段拆分：不用 dangerouslySetInnerHTML，避免把值内容当 HTML 注入 */
  function highlightSegments(line: string): React.ReactNode[] {
    if (!keyword) return [line]
    const lower = line.toLowerCase()
    const out: React.ReactNode[] = []
    let from = 0
    let index = lower.indexOf(keyword, from)
    while (index >= 0) {
      if (index > from) out.push(line.slice(from, index))
      out.push(
        <mark key={index} className="hit">
          {line.slice(index, index + keyword.length)}
        </mark>,
      )
      from = index + keyword.length
      index = lower.indexOf(keyword, from)
    }
    if (from < line.length) out.push(line.slice(from))
    return out
  }

  /* ---------------------------------------------------------------- 行内编辑 */

  function enterEdit(): void {
    if (!value) return
    /* 这次点击是拖选文本（复制场景），不要误入编辑态 */
    if (window.getSelection()?.toString()) return
    setFilter('')
    setDraft(displayText)
    setEditing(true)
    requestAnimationFrame(() => editRef.current?.focus())
  }

  function enterEditExplicit(): void {
    /* 双击会默认选中击处单词；清掉选区，避免被拖选守卫误拦 */
    window.getSelection()?.removeAllRanges()
    enterEdit()
  }

  function cancelEdit(): void {
    setEditing(false)
    setDraft('')
  }

  async function saveEdit(): Promise<void> {
    if (!value || saving) return
    if (draft === displayText) {
      cancelEdit()
      return
    }
    setSaving(true)
    try {
      const res = await api.memcached.set(connectionId, value.key, draft, {
        mode: 'set',
        flags: value.flags,
        /* 保留原 TTL；ttl 为 -1 时写入 0（永久）。读不到 TTL 时只能按永久写入 */
        ...(value.ttl !== undefined ? { ttlSeconds: value.ttl } : {}),
      })
      if (!res.ok) throw new Error(res.error)
      if (!res.data.ok) throw new Error(res.data.message ?? t('memcachedKeyDialog.writeFailed'))
      notify('ok', value.ttl === undefined ? t('memcachedValueViewer.saved') : t('common.saved'))
      setEditing(false)
      setDraft('')
      emitMcKeysChanged()
      await refreshValue(true)
    } catch (err) {
      notify('err', err instanceof Error ? err.message : t('common.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  /* ---------------------------------------------------------------- 值操作 */

  async function copyValue(): Promise<void> {
    if (!displayText) {
      notify('err', t('memcachedValueViewer.contentEmpty'))
      return
    }
    const done = await copyText(displayText)
    notify(done ? 'ok' : 'err', done ? t('memcachedValueViewer.copied', { count: displayText.length }) : t('common.copyFailedCheckClipboardPermissions'))
  }

  async function copyKeyName(): Promise<void> {
    if (!value) return
    const done = await copyText(value.key)
    notify(done ? 'ok' : 'err', done ? t('common.copiedKeyName') : t('common.copyFailedCheckClipboardPermissions'))
  }

  async function exportValue(): Promise<void> {
    if (!value) return
    /* 键名可能含 : / * ? 等不适合做文件名的字符，统一替换 */
    const suggested = `${value.key.replace(/[\\/:*?"<>|]/g, '_')}.txt`
    const res = await api.file.saveText({ suggestedName: suggested, content: displayText })
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
   * 删除键。
   *
   * 与 Redis 的 deleteKeys 同一套二次确认：键名 + 过期 + 大小 + flags 的结构化明细，
   * 不可撤销的明确提示，并尊重设置里的「删除键前确认」开关。
   * 删除成功后同步关掉对应书签（有邻近书签就切过去，否则回详情）。
   */
  async function remove(): Promise<void> {
    if (!value) return
    const key = value.key
    const details = [
      { label: t('common.keyName'), value: key, mono: true },
      ...(value.ttl !== undefined
        ? [{ label: t('common.expiration'), value: formatTtl(value.ttl), mono: true, tone: 'muted' as const }]
        : []),
      { label: t('common.size'), value: formatBytes(value.bytes), mono: true, tone: 'muted' as const },
      { label: 'flags', value: String(value.flags), mono: true, tone: 'muted' as const },
    ]
    const ok = await askConfirm({
      title: t('common.deleteKey'),
      message: t('memcachedKeyBrowser.keyRemovedCurrentInstance'),
      details,
      warning: t('common.actionCannotUndoneKeyAll'),
      confirmText: t('common.delete'),
      danger: true,
    })
    if (!ok) return
    const res = await api.memcached.remove(connectionId, key)
    if (res.ok && res.data.ok) {
      notify('ok', res.data.message ?? t('common.deleted'))
      setValue(null)
      /* 先把选中切走再广播：否则本组件的广播回调会去重读刚删掉的键 */
      closeTab(key)
      emitMcKeysChanged()
    } else {
      notify('err', res.ok ? (res.data.message ?? t('common.deleteFailed')) : res.error)
    }
  }

  /**
   * 重命名键。
   *
   * Memcached 没有 RENAME 命令，主进程用「读取 → 写入新键 → 删除旧键」组合实现，
   * 目标键已存在时拒绝，不会静默覆盖。重命名后把选中态切到新键。
   */
  async function handleRename(next: string): Promise<void> {
    setRenaming(false)
    if (!value) return
    const target = next.trim()
    if (!target || target === value.key) return
    const res = await api.memcached.rename(connectionId, value.key, target)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.ok) {
      notify('err', res.data.message ?? t('common.renameFailed'))
      return
    }
    notify('ok', res.data.message ?? t('common.renamed'))
    const from = value.key
    /* 书签原地改名，保留位置与激活态；统计快照跟着迁移 */
    setOpenTabs((prev) => Array.from(new Set(prev.map((key) => (key === from ? target : key)))))
    setTabStats((prev) => {
      const stat = prev[from]
      if (!stat) return prev
      const stats = { ...prev }
      delete stats[from]
      stats[target] = stat
      return stats
    })
    markSelected(target)
    emitMcKeysChanged()
  }

  const tabKeyword = tabQuery.trim().toLowerCase()
  const visibleTabs = tabKeyword
    ? openTabs.filter((key) => key.toLowerCase().includes(tabKeyword))
    : openTabs
  const hoverStat = tabHover ? tabStat(tabHover.key) : null

  /*
   * 底部键书签（方案 05）：固定「详情」+ 左右箭头 + 横向书签 + 更多面板。
   * 与 Redis ValueViewer 同构；Memcached 只有一种值形态，统一用 string 类型色。
   */
  const tabBar = (
    <div
      className="viewer-tabs"
      role="tablist"
      aria-label={t('memcachedValueViewer.openKeys')}
      style={{ ['--vt-tc' as string]: 'var(--badge-string-fg)' }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'detail'}
        className={`vt-home${activeTab === 'detail' ? ' active' : ''}`}
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
        {openTabs.length === 0 ? (
          <span className="vt-empty">{t('memcachedValueViewer.noKeyOpenSelectOne')}</span>
        ) : (
          openTabs.map((key) => {
            const isActive = activeTab === key
            return (
              <div
                key={key}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                data-vtab={key}
                className={`vt-tab${isActive ? ' active' : ''}`}
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
                <span className="vt-dot" />
                {/* 不加 title / tipProps：书签悬停已有统计卡（含完整键名） */}
                <span className="vt-name">
                  {tabLabel(key, t)}
                </span>
                <button
                  type="button"
                  className="vt-x"
                  {...tipProps(t('common.close'))}
                  aria-label={t('memcachedValueViewer.closeKey', { key })}
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
        disabled={!openTabs.length}
        onClick={() => {
          cancelTabHover()
          setTabMenuOpen((prev) => !prev)
          setTabQuery('')
        }}
        {...tipProps(t('common.moreActions'))}
      >
        ⋯
      </button>

      {tabMenuOpen && openTabs.length ? (
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
                {tabKeyword ? `${visibleTabs.length} / ${openTabs.length}` : openTabs.length}
              </b>
              <span>{t('memcachedValueViewer.openKeysCountSuffix')}</span>
              <button
                type="button"
                className="vt-menu-x"
                {...tipProps(t('memcachedValueViewer.close'))}
                aria-label={t('common.close')}
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
                visibleTabs.map((key) => (
                  <div
                    key={key}
                    role="menuitem"
                    tabIndex={0}
                    className={`vt-mi${activeTab === key ? ' active' : ''}`}
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
                    <span className="vt-t type-string">M</span>
                    <span className="vt-mi-k mono" {...tipProps(key)}>
                      {tabLabel(key, t, 20, 10)}
                    </span>
                    <button
                      type="button"
                      className="vt-mi-x"
                      {...tipProps(t('common.close'))}
                      aria-label={t('memcachedValueViewer.closeKey', { key })}
                      onClick={(event) => {
                        event.stopPropagation()
                        closeTab(key)
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))
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
                  activeTab === 'detail' || openTabs.indexOf(activeTab) >= openTabs.length - 1
                }
                onClick={() => runTabBulk('right')}
              >
                <DialogIcon name="expand" size={11} />
                <span>{t('memcachedValueViewer.closeRight')}</span>
              </button>
              <button type="button" className="vt-act danger" onClick={() => runTabBulk('all')}>
                <DialogIcon name="trash" size={11} />
                <span>{t('memcachedValueViewer.closeAll')}</span>
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )

  /*
   * 书签悬停统计卡：挂到 body，避免被 .value-area 的 overflow 裁掉。
   * Memcached 没有 encoding / 元素个数，展示 TTL、大小、flags。
   */
  const tabHoverCard =
    tabHover && hoverStat
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
              <span className="vt-t type-string">M</span>
              <span className="vp-name mono">{tabHover.key}</span>
              <span className="vp-type">memcached</span>
            </div>

            <div className="vp-row">
              <i>TTL</i>
              <b className={`mono ${hoverStat.ttl !== undefined ? ttlTone(hoverStat.ttl) : ''}`}>
                {hoverStat.ttl !== undefined ? formatTtl(hoverStat.ttl) : '—'}
                {hoverStat.ttl !== undefined && ttlTone(hoverStat.ttl) === 'urgent' ? (
                  <span className="vp-chip">{t('memcachedValueViewer.expiringSoon')}</span>
                ) : null}
              </b>
            </div>

            <div className="vp-row">
              <i>{t('common.size')}</i>
              <b className="mono">{hoverStat.bytes != null ? formatBytes(hoverStat.bytes) : '—'}</b>
            </div>

            <div className="vp-row">
              <i>flags</i>
              <b className="mono">{hoverStat.flags != null ? hoverStat.flags : '—'}</b>
            </div>

            <div className="vp-hint">{t('memcachedValueViewer.clickSwitchCloseScroll')}</div>
          </div>,
          document.body,
        )
      : null

  /** 内容与底栏同处一个 section：详情页也保留书签，与 Redis 的结构一致 */
  function renderSection(content: React.ReactNode): React.ReactElement {
    return (
      <section className="viewer s-value-viewer mc-viewer">
        {content}
        {tabBar}
        {tabHoverCard}
      </section>
    )
  }

  /*
   * 未选中键时显示服务端概览，而不是一个空白占位。
   * 与 Redis 的行为一致（ValueViewer 在未选键时挂 ServerOverview）。
   */
  if (!selectedKey) return renderSection(<MemcachedOverview />)

  if (loading && !value) return renderSection(<McSkeleton />)

  if (error) {
    return renderSection(
      <div className="blank">
        <div className="blank-inner">
          <span className="blank-badge">Memcached</span>
          <p>{error}</p>
          <p className="blank-hint">{t('memcachedValueViewer.keyListSampledRefreshCheck')}</p>
        </div>
      </div>,
    )
  }

  if (!value) return null

  return renderSection(
    <>
      {/* 值区头部 · 报头，与 Redis ValueViewer 同构 */}
      <header className="viewer-head masthead" data-type="bytes">
        <span className="mast-eyebrow">bytes</span>
        <div className="mast-actions">
          <McValueActions
            onRename={() => setRenaming(true)}
            onCopyKey={copyKeyName}
            onRefresh={() => void refreshValue()}
            onDelete={remove}
          />
        </div>

        <span className="key-name ellipsis" {...tipProps(value.key)}>
          {value.key}
        </span>

        <div className="meta-line">
          <span {...tipProps(value.ttl === undefined ? t('memcachedValueViewer.serverNotSupportMeta') : t('memcachedValueViewer.remainingTtl'))}>
            <em>TTL：</em>
            <b className="mono">{value.ttl === undefined ? '—' : formatTtl(value.ttl)}</b>
          </span>
          <span>
            <em>{t('memcachedValueViewer.size')}</em>
            <b className="mono">{formatBytes(value.bytes)}</b>
          </span>
          <span>
            <em>flags：</em>
            <b className="mono">{value.flags}</b>
          </span>
        </div>
      </header>

      {!editing ? (
        <div className="value-toolbar">
          <div className="seg-group">
            <button className="tool" {...tipProps(t('memcachedValueViewer.enterEditMode'))} onClick={enterEditExplicit}>
              <DialogIcon name="edit" size={12} className="ti" />
              {t('common.edit')}
            </button>
            <button className="tool" {...tipProps(t('memcachedValueViewer.copyAllContent'))} onClick={() => void copyValue()}>
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
            <button className="tool" {...tipProps(t('memcachedValueViewer.exportLocalFile'))} onClick={() => void exportValue()}>
              <DialogIcon name="export" size={12} className="ti" />
              {t('valueViewer.export')}
            </button>
            <button className="tool" disabled={reloading} {...tipProps(t('valueViewer.reloadKey'))} onClick={() => void refreshValue()}>
              <DialogIcon name="refresh" size={12} className="ti" />
              {t('common.refresh')}
            </button>
          </div>
          <span className="spacer" />
          <FilterBox value={filter} onChange={setFilter} placeholder={t('memcachedValueViewer.searchValueContent')} className="string-filter" />
        </div>
      ) : null}

      <div className="value-area">
        <div className="value-body">
          {editing ? (
            <div className="text-edit-area">
              <div className="edit-actions">
                <span className="edit-hint">
                  {t('memcachedValueViewer.editingEscCancelCtrlEnter')}
                  {value.ttl === undefined ? ` · ${t('memcachedValueViewer.saveWithoutOriginalTtl')}` : ''}
                </span>
                <span className="spacer" />
                <button className="tool" disabled={saving} onClick={cancelEdit}>
                  <DialogIcon name="cancel" size={12} className="ti" />
                  {t('common.cancel')}
                </button>
                <button className="tool primary" disabled={saving} onClick={() => void saveEdit()}>
                  <DialogIcon name="save" size={12} className="ti" />
                  {saving ? t('common.saving') : t('common.save')}
                </button>
              </div>
              <textarea
                ref={editRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="text-edit mono"
                wrap={wrap ? 'soft' : 'off'}
                spellCheck={false}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelEdit()
                  } else if (event.key === 'Enter' && event.ctrlKey) {
                    event.preventDefault()
                    void saveEdit()
                  }
                }}
              />
            </div>
          ) : keyword ? (
            filteredLines.length ? (
              <VirtualStringLines
                lines={filteredLines}
                wrap={wrap}
                renderLine={(line) => highlightSegments(line.text)}
              />
            ) : (
              <p className="lines-empty">{t('memcachedValueViewer.noMatchingLinesClearSearch')}</p>
            )
          ) : (
            <VirtualStringLines lines={lines} wrap={wrap} onDoubleClick={enterEditExplicit} />
          )}

          {/* 搜索态下不显示提示行：与 Redis 一致，且此时双击不会进入编辑 */}
          {!editing && !keyword ? (
            <p className="row-tip text-row-tip">
              <span className="tip-text">{t('memcachedValueViewer.doubleClickTextEditUse')}</span>
              <span
                className="readonly-tag"
                {...tipProps(t('memcachedValueViewer.valueAreaReadOnlyModify'))}
              >
                {t('valueViewer.readOnly')}
              </span>
            </p>
          ) : null}
        </div>

        {/* 刷新当前键：值区居中 loading，不改变内部布局 */}
        {reloading ? (
          <div className="value-refreshing">
            <span className="spinner" />
            <span className="refresh-text">{t('memcachedValueViewer.refreshing')}</span>
          </div>
        ) : null}
      </div>

      {renaming ? (
        <PromptDialog
          title={t('common.renameKey')}
          label={t('common.newKeyName')}
          initialValue={value.key}
          placeholder={t('common.enterNewKeyName')}
          hint={t('memcachedValueViewer.memcachedNoRenameCommand')}
          confirmText={t('common.rename')}
          onConfirm={(next) => void handleRename(next)}
          onCancel={() => setRenaming(false)}
        />
      ) : null}
    </>,
  )
}

/** 骨架屏：读取中保留报头外壳与工具栏尺寸，避免内容出现时整块跳变 */
function McSkeleton() {
  return (
    <>
      <header className="viewer-head masthead">
        <span className="mast-eyebrow">
          <span className="sk sk-eyebrow" />
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

/** 值区右上角「值操作」菜单：重命名 / 复制键名 / 刷新 / 删除键，与 Redis 的 ValueActions 同构 */
function McValueActions({
  onRename,
  onCopyKey,
  onRefresh,
  onDelete,
}: {
  onRename: () => void
  onCopyKey: () => Promise<void>
  onRefresh: () => void
  onDelete: () => Promise<void>
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })

  function toggleOpen(event: React.MouseEvent): void {
    event.stopPropagation()
    if (open) {
      setOpen(false)
      return
    }
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect) {
      /* 与 ValueActions 同一套「先渲染、下一帧按实际高度落位」逻辑 */
      setPosition({
        top: rect.bottom + 4,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
      })
      setOpen(true)
      requestAnimationFrame(() => place(rect))
    } else {
      setOpen(true)
    }
  }

  function place(rect: DOMRect): void {
    const el = menuRef.current
    if (!el) return
    const height = el.offsetHeight
    let top = rect.bottom + 4
    if (top + height > window.innerHeight - 8) top = rect.top - height - 4
    setPosition({
      top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
    })
  }

  async function run(action: () => Promise<void> | void): Promise<void> {
    setOpen(false)
    await action()
  }

  return (
    <div ref={anchorRef} className="value-actions s-value-actions">
      <button className="more-btn" {...tipProps(t('memcachedValueViewer.valueActions'))} onClick={toggleOpen}>
        <DialogIcon name="more" size={15} />
      </button>

      {open
        ? createPortal(
            <>
              <div className="popover-mask" onClick={() => setOpen(false)} />
              <div
                ref={menuRef}
                className="menu"
                style={{ top: `${position.top}px`, left: `${position.left}px`, width: `${MENU_WIDTH}px` }}
              >
                <button className="menu-item" onClick={() => void run(onRename)}>
                  <DialogIcon name="refresh" size={13} className="mi-icon" />
                  <span>{t('memcachedValueViewer.renameKey')}</span>
                </button>

                <div className="menu-sep" />

                <button className="menu-item" onClick={() => void run(onCopyKey)}>
                  <DialogIcon name="copy" size={13} className="mi-icon" />
                  <span>{t('common.copyKeyName')}</span>
                </button>

                <button className="menu-item" onClick={() => void run(onRefresh)}>
                  <DialogIcon name="refresh" size={13} className="mi-icon" />
                  <span>{t('common.refresh')}</span>
                </button>

                <div className="menu-sep" />

                <button className="menu-item danger" onClick={() => void run(onDelete)}>
                  <DialogIcon name="cancel" size={13} className="mi-icon" />
                  <span>{t('common.deleteKey')}</span>
                </button>
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  )
}

export default MemcachedValueViewer

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DialogIcon } from '@/components/DialogIcon'
import { MemcachedKeyDialog } from '@/components/MemcachedKeyDialog'
import { PromptDialog } from '@/components/PromptDialog'
import { SearchFilterBox } from '@/components/SearchFilterBox'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
import { api } from '@/api'
import { globalState } from '@/store/global'
import { useSettings, KEY_BROWSER_MIN_WIDTH } from '@/services/settings'
import { useSettingsHolder } from '@/hooks/useSettingsHolder'
import { useRedis } from '@/store/useRedis'
import { useSessionStore } from '@/hooks/useSessionStore'
import { useObservable } from '@/store/subscription'
import type { ConfirmRequest } from '@/store/session'
import { useTabBlur } from '@/hooks/useTabBlur'
import { copyText } from '@/utils/clipboard'
import { formatBytes, formatTtl, ttlTone } from '@/utils/format'
import { buildKeyTree, collectParents, type KeyTreeNode } from '@/utils/keyTree'
import { emitMcKeysChanged, onMcKeysChanged } from '@/utils/memcachedEvents'
import type { MemcachedKeyList, RedisKeyItem } from '@shared/types'

/**
 * Memcached 的键浏览器（左栏）。
 *
 * 为什么不直接复用 Redis 的 KeyBrowser：
 *   那个组件的骨架建立在 Redis 的概念上 —— 库选择器（db0..db15）、
 *   SCAN 游标、分页加载、六种类型徽标、TTL 列、服务端全库搜索。
 *   Memcached 一个都没有：无库、无游标、无类型。
 *   强行复用会让界面到处出现"点了没反应"的控件。
 *
 * 但**交互形态**必须对齐，用户换个引擎不该重新学一遍：
 *   · 树形 / 平铺切换（按键名分隔符建树，与 Redis 同一种树）
 *   · 目录展开 / 收起（含全部展开、全部收缩）
 *   · 键名搜索：输入即筛 + 幽灵补全 + 搜索历史 + 精确匹配
 *   · 批量勾选与批量删除
 * 这些能力通过共享的 utils/keyTree 与 SearchFilterBox 实现，
 * 不复制逻辑，只在本文件里组装 Memcached 特有的数据来源。
 */

interface McKeyRow {
  key: string
  bytes: number
  expiresAt: number
  slab: number
}

/** 树节点里我们只用 label/path/children/leafCount 与 leaf.key */
type McTreeNode = KeyTreeNode

/** 右键菜单目标：单个键，或一整棵前缀子树 */
type McMenuTarget =
  | { kind: 'key'; key: string; keys: string[] }
  | { kind: 'subtree'; path: string; keys: string[] }

/**
 * 到期时间 → Redis 语义的 TTL：-1 表示永久，否则是剩余秒数。
 * 与 Redis 键栏共用 formatTtl / ttlTone，两边的"永久 / 45s / 2h3m"完全同形。
 */
function ttlOf(row: McKeyRow): number {
  if (!row.expiresAt) return -1
  return Math.max(0, row.expiresAt - Math.floor(Date.now() / 1000))
}

/** 连续加载的上限：与 Redis 键栏一致，避免超大实例把界面拖垮 */
const LOAD_ALL_LIMIT = 5000

/** 把新一页并入已加载列表（按 key 去重，防止快照重建时出现重复行） */
function appendKeys(current: MemcachedKeyList, page: MemcachedKeyList): MemcachedKeyList {
  const seen = new Set(current.items.map((item) => item.key))
  const items = [...current.items]
  for (const item of page.items) {
    if (seen.has(item.key)) continue
    seen.add(item.key)
    items.push(item)
  }
  return { ...page, items }
}

export function MemcachedKeyBrowser() {
  const { t } = useI18n()
  const { state, notify, markSelected, askConfirm } = useRedis()
  useObservable(useSessionStore())
  const id = state.activeId

  /* 工具条上的实例地址：与本栏数据同源，窄宽度下由 CSS 省略 */
  const connection = globalState.connections.find((item) => item.id === id)
  const endpointLabel = connection ? `${connection.host}:${connection.port}` : '—'

  const [keys, setKeys] = useState<MemcachedKeyList | null>(null)
  const [loading, setLoading] = useState(false)
  /** 翻页加载中：与整表刷新分开，底部按钮据此禁用/显示进度 */
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  /** 右键目录「添加新键」时的前缀，打开弹窗后自动填入键名输入框 */
  const [createPrefix, setCreatePrefix] = useState('')

  /*
   * 筛选只由搜索框一个入口驱动（输入即筛，回车重新读取）。
   * 顶部工具条不再提供第二个输入框，避免两个框内容不同步。
   */
  const [filter, setFilter] = useState('')
  const [exact, setExact] = useState(false)

  /** 展开层级状态：与 Redis 版一致，用来高亮 L1/L2/展开/折叠四个按钮 */
  const [expandState, setExpandState] = useState<'none' | 'L1' | 'L2' | 'all' | 'custom'>('none')

  /* 视图与折叠 */
  const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree')
  const [separator, setSeparator] = useState(':')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** 上一棵树里出现过的目录：用来识别翻页后新增的目录（见下方补折 effect） */
  const knownParents = useRef<Set<string>>(new Set())

  /* 批量勾选 */
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  /* 重命名目标：由右键「重命名键」写入，PromptDialog 关闭后置空 */
  const [renameTarget, setRenameTarget] = useState<string | null>(null)

  /* 键右键菜单：与 Redis 键栏同一套菜单骨架 */
  const [keyMenu, setKeyMenu] = useState<{ target: McMenuTarget; top: number; left: number } | null>(
    null,
  )
  const menuRef = useRef<HTMLDivElement | null>(null)

  /*
   * 键栏宽度必须与 Redis 版共用同一个设置值（settings.keyBrowserWidth），
   * 否则拖动分隔条只影响当前引擎，切换连接时宽度会跳变。
   *
   * 用 clamp(下限, 设定值, 52%)：52% 是"左栏不超过半屏"的软上限，
   * 但下限 420px 优先 —— 工具条按钮在这个宽度下才不会被压成两行。
   */
  const { settings } = useSettings()
  useObservable(useSettingsHolder())
  const browserStyle: React.CSSProperties = {
    width: `clamp(${KEY_BROWSER_MIN_WIDTH}px, ${settings.keyBrowserWidth}px, 52%)`,
    flexBasis: `clamp(${KEY_BROWSER_MIN_WIDTH}px, ${settings.keyBrowserWidth}px, 52%)`,
  }

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  /**
   * 读取一页键。
   *
   * limit 直接取全局设置「每页加载键数」（settings.pageSize），
   * 与 Redis 的 SCAN COUNT 同一个来源 —— 两个引擎的分页行为保持一致。
   */
  const fetchPage = useCallback(
    async (connectionId: string, offset: number, refresh: boolean): Promise<MemcachedKeyList> => {
      const res = await api.memcached.keys(connectionId, {
        offset,
        limit: settings.pageSize,
        refresh,
      })
      if (!res.ok) throw new Error(res.error)
      return res.data
    },
    [settings.pageSize],
  )

  /** 重新枚举并回到第一页（refresh=true 让主进程重建快照） */
  const load = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError(null)
    try {
      const data = await fetchPage(id, 0, true)
      if (!aliveRef.current) return
      setKeys(data)
    } catch (err) {
      if (aliveRef.current) {
        setError(err instanceof Error ? err.message : t('读取失败'))
        setKeys(null)
      }
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [id, fetchPage])

  /** 加载下一页（复用主进程缓存的快照，不会重新全量爬取） */
  const loadMore = useCallback(async () => {
    if (!id || !keys?.hasMore || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await fetchPage(id, keys.nextOffset, false)
      if (!aliveRef.current) return
      setKeys((current) => (current ? appendKeys(current, page) : page))
    } catch (err) {
      if (aliveRef.current) {
        notify('err', t('加载更多失败：{error}', { error: err instanceof Error ? err.message : String(err) }))
      }
    } finally {
      if (aliveRef.current) setLoadingMore(false)
    }
  }, [id, keys, loadingMore, fetchPage, notify, t])

  /**
   * 连续翻页直到快照取完。
   * 受 LOAD_ALL_LIMIT 保护：超大实例不会被一次性全量加载拖垮界面，
   * 与 Redis 键栏的「加载全部」同语义、同上限。
   */
  const loadAll = useCallback(async () => {
    if (!id || !keys?.hasMore || loadingMore) return
    setLoadingMore(true)
    try {
      let merged = keys
      let guard = 0
      while (merged.hasMore && merged.items.length < LOAD_ALL_LIMIT && guard < 200) {
        const page = await fetchPage(id, merged.nextOffset, false)
        if (!aliveRef.current) return
        const before = merged.items.length
        merged = appendKeys(merged, page)
        guard++
        /* 快照被并发刷新导致 offset 越界时没有新增：立即停止，避免死循环 */
        if (merged.items.length === before) break
      }
      if (aliveRef.current) setKeys(merged)
    } catch (err) {
      if (aliveRef.current) {
        notify('err', t('加载全部失败：{error}', { error: err instanceof Error ? err.message : String(err) }))
      }
    } finally {
      if (aliveRef.current) setLoadingMore(false)
    }
  }, [id, keys, loadingMore, fetchPage, notify, t])

  /* 切连接时整体重置：不同实例的键、折叠状态、勾选都不能串 */
  useEffect(() => {
    setKeys(null)
    setFilter('')
    setPicked(new Set())
    setSelecting(false)
    setCollapsed(new Set())
    setExpandState('none')
    knownParents.current = new Set()
    setError(null)
    setLoadingMore(false)
    setDialogOpen(false)
    setCreatePrefix('')
    setRenameTarget(null)
    setKeyMenu(null)
  }, [id])

  /*
   * 连接就绪即自动读取第一页键。
   * 原来的空列表会让用户以为"实例里没有数据"，还得自己找到刷新按钮；
   * 读取是只读操作，进来自动跑一次才符合"打开就能看到东西"的预期。
   */
  useEffect(() => {
    if (id) void load()
  }, [id, load])

  /* 值区 / 概览里删除了键：左栏列表需要跟着刷新，否则会继续显示已删除的键 */
  useEffect(() => {
    if (!id) return
    return onMcKeysChanged(() => void load())
  }, [id, load])

  /* ---------------------------------------------------------------- 筛选 */

  /**
   * 筛选后的行。
   * 模糊：子串、不区分大小写；精确：键名全等、区分大小写。
   * 两者都只作用于**已加载的键**：未翻页加载到的键不在筛选范围内。
   */
  const rows: McKeyRow[] = useMemo(() => {
    const list = keys?.items ?? []
    const kw = filter.trim()
    const filtered = !kw
      ? list
      : exact
        ? list.filter((item) => item.key === kw)
        : list.filter((item) => item.key.toLowerCase().includes(kw.toLowerCase()))
    return [...filtered].sort((a, b) => a.key.localeCompare(b.key))
  }, [keys, filter, exact])

  /**
   * 树形数据。
   *
   * 复用 buildKeyTree —— 它只读 `key` 字段，与 Redis 版共用同一套建树规则，
   * 因此同一个键名在两个引擎里的层级结构完全一致（用户的肌肉记忆不变）。
   * type/ttl 填空值：Memcached 没有类型，树节点也不显示 TTL。
   */
  const tree = useMemo<McTreeNode[]>(() => {
    const items: RedisKeyItem[] = rows.map((row) => ({
      key: row.key,
      type: 'string',
      ttl: ttlOf(row),
    }))
    return buildKeyTree(items, separator)
  }, [rows, separator])

  /* 统计可折叠的目录：用于"全部展开/收缩"按钮的可用性判断 */
  const allPaths = useMemo(() => collectParents(tree), [tree])

  /**
   * 默认全部折叠，新目录跟随当前档位。
   *
   * 与 Redis 版同一套规则：expandState 初始为 'none'，
   * 键数据首次到位时整棵树都是"新目录"，因此默认全部折叠 ——
   * 加载回来的键动辄上千条，全部展开会让首屏变成一堵墙。
   * 用户手动展开后进入 'custom'，此后的刷新不再改动他的展开结果；
   * 「全部展开 / L1 / L2 / 全部折叠」档位下，新加载的目录按档位补折。
   */
  useEffect(() => {
    const all = collectParents(tree)
    const prev = knownParents.current
    knownParents.current = new Set(all)
    if (expandState === 'custom' || expandState === 'all') return
    const fresh = all.filter((path) => !prev.has(path))
    if (!fresh.length) return
    /* 目录深度 = 分隔符段数：none 全折；L1 保留第 1 层；L2 保留前两层 */
    const minDepth = expandState === 'none' ? 1 : expandState === 'L1' ? 2 : 3
    setCollapsed((current) => {
      const next = new Set(current)
      for (const path of fresh) {
        if (path.split(separator).length >= minDepth) next.add(path)
      }
      return next.size === current.size ? current : next
    })
  }, [tree, separator, expandState])

  /* ---------------------------------------------------------------- 操作 */

  /**
   * 展开到指定层级。
   *
   * 与 Redis 版同语义：L1 只保留第一层目录展开、L2 到第二层，
   * 更深的一律折叠。大库下"全部展开"可能一次铺开上万行，
   * L1/L2 是可控的中间档。
   */
  function expandToLevel(level: number): void {
    const next = new Set<string>()
    const walk = (nodes: McTreeNode[], depth: number): void => {
      for (const node of nodes) {
        if (node.children.length === 0) continue
        /* depth 从 0 起：depth >= level 说明这一层及更深的目录要折叠 */
        if (depth >= level) next.add(node.path)
        walk(node.children, depth + 1)
      }
    }
    walk(tree, 0)
    setCollapsed(next)
    setExpandState(level === 1 ? 'L1' : 'L2')
  }

  function toggleCollapse(path: string): void {
    /* 手动开合过就不再是"整齐的某一档"：清掉档位高亮，
       同时进入 custom，后续加载的新目录不再被自动折叠 */
    setExpandState('custom')
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  /**
   * 展开某个键的全部祖先目录。
   * 默认全部折叠后，新建的键若落在折叠目录里，保存完就"消失"了 ——
   * 与 Redis 版一致：新建后自动把路径展开，让新键直接可见。
   */
  function expandAncestors(key: string): void {
    const parts = key.split(separator)
    if (parts.length < 2) return
    setCollapsed((prev) => {
      const next = new Set(prev)
      let prefix = ''
      for (const part of parts.slice(0, -1)) {
        prefix = prefix ? `${prefix}${separator}${part}` : part
        next.delete(prefix)
      }
      return next
    })
    setExpandState('custom')
  }

  /* ---------------------------------------------------------------- 删除 */

  /**
   * 删除键（单个 / 批量共用）。
   *
   * 与 Redis 的 deleteKeys 保持同一套二次确认：标题 + 结构化明细 +
   * 预览（批量时逐行列出）+ 风险提示，并尊重设置里的「删除键前确认」开关。
   * Memcached 没有 DEL 多键命令，只能逐个执行；失败数如实回报。
   */
  async function removeKeys(list: string[], fromSelection = false): Promise<void> {
    if (!id || !list.length) return
    const single = list.length === 1
    /* 单键时带上元信息，便于确认删对了对象；批量只给数量与清单 */
    const target = single
      ? rows.find((row) => row.key === list[0]) ?? keys?.items.find((row) => row.key === list[0])
      : undefined
    const shown = list.slice(0, 30)

    const details: NonNullable<ConfirmRequest['details']> = [
      {
        label: single ? t('键名') : t('数量'),
        value: single ? list[0]! : t('{count} 个键', { count: list.length }),
        mono: true,
      },
    ]
    if (target) {
      details.push({ label: t('过期'), value: t(formatTtl(ttlOf(target))), mono: true, tone: 'muted' })
      details.push({ label: t('大小'), value: formatBytes(target.bytes), mono: true, tone: 'muted' })
    }

    const ok = await askConfirm({
      title: single ? t('删除键') : t('批量删除 {count} 个键', { count: list.length }),
      message: single ? t('即将从当前实例中移除该键：') : t('即将从当前实例中移除以下键：'),
      details,
      preview: single
        ? undefined
        : {
            label: t('待删除的键名'),
            text: shown.join('\n'),
            truncated: list.length > shown.length,
          },
      warning: single
        ? t('此操作不可撤销，键及其全部数据将被立即删除。')
        : t('此操作不可撤销，这些键及其全部数据将被立即删除。'),
      confirmText: single ? t('删除') : t('删除 {count} 个键', { count: list.length }),
      danger: true,
    })
    if (!ok) return

    let done = 0
    let failed = 0
    for (const key of list) {
      const res = await api.memcached.remove(id, key)
      if (res.ok && res.data.ok) done++
      else failed++
    }

    /* 与 Redis 一致：删掉的正好是当前查看的键时，值区退回概览 */
    if (state.selectedKey && list.includes(state.selectedKey)) {
      state.selectedKey = null
      state.selectedValue = null
    }

    setPicked((prev) => {
      if (!prev.size) return prev
      const next = new Set(prev)
      for (const key of list) next.delete(key)
      return next
    })
    if (fromSelection && list.length >= picked.size) setSelecting(false)

    if (failed) notify('err', t('已删除 {done} 个，失败 {failed} 个', { done, failed }))
    else notify('ok', single ? t('已删除') : t('已删除 {count} 个缓存项', { count: done }))
    await load()
  }

  function confirmBulkDelete(): void {
    if (!picked.size) return
    void removeKeys([...picked], true)
  }

  /* ---------------------------------------------------------------- 右键菜单 */

  function closeKeyMenu(): void {
    setKeyMenu(null)
  }

  /**
   * 打开右键菜单：先按鼠标位置原样放置，渲染后按真实尺寸修正，
   * 避免靠近窗口边缘时菜单被裁掉。与 Redis 键栏同一套定位逻辑。
   */
  function openKeyMenu(event: React.MouseEvent, target: McMenuTarget): void {
    event.preventDefault()
    const { clientX, clientY } = event
    setKeyMenu({ target, left: clientX, top: clientY })
    requestAnimationFrame(() => {
      const el = menuRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const left =
        clientX + rect.width > window.innerWidth ? Math.max(4, clientX - rect.width) : clientX
      const top =
        clientY + rect.height > window.innerHeight
          ? Math.max(4, window.innerHeight - rect.height - 4)
          : clientY
      if (left !== clientX || top !== clientY) setKeyMenu({ target, left, top })
    })
  }

  useTabBlur(closeKeyMenu)

  useEffect(() => {
    function onKeydown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setKeyMenu(null)
    }
    function onResize(): void {
      setKeyMenu(null)
    }
    window.addEventListener('keydown', onKeydown)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  /** 菜单动作统一入口：先取目标再关菜单，避免回调里读到已置空的 state */
  function runMenuAction(action: (target: McMenuTarget) => void): void {
    const target = keyMenu?.target
    if (!target) return
    closeKeyMenu()
    action(target)
  }

  function handleNodeContext(node: McTreeNode, event: React.MouseEvent): void {
    const target: McMenuTarget | null = node.children.length
      ? { kind: 'subtree', path: node.path, keys: collectLeaves(node) }
      : node.leaf
        ? { kind: 'key', key: node.leaf.key, keys: [node.leaf.key] }
        : null
    if (!target) return
    /* 右键即选中，菜单操作的"对象是谁"一眼可见 */
    if (target.kind === 'key') markSelected(target.key)
    openKeyMenu(event, target)
  }

  function handleFlatContext(row: McKeyRow, event: React.MouseEvent): void {
    markSelected(row.key)
    openKeyMenu(event, { kind: 'key', key: row.key, keys: [row.key] })
  }

  async function menuCopyName(key: string): Promise<void> {
    const done = await copyText(key)
    notify(done ? 'ok' : 'err', done ? t('已复制键名') : t('复制失败，请检查剪贴板权限'))
  }

  async function menuCopyValue(key: string): Promise<void> {
    if (!id) return
    const res = await api.memcached.get(id, key)
    if (!res.ok) {
      notify('err', t('读取键值失败：{error}', { error: res.error }))
      return
    }
    if (!res.data.found) {
      notify('err', t('键已过期或被删除'))
      return
    }
    const done = await copyText(res.data.data)
    notify(
      done ? 'ok' : 'err',
      done ? t('已复制键值（{count} 字符）', { count: res.data.data.length }) : t('复制失败，请检查剪贴板权限'),
    )
  }

  /** Memcached 文本协议里对应的读取命令；只生成读取类命令 */
  async function menuCopyCommand(key: string): Promise<void> {
    const done = await copyText(`get ${key}`)
    notify(done ? 'ok' : 'err', done ? t('已复制命令') : t('复制失败，请检查剪贴板权限'))
  }

  async function menuCopyPrefix(path: string): Promise<void> {
    const done = await copyText(path)
    notify(done ? 'ok' : 'err', done ? t('已复制前缀 {prefix}', { prefix: path }) : t('复制失败，请检查剪贴板权限'))
  }

  async function menuCopySubtreeKeys(keys: string[]): Promise<void> {
    if (!keys.length) {
      notify('err', t('该前缀下没有键'))
      return
    }
    const done = await copyText(keys.join('\n'))
    notify(done ? 'ok' : 'err', done ? t('已复制 {count} 个键名', { count: keys.length }) : t('复制失败，请检查剪贴板权限'))
  }

  function menuCreateUnder(path: string): void {
    setCreatePrefix(`${path}${separator}`)
    setDialogOpen(true)
  }

  /**
   * 重命名键。
   *
   * Memcached 协议没有 RENAME，主进程用「读取 → add 新键 → 删除旧键」组合实现，
   * 目标键已存在时拒绝而不是覆盖。成功后把选中态与目录展开跟到新键 ——
   * 否则改名后的键会落在折叠目录里，看起来像"改丢了"。
   */
  async function handleRenameConfirm(next: string): Promise<void> {
    const source = renameTarget
    setRenameTarget(null)
    if (!id || !source) return
    const target = next.trim()
    if (!target || target === source) return

    const res = await api.memcached.rename(id, source, target)
    if (!res.ok) {
      notify('err', res.error)
      return
    }
    if (!res.data.ok) {
      notify('err', res.data.message ?? t('重命名失败'))
      return
    }

    notify('ok', res.data.message ?? t('已重命名'))
    if (state.selectedKey === source) markSelected(target)
    expandAncestors(target)
    emitMcKeysChanged()
    await load()
  }

  function togglePicked(key: string): void {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleSelecting(): void {
    setSelecting((prev) => !prev)
    setPicked(new Set())
  }

  /**
   * 勾选一个树节点：目录 = 全选/全不选其子树，叶子 = 切换自己。
   * 与 Redis 版同一语义（目录可以整段选中）。
   */
  function pickNode(node: McTreeNode): void {
    const leaves = collectLeaves(node)
    const allPicked = leaves.every((key) => picked.has(key))
    setPicked((prev) => {
      const next = new Set(prev)
      for (const key of leaves) {
        if (allPicked) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }

  /** 已加载到本地的键数（分页累加） */
  const loaded = keys?.items.length ?? 0
  /** 快照中的键总数：翻页期间不变，用于「已加载 / 总数」与计数提示 */
  const total = keys?.total ?? 0
  const truncated = keys?.truncated ?? false
  const incompleteHint = truncated
    ? keys?.deniedSlabs.length
      ? t('{count} 个 slab 不可读，且仅能读取 COLD 分段，结果可能不完整', {
          count: keys.deniedSlabs.length,
        })
      : t('服务端不支持 lru_crawler metadump，已回退 cachedump：仅能读取 COLD 分段，刚写入的键可能缺失')
    : ''

  return (
    <section className="key-browser s-key-browser s-mc-browser" style={browserStyle}>
      {/*
        工具条：标题 · 实例地址 ...... 刷新 / 新建。
        原来的「筛选键名」输入框与下方搜索框操作同一个 filter 值（重复入口），
        已移除；筛选统一由下方 SearchFilterBox 承担。
        地址常显：多标签 / 侧栏收起时也能确认这一栏数据来自哪台实例。
        可见 / 总数计数放回筛选框右侧（纯文字），与 Redis 键栏同位置。
      */}
      <div className="toolbar">
        <span className="mc-browser-title">{t('缓存项')}</span>
        <span className="mc-endpoint" {...tipProps(t('已连接 · {endpoint}', { endpoint: endpointLabel }))}>
          <i className="mc-endpoint-dot" aria-hidden="true" />
          <span className="mono ellipsis">{endpointLabel}</span>
        </span>
        <span className="spacer" />
        <button
          className="btn-ghost icon"
          disabled={loading || !id}
          {...tipProps(t('重新读取缓存项（lru_crawler metadump）'))}
          onClick={() => void load()}
        >
          <DialogIcon name="refresh" size={13} className={loading ? 'spin' : undefined} />
        </button>
        <button
          className="btn-ghost icon add"
          disabled={!id}
          {...tipProps(t('新建缓存项'))}
          onClick={() => {
            setCreatePrefix('')
            setDialogOpen(true)
          }}
        >
          <DialogIcon name="add" size={14} />
        </button>
      </div>

      {/*
        视图栏：与 Redis 版 viewbar 完全同构 ——
        [树形|平铺] [分隔符输入] ...... [L1][L2][展开][折叠] | [批量]
        分隔符紧跟视图切换，而不是单独占一行工具栏：
        它只在树形下有意义，放在视图模式旁边，"改分隔符会影响这棵树"才是一眼可见的因果关系。
      */}
      <div className="viewbar">
        <div className="view-switch">
          <button className={viewMode === 'tree' ? 'on' : ''} onClick={() => setViewMode('tree')}>
            <DialogIcon name="tree" size={12} />
            {t('树形')}
          </button>
          <button className={viewMode === 'flat' ? 'on' : ''} onClick={() => setViewMode('flat')}>
            <DialogIcon name="list" size={12} />
            {t('平铺')}
          </button>
        </div>

        {/*
          分隔符输入框：与 Redis 版同位置、同形态（紧接视图切换，无文字标签）。
          含义靠 tooltip 说明 —— 空间宝贵，一个双字符输入框旁边再挂标题
          会把 L1/L2/展开/折叠 挤到下一行。
        */}
        {viewMode === 'tree' ? (
          <input
            value={separator}
            onChange={(event) => setSeparator(event.target.value)}
            onBlur={(event) => {
              if (!event.target.value) setSeparator(':')
            }}
            className="sep-input mono"
            maxLength={2}
            {...tipProps(t('层级分隔符，例如 a:b:c 使用 :'))}
          />
        ) : null}

        <span className="spacer" />

        {viewMode === 'tree' && id ? (
          <>
            {/* 层级展开：与 Redis 版同一组按钮，L1/L2 是大库下的"安全展开" */}
            <button
              className={`mini${expandState === 'L1' ? ' on' : ''}`}
              {...tipProps(t('展开至第 1 层'))}
              onClick={() => expandToLevel(1)}
            >
              L1
            </button>
            <button
              className={`mini${expandState === 'L2' ? ' on' : ''}`}
              {...tipProps(t('展开至第 2 层'))}
              onClick={() => expandToLevel(2)}
            >
              L2
            </button>
            <button
              className={`mini${expandState === 'all' ? ' on' : ''}`}
              {...tipProps(t('全部展开'))}
              onClick={() => {
                setCollapsed(new Set())
                setExpandState('all')
              }}
            >
              <DialogIcon name="expand" size={13} />
            </button>
            <button
              className={`mini${expandState === 'none' ? ' on' : ''}`}
              {...tipProps(t('全部折叠'))}
              onClick={() => {
                setCollapsed(new Set(allPaths))
                setExpandState('none')
              }}
            >
              <DialogIcon name="collapse" size={13} />
            </button>
          </>
        ) : null}

        {viewMode === 'tree' && id ? <div className="viewbar-sep" /> : null}

        {id ? (
          <button
            className={`mini${selecting ? ' on' : ''}`}
            {...tipProps(selecting ? t('退出勾选') : t('批量删除缓存项'))}
            onClick={toggleSelecting}
          >
            <DialogIcon name="check" size={13} />
          </button>
        ) : null}
      </div>

      {/* 勾选操作条 */}
      {selecting ? (
        <div className={`pick-bar${picked.size > 0 ? ' active' : ''}`}>
          <span className="pick-text">
            {t('已选')} <b className="mono">{picked.size}</b> {t('个键')}
          </span>
          <span className="spacer" />
          <button className="btn tiny" onClick={toggleSelecting}>
            <DialogIcon name="cancel" size={11} />
            {t('取消')}
          </button>
          <button
            className="btn tiny btn-danger"
            disabled={!picked.size}
            onClick={() => void confirmBulkDelete()}
          >
            <DialogIcon name="trash" size={12} />
            {t('删除选中')}
          </button>
        </div>
      ) : null}

      {/* 键名搜索：幽灵补全 + 搜索历史 + 精确匹配，与 Redis 版同一组件 */}
      <SearchFilterBox
        value={filter}
        onChange={setFilter}
        exact={exact}
        onToggleExact={() => setExact((v) => !v)}
        onSearch={() => void load()}
        disabled={!id}
        connectionId={id}
        /* Memcached 无库概念，历史桶统一记在 db 0，避免出现"db5 的历史"这种不存在的分组 */
        historyDb={0}
        scopeLabel="Memcached"
        placeholder={exact ? t('输入完整键名') : t('输入即筛，回车重新读取')}
        /* 可见 / 总数计数：纯文字，紧跟在筛选框右侧，与 Redis 键栏同款 */
        trailing={
          <span
            className="counter mono"
            {...tipProps(t('可见 {visible} 项 / 共 {total} 项', { visible: rows.length, total }))}
          >
            {rows.length} / {total}
          </span>
        }
      />

      {error ? (
        <p className="mc-browser-error">{error}</p>
      ) : !keys ? (
        <p className="empty-tip mc-browser-empty">
          {loading ? t('正在读取缓存项…') : t('暂无键数据')}
          <br />
          <span className="mc-browser-sub">
            {t('Memcached 无 KEYS/SCAN，将通过 lru_crawler 枚举全部缓存项')}
          </span>
        </p>
      ) : rows.length === 0 ? (
        <p className="empty-tip mc-browser-empty">
          {filter ? t('没有匹配的键') : t('实例中没有缓存项')}
        </p>
      ) : viewMode === 'tree' ? (
        <div className="key-list">
          {tree.map((node) => (
            <McTreeRow
              key={node.path}
              node={node}
              depth={0}
              collapsed={collapsed}
              onToggle={toggleCollapse}
              selectedKey={state.selectedKey}
              onSelect={(key) => markSelected(key)}
              selecting={selecting}
              picked={picked}
              onPick={pickNode}
              onRemove={(key) => void removeKeys([key])}
              onContext={handleNodeContext}
            />
          ))}
        </div>
      ) : (
        <div className="key-list">
          {rows.map((row) => {
            const isPicked = picked.has(row.key)
            const ttl = ttlOf(row)
            return (
              <div
                key={row.key}
                className={`key-item${state.selectedKey === row.key ? ' active' : ''}${isPicked ? ' picked' : ''}`}
                onClick={() => {
                  if (selecting) togglePicked(row.key)
                  else markSelected(row.key)
                }}
                onContextMenu={(event) => {
                  if (selecting) return
                  event.preventDefault()
                  handleFlatContext(row, event)
                }}
              >
                {selecting ? (
                  <label className="pick-box" onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isPicked}
                      onChange={() => togglePicked(row.key)}
                    />
                  </label>
                ) : null}
                {/* 平铺视图同样保留类型徽标位，与 Redis 平铺列表的列结构一致 */}
                <span className="type-badge type-string" {...tipProps(t('Memcached 值（不透明字节串）'))}>
                  M
                </span>
                <span className="key-name mono ellipsis" {...tipProps(row.key)}>
                  {row.key}
                </span>
                {/* 平铺行同样显示 TTL，而不是大小 —— 与 Redis 键列表同一列语义 */}
                <span className={`ttl mono ${ttlTone(ttl)}`.trim()}>{t(formatTtl(ttl))}</span>
                <button
                  className="del-btn"
                  {...tipProps(t('删除该键'))}
                  onClick={(event) => {
                    event.stopPropagation()
                    void removeKeys([row.key])
                  }}
                >
                  <DialogIcon name="cancel" size={11} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {keys ? (
        <footer className="list-foot mc-browser-foot">
          {/*
            左：已加载 / 快照总数（与 Redis 的「已加载 N / 库内总数」同构）。
            结果不完整时只追加短标记，完整原因放 tooltip，避免窄栏被撑爆。
          */}
          <span className="mono loaded" {...(truncated ? tipProps(incompleteHint) : {})}>
            {t('已加载 {count}', { count: loaded })}
            {total > loaded ? <> / {total}</> : null}
            {truncated ? ` · ${t('可能不完整')}` : ''}
          </span>
          <span className="spacer" />
          {loading ? (
            <span className="mono scanning">{t('读取中…')}</span>
          ) : loadingMore ? (
            <span className="mono scanning">{t('加载中…')}</span>
          ) : keys.hasMore ? (
            <>
              <button
                className="btn-ghost more"
                disabled={loadingMore}
                {...tipProps(t('再加载一页'))}
                onClick={() => void loadMore()}
              >
                <DialogIcon name="add" size={12} />
                {t('加载更多')}
              </button>
              <button
                className="btn-ghost more"
                disabled={loadingMore}
                {...tipProps(t('连续加载直到全部读取完成'))}
                onClick={() => void loadAll()}
              >
                <DialogIcon name="arrow-down" size={12} />
                {t('加载全部')}
              </button>
            </>
          ) : loaded ? (
            <span className="mono done">{t('已全部加载')}</span>
          ) : null}
        </footer>
      ) : null}

      {dialogOpen && id ? (
        <MemcachedKeyDialog
          connectionId={id}
          prefix={createPrefix || undefined}
          onClose={() => {
            setDialogOpen(false)
            setCreatePrefix('')
          }}
          onSaved={(key) => {
            markSelected(key)
            expandAncestors(key)
            /* 覆盖写入已选中的键时 selectedKey 不变，值区不会自动重读 —— 广播一次 */
            emitMcKeysChanged()
            void load()
          }}
        />
      ) : null}

      {/* 键右键菜单：树形与平铺共用，与 Redis 键栏同一套菜单骨架 */}
      {keyMenu
        ? createPortal(
            <div
              className="key-menu-mask s-key-browser"
              onClick={closeKeyMenu}
              onContextMenu={(event) => {
                event.preventDefault()
                closeKeyMenu()
              }}
            >
              <div
                ref={menuRef}
                className="key-menu s-key-browser"
                style={{ top: `${keyMenu.top}px`, left: `${keyMenu.left}px` }}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="km-head">
                  {keyMenu.target.kind === 'key' ? (
                    <span className="type-badge type-string" {...tipProps(t('Memcached 值（不透明字节串）'))}>
                      M
                    </span>
                  ) : (
                    <DialogIcon name="folder" size={13} className="km-prefix-icon" />
                  )}
                  <span
                    className="mono ellipsis"
                    {...tipProps(keyMenu.target.kind === 'key' ? keyMenu.target.key : keyMenu.target.path)}
                  >
                    {keyMenu.target.kind === 'key' ? keyMenu.target.key : keyMenu.target.path}
                  </span>
                </div>

                {keyMenu.target.kind === 'key' ? (
                  <>
                    <button className="km-item" onClick={() => runMenuAction((target) => {
                      if (target.kind === 'key') markSelected(target.key)
                    })}>
                      <DialogIcon name="eye" size={14} className="km-icon" />
                      <span>{t('查看值')}</span>
                    </button>

                    <div className="km-group">{t('复制')}</div>
                    <button className="km-item" onClick={() => runMenuAction((target) => {
                      if (target.kind === 'key') void menuCopyName(target.key)
                    })}>
                      <DialogIcon name="text" size={14} className="km-icon" />
                      <span>{t('复制键名')}</span>
                    </button>
                    <button className="km-item" onClick={() => runMenuAction((target) => {
                      if (target.kind === 'key') void menuCopyValue(target.key)
                    })}>
                      <DialogIcon name="copy" size={14} className="km-icon" />
                      <span>{t('复制键值')}</span>
                    </button>
                    <button className="km-item" onClick={() => runMenuAction((target) => {
                      if (target.kind === 'key') void menuCopyCommand(target.key)
                    })}>
                      <DialogIcon name="terminal" size={14} className="km-icon" />
                      <span>{t('复制为命令')}</span>
                    </button>

                    <div className="km-group">{t('管理')}</div>
                    <button className="km-item" onClick={() => runMenuAction((target) => {
                      if (target.kind === 'key') setRenameTarget(target.key)
                    })}>
                      <DialogIcon name="edit" size={14} className="km-icon" />
                      <span>{t('重命名键')}</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button className="km-item" onClick={() => runMenuAction((target) => {
                      if (target.kind === 'subtree') menuCreateUnder(target.path)
                    })}>
                      <DialogIcon name="add" size={14} className="km-icon" />
                      <span>{t('添加新键')}</span>
                    </button>

                    <div className="km-group">{t('复制')}</div>
                    <button className="km-item" onClick={() => runMenuAction((target) => {
                      if (target.kind === 'subtree') void menuCopyPrefix(target.path)
                    })}>
                      <DialogIcon name="text" size={14} className="km-icon" />
                      <span>{t('复制前缀')}</span>
                    </button>
                    <button className="km-item" onClick={() => runMenuAction((target) => {
                      if (target.kind === 'subtree') void menuCopySubtreeKeys(target.keys)
                    })}>
                      <DialogIcon name="copy" size={14} className="km-icon" />
                      <span>{t('复制全部键名')}</span>
                    </button>
                  </>
                )}

                <div className="km-sep" />

                <button
                  className="km-item danger"
                  onClick={() => runMenuAction((target) => void removeKeys(target.keys))}
                >
                  <DialogIcon name="trash" size={14} className="km-icon" />
                  <span>
                    {keyMenu.target.kind === 'subtree'
                      ? t('批量删除 {count} 个键', { count: keyMenu.target.keys.length })
                      : t('删除键')}
                  </span>
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}

      {/* 重命名键：与 Redis 键栏同一个 PromptDialog，提示里说明组合实现的限制 */}
      {renameTarget ? (
        <PromptDialog
          title={t('重命名键')}
          label={t('新的键名')}
          initialValue={renameTarget}
          placeholder={t('请输入新的键名')}
          hint={t('Memcached 没有 RENAME 命令：将读取原值写入新键后删除旧键；目标键已存在会被拒绝。服务端支持 meta 时会保留剩余 TTL 与 flags。')}
          confirmText={t('重命名')}
          onConfirm={(next) => void handleRenameConfirm(next)}
          onCancel={() => setRenameTarget(null)}
        />
      ) : null}
    </section>
  )
}

/** 收集一个节点下的全部真实键名（含自身） */
function collectLeaves(node: McTreeNode): string[] {
  const out: string[] = []
  if (node.leaf) out.push(node.leaf.key)
  for (const child of node.children) out.push(...collectLeaves(child))
  return out
}

/** 递归统计子树里的键数（目录显示用） */
function countLeaves(node: McTreeNode): number {
  return node.leafCount
}

interface McTreeRowProps {
  node: McTreeNode
  depth: number
  collapsed: Set<string>
  onToggle: (path: string) => void
  selectedKey: string | null
  onSelect: (key: string) => void
  selecting: boolean
  picked: Set<string>
  onPick: (node: McTreeNode) => void
  onRemove: (key: string) => void
  onContext: (node: McTreeNode, event: React.MouseEvent) => void
}

/**
 * 树形单行（递归）。
 *
 * 行结构与 Redis 版 KeyTreeNode 一致：折叠箭头 / 文件夹 / 类型徽标 /
 * 键名 / TTL / 悬停删除。Memcached 没有类型，徽标统一显示 M；
 * TTL 由 metadump / cachedump 的到期时间换算，语义与 Redis 相同（永久 / 剩余秒数）。
 * 缩进、折叠箭头、目录计数的视觉完全一致。
 */
function McTreeRow({
  node,
  depth,
  collapsed,
  onToggle,
  selectedKey,
  onSelect,
  selecting,
  picked,
  onPick,
  onRemove,
  onContext,
}: McTreeRowProps) {
  const { t } = useI18n()
  const isDir = node.children.length > 0
  const isCollapsed = collapsed.has(node.path)
  const leaves = isDir ? collectLeaves(node) : node.leaf ? [node.leaf.key] : []
  const allPicked = leaves.length > 0 && leaves.every((key) => picked.has(key))
  const somePicked = !allPicked && leaves.some((key) => picked.has(key))
  const isSelected = !!node.leaf && selectedKey === node.leaf.key

  function handleClick(): void {
    if (selecting) {
      onPick(node)
      return
    }
    if (isDir) onToggle(node.path)
    else if (node.leaf) onSelect(node.leaf.key)
  }

  return (
    <>
      <div className="tree-node s-key-tree-node mc-tree-node">
        <div
          className={`node-row${isSelected ? ' active' : ''}${isDir && !node.leaf ? ' folder' : ''}${
            selecting && allPicked ? ' picked' : ''
          }`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={handleClick}
          onContextMenu={(event) => {
            if (selecting) return
            event.preventDefault()
            onContext(node, event)
          }}
        >
          {/* 折叠箭头：与 Redis 版同一形状（三角，展开时旋转 90°） */}
          {isDir ? (
            <button
              className="caret"
              onClick={(event) => {
                event.stopPropagation()
                onToggle(node.path)
              }}
            >
              <svg
                viewBox="0 0 12 12"
                className={`caret-ico${isCollapsed ? ' collapsed' : ''}`}
                aria-hidden="true"
              >
                <path d="M4.2 2.6 8.4 6l-4.2 3.4z" />
              </svg>
            </button>
          ) : (
            <span className="caret placeholder" />
          )}

          {/* 勾选模式：复选框占据文件夹图标的位置 */}
          {selecting ? (
            <label className="pick-box" onClick={(event) => event.stopPropagation()}>
              <input type="checkbox" checked={allPicked} onChange={() => onPick(node)} />
            </label>
          ) : null}

          {/*
            文件夹图标：与 Redis 版同一套形状 ——
            收起为闭合文件夹，展开为「上半盖 + 下半开口盒」。
            Memcached 的键名同样用分隔符分层，目录语义完全一致。
          */}
          {isDir ? (
            <svg
              viewBox="0 0 16 16"
              className={`folder-icon${isCollapsed ? ' collapsed' : ''}`}
              aria-hidden="true"
            >
              {isCollapsed ? (
                <path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h2.6l1.3 1.5h5.7A1.2 1.2 0 0 1 14 5.7v5.1A1.2 1.2 0 0 1 12.8 12H3.2A1.2 1.2 0 0 1 2 10.8z" />
              ) : (
                <g>
                  <path d="M2 4.4A1.2 1.2 0 0 1 3.2 3.2h2.5l1.3 1.5h5.6c.66 0 1.2.54 1.2 1.2v.6H2z" />
                  <path d="M2.3 7.2h11.4l-.9 3.9a1.2 1.2 0 0 1-1.17.94H3.4a1.2 1.2 0 0 1-1.17-.94z" />
                </g>
              )}
            </svg>
          ) : null}

          {/*
            键类型徽标：Memcached 只有一种值类型（不透明字节串），
            因此统一显示 M —— 与连接列表、日志里的引擎角标同一字母。
            底色借用 Redis 的 string 徽标色（type-string），
            两边键栏的徽标规格、颜色语义保持一致，切换引擎不产生"这套 UI 没做完"的感觉。
          */}
          {node.leaf && !isDir ? (
            <span className="type-badge type-string" {...tipProps(t('Memcached 值（不透明字节串）'))}>
              M
            </span>
          ) : null}

          <span className={`label mono ellipsis${isDir ? ' dir' : ''}`} {...tipProps(node.path || node.label)}>
            {node.label}
          </span>

          {isDir ? <span className="count mono">{countLeaves(node)}</span> : null}

          {/* 叶子右侧显示 TTL（与 Redis 同列、同格式）：永久键弱化、≤60s 用琥珀提醒 */}
          {node.leaf && !isDir ? (
            <span className={`ttl mono ${ttlTone(node.leaf.ttl)}`.trim()}>{t(formatTtl(node.leaf.ttl))}</span>
          ) : null}

          {node.leaf && !isDir && !selecting ? (
            <button
              className="del-btn"
              {...tipProps(t('删除该键'))}
              onClick={(event) => {
                event.stopPropagation()
                onRemove(node.leaf!.key)
              }}
            >
              {/* 与 Redis 键栏同一个删除图标（×），不用垃圾桶 —— 两边图标语义要一致 */}
              <DialogIcon name="cancel" size={10} />
            </button>
          ) : null}
        </div>
      </div>

      {isDir && !isCollapsed
        ? node.children.map((child) => (
            <McTreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
              selectedKey={selectedKey}
              onSelect={onSelect}
              selecting={selecting}
              picked={picked}
              onPick={onPick}
              onRemove={onRemove}
              onContext={onContext}
            />
          ))
        : null}
    </>
  )
}

export default MemcachedKeyBrowser

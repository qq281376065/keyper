import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '@/api'
import { CreateKeyDialog } from '@/components/CreateKeyDialog'
import { DialogIcon } from '@/components/DialogIcon'
import { KeyTreeNode } from '@/components/KeyTreeNode'
import { LiveTtl } from '@/components/LiveTtl'
import { PromptDialog } from '@/components/PromptDialog'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
import { useSearchHistory, SEARCH_HISTORY_LIMIT, formatHistoryTime } from '@/hooks/useSearchHistory'
import { useSessionStore } from '@/hooks/useSessionStore'
import { useTabBlur } from '@/hooks/useTabBlur'
import { useSettings, settingsHolder, KEY_BROWSER_MIN_WIDTH } from '@/services/settings'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { copyText } from '@/utils/clipboard'
import { ttlAtOf } from '@/utils/format'
import { typeAbbr, typeLabel } from '@/utils/typeLabel'
import {
  buildKeyTree,
  collectParents,
  collectParentsBelow,
  type KeyTreeNode as KeyTreeNodeModel,
} from '@/utils/keyTree'
import type { RedisKeyItem } from '@shared/types'
import type { BulkAction } from '@/store/session'

type ViewMode = 'tree' | 'flat'

/**
 * 键列表栏（中间栏）：db 切换 / 匹配模式 / 树形-平铺 / 搜索与历史 / 批量操作 /
 * 右键菜单 / 分页加载。
 *
 * 宽度由设置持有、拖拽由外部 SplitPane 负责 —— 本组件只负责"按给定宽度渲染"。
 */

/** 平铺虚拟滚动的行高（实测值，与 .key-item 的 height 必须同步） */
const FLAT_ROW_H = 31
const FLAT_OVERSCAN = 8

/**
 * 「全部展开 / 全部折叠 / 展开至第 N 层」按钮的选中态。
 * 初始为 none（默认全部折叠）；用户逐层手动调整后转为 custom，所有按钮均不选中；
 * L1 / L2 是层级展开态（展开到第 1 / 2 层），是「全部展开」在大库下的安全版。
 */
type ExpandState = 'all' | 'none' | 'custom' | 'L1' | 'L2'

/**
 * 菜单目标：要么是**单个真实键**（平铺项 / 深层叶子），
 * 要么是**一棵子树**（顶层节点，删除语义为批量删除该前缀下的全部键）。
 *
 * 顶层目录节点自身可能没有 leaf（纯路径），但它的子树里全是待删的键，
 * 因此必须携带 node 才能统计影响范围。
 */
type KeyMenuTarget =
  | { kind: 'key'; item: RedisKeyItem; keys: string[] }
  | { kind: 'subtree'; node: KeyTreeNodeModel; keys: string[] }

export function KeyBrowser() {
  const { t } = useI18n()
  const {
    state,
    filteredKeys,
    stopRemoteSearch,
    searchCurrentDb,
    currentDbKeys,
    loadKeys,
    loadMore,
    loadAll,
    refreshKeys,
    switchDb,
    selectKey,
    markSelected,
    deleteKeys,
    renameKey,
    setTtl,
    refreshSelected,
    notify,
    openBulkTask,
  } = useRedis()

  useObservable(useSessionStore())
  useObservable(settingsHolder)

  const { settings, save: saveSettings } = useSettings()

  const [draftPattern, setDraftPattern] = useState(state.pattern)
  const [createVisible, setCreateVisible] = useState(false)
  /**
   * 新建键时锁定的前缀（来自树节点右键「添加新键」）。
   * 为空表示普通新建 —— 键名自由输入。
   */
  const [createPrefix, setCreatePrefix] = useState('')

  /**
   * 键栏宽度。
   *
   * 用 CSS min() 夹到 52%：百分比作用于父级 flex 容器（.body），
   * 所以侧栏收起/展开、窗口缩放时基准都会自动跟着变，不需要任何 JS 重算。
   * clamp 的下限保证：窄窗口下 52% 也不会把工具条压到换行（默认同为 420）。
   */
  const browserStyle: React.CSSProperties = {
    width: `clamp(${KEY_BROWSER_MIN_WIDTH}px, ${settings.keyBrowserWidth}px, 52%)`,
    flexBasis: `clamp(${KEY_BROWSER_MIN_WIDTH}px, ${settings.keyBrowserWidth}px, 52%)`,
  }

  /* ---------------------------------------------------------------- 批量勾选 */

  /**
   * 勾选模式：工具条上的图标切换。
   * 开启后每个节点 / 数据行前面出现复选框，勾选结果累积在 picked 里。
   * 关闭时清空 —— 保留一批看不见的勾选状态，下次误点删除会删掉
   * 一批自己都不记得选过什么，风险太高。
   */
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const pickedCount = picked.size

  function toggleSelecting(): void {
    const next = !selecting
    setSelecting(next)
    if (!next) setPicked(new Set())
  }

  const isPicked = (key: string): boolean => picked.has(key)

  /** 勾选 / 取消一个键（用新 Set 赋值，保证引用变化触发重渲染） */
  function togglePick(key: string): void {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** 从子树收集全部真实键名（含中间层级自身也是键的情况） */
  function collectSubtreeKeys(node: KeyTreeNodeModel): string[] {
    const keys: string[] = []
    if (node.leaf) keys.push(node.leaf.key)
    for (const child of node.children) keys.push(...collectSubtreeKeys(child))
    return keys
  }

  /**
   * 树节点统一勾选：勾目录等于勾它整棵子树下的全部键。
   * 目录节点本身不是一个键，若只勾它而不展开子键，用户无法预期"到底会删掉什么"。
   */
  function togglePickNode(node: KeyTreeNodeModel): void {
    const keys = collectSubtreeKeys(node)
    const allPicked = keys.every((key) => picked.has(key))
    setPicked((prev) => {
      const next = new Set(prev)
      for (const key of keys) {
        if (allPicked) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }

  /** 节点是否处于"整棵子树都被勾选"的状态 */
  function isNodePicked(node: KeyTreeNodeModel): boolean {
    const keys = collectSubtreeKeys(node)
    return keys.length > 0 && keys.every((key) => picked.has(key))
  }

  /** 节点是否部分勾选（用于复选框的 indeterminate 中间态） */
  function isNodeIndeterminate(node: KeyTreeNodeModel): boolean {
    const keys = collectSubtreeKeys(node)
    const count = keys.filter((key) => picked.has(key)).length
    return count > 0 && count < keys.length
  }

  /**
   * 执行勾选操作：直接进值区面板。
   *
   * 不弹二次确认是有意的 —— 面板本身就是确认环节：
   * 它列出完整的待处理清单（可搜索、可逐条移除），底部还有一次「执行」。
   */
  function confirmPickedAction(action: BulkAction): void {
    if (!picked.size || !state.activeId) return
    const keys = [...picked]
    setSelecting(false)
    setPicked(new Set())
    openBulkTask(action, keys)
  }

  /* ---------------------------------------------------------------- 键右键菜单 */

  const [keyMenu, setKeyMenu] = useState<{ target: KeyMenuTarget; top: number; left: number } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  /**
   * 打开键右键菜单。
   *
   * 定位分两步：先以鼠标位置原样放置，渲染后再量取真实尺寸修正 ——
   * 菜单有两种形态（单键较长、子树较短），用固定常量估算高度
   * 会让矮菜单在靠近底部时过早地向上翻，明显的"跳一下"。
   */
  function openKeyMenu(event: React.MouseEvent, target: KeyMenuTarget): void {
    const clientX = event.clientX
    const clientY = event.clientY
    setKeyMenu({ target, left: clientX, top: clientY })
    requestAnimationFrame(() => {
      const el = menuRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      // 右侧不够就向左翻；底部不够就上移，并留 4px 边距
      const left =
        clientX + rect.width > window.innerWidth ? Math.max(4, clientX - rect.width) : clientX
      const top =
        clientY + rect.height > window.innerHeight
          ? Math.max(4, window.innerHeight - rect.height - 4)
          : clientY
      if (left !== clientX || top !== clientY) setKeyMenu({ target, left, top })
    })
  }

  function closeKeyMenu(): void {
    setKeyMenu(null)
  }

  /**
   * 标签切走时关闭键菜单与历史浮层。
   * 键菜单通过 portal 挂在 body 上，display:none 管不到它，
   * 不主动关闭会带着上一个连接的键名留在屏幕上。
   */
  useTabBlur(() => {
    closeKeyMenu()
    setHistOpen(false)
    setHistSel(-1)
  })

  /**
   * 菜单动作的统一入口。
   * 必须先取出目标再关菜单：动作若在闭包里二次读取 keyMenu，
   * 此时它已被置空，会抛 TypeError（表现为"点了没反应"）。
   */
  function runKeyMenuAction(action: (target: KeyMenuTarget) => void): void {
    const target = keyMenu?.target
    if (!target) return
    closeKeyMenu()
    action(target)
  }

  /** 单键动作适配器：子树目标下这些项会被隐藏，此处再收窄一次类型 */
  function runSingleKeyAction(action: (item: RedisKeyItem) => void): void {
    runKeyMenuAction((target) => {
      if (target.kind !== 'key') return
      action(target.item)
    })
  }

  /** 前缀动作适配器：只对子树目标有意义 */
  function runPrefixAction(action: (node: KeyTreeNodeModel) => void): void {
    runKeyMenuAction((target) => {
      if (target.kind !== 'subtree') return
      action(target.node)
    })
  }

  /**
   * 菜单头部展示用：主标题 + 副标题。
   * 子树模式下没有单一键名，改为显示前缀路径；类型徽标也不适用，故不渲染。
   */
  const menuHead = (() => {
    const target = keyMenu?.target
    if (!target) return null
    if (target.kind === 'key') {
      return { key: target.item.key, type: target.item.type as string, count: 0, isSubtree: false }
    }
    return { key: target.node.path, type: '', count: target.keys.length, isSubtree: true }
  })()

  /* ---------------------------------------------------------------- 状态（视图 / 分隔符 / 折叠） */

  /** 视图模式取自设置，跨会话保留 */
  const [viewMode, setViewMode] = useState<ViewMode>(settings.viewMode)
  /** 键名分隔符：取自设置（默认冒号），支持 / - . 等常见分层写法 */
  const [rawSeparator, setRawSeparator] = useState(settings.keySeparator || ':')

  /** 折叠的路径集合：记录被折叠的目录节点路径 */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expandState, setExpandState] = useState<ExpandState>('none')

  /**
   * 视图模式 / 分隔符的双向同步。
   *
   * 设置是异步加载的，本组件挂载时可能还没拿到磁盘值 ——
   * 直接用 settings 作初值会锁死在默认值上。因此：
   * 1. 初值先取 settings（异步回来后未必是最新）；
   * 2. 设置变化时同步过来；但一旦用户手动改过，就不再被覆盖。
   */
  const viewTouched = useRef(false)
  const sepTouched = useRef(false)

  function setViewModeAndPersist(mode: ViewMode): void {
    viewTouched.current = true
    setViewMode(mode)
    void saveSettings({ viewMode: mode })
  }

  function markSepTouched(): void {
    sepTouched.current = true
  }

  useEffect(() => {
    if (viewTouched.current) return
    setViewMode(settings.viewMode)
  }, [settings.viewMode])

  useEffect(() => {
    if (sepTouched.current || !settings.keySeparator) return
    setRawSeparator(settings.keySeparator)
  }, [settings.keySeparator])

  const separator = rawSeparator || ':'

  /* ---------------------------------------------------------------- 全库搜索态 / 列表数据源 */

  /**
   * 全库搜索态的判定：remoteSearch 存在 **且关键词与筛选框一致**。
   *
   * 一致性校验不能省：防抖窗口内（输入了新词、远程搜索还是旧词的），
   * 若只看 remoteSearch 非空就切数据源，列表会显示旧词的结果、筛选框里却是新词。
   */
  const remoteActive =
    !!state.remoteSearch && state.remoteSearch.keyword === state.keyFilter.trim() && !!state.keyFilter.trim()

  /** 全库扫描进行中：列表为空时显示扫描加载态，不闪「没有匹配的键」 */
  const remoteScanning = remoteActive && !!state.remoteSearch?.scanning

  /** 列表数据源：全库搜索态用 remoteKeys，否则本地筛选结果 */
  const displayKeys = remoteActive ? state.remoteKeys : filteredKeys

  /**
   * 树形视图的数据源必须与平铺视图一致（都用 displayKeys）。
   *
   * 这里曾经只喂 filteredKeys —— 那次 bug 的表现是：
   * 全库搜索命中的键在平铺列表里能看到，切到树形却一个都不显示。
   * 原因是 filteredKeys 只过滤「已加载的这一页」，全库搜索的结果在
   * state.remoteKeys 里，树根本没拿到那份数据。
   */
  const treeNodes = useMemo(() => buildKeyTree(displayKeys, separator), [displayKeys, separator])

  const connected =
    !!state.activeId && state.connections.some((c) => c.id === state.activeId && c.status === 'connected')

  /**
   * 展开状态的存储键：按「连接 @ 库」分组。
   * 不同连接的树结构完全不同，共用一个 key 会互相串。
   */
  const expandScope = state.activeId ? `${state.activeId}@${state.activeDb}` : ''


  /**
   * 数据集身份：连接 + 库 + 匹配模式。
   * 这三者是"要看哪些键"的定义，变化时才有理由重置折叠态；
   * 删除 / 新增 / 重命名键只是数据增减，用户的展开-折叠意图应当保留。
   */
  /*
   * 搜索态也属于「数据集身份」：全库搜索会把列表换成 remoteKeys，
   * 树形目录结构随之整体变化。不带上关键词的话，切换搜索时不会触发
   * 折叠权重置，新目录会被旧数据集遗留的 collapsed 路径挡住。
   */
  const datasetKey = `${state.activeId}|${state.activeDb}|${state.pattern}|${remoteActive ? state.keyFilter.trim() : ''}`

  /**
   * 恢复上次的展开状态。
   * 存的是**展开**的路径而不是折叠的：默认全部折叠是主行为，存展开项数量更小。
   */
  function restoreExpanded(): void {
    const saved = settings.expandedPaths[expandScope] ?? []
    const allPaths = collectParents(treeNodes)
    const savedSet = new Set(saved)
    /*
     * 只认「在当前树里真实存在」的展开路径：
     * 键被删掉后残留路径仍留在设置里，若直接用 saved.size 判断状态，
     * 会出现「记录说展开了 3 个目录、界面一个都没展开，按钮却显示全部展开」的矛盾。
     */
    const effective = allPaths.filter((path) => savedSet.has(path))
    setCollapsed(new Set(allPaths.filter((path) => !savedSet.has(path))))
    setExpandState(
      effective.length === 0 ? 'none' : effective.length === allPaths.length ? 'all' : 'custom',
    )
  }

  /* ---------------------------------------------------------------- 折叠状态持久化（防抖 + 写穿） */

  const expandSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 待写盘的快照：捕获瞬间自洽（scope 与路径同源），flush 时直接使用 */
  const pendingExpandSave = useRef<{ scope: string; snapshot: string[]; identity: string } | null>(null)

  /** 用最新一次的 collapsed / treeNodes 计算展开快照 */
  function snapshotExpanded(): string[] {
    const allPaths = collectParents(treeNodes)
    return allPaths.filter((path) => !collapsed.has(path))
  }

  function writeExpanded(scope: string, snapshot: string[]): void {
    void saveSettings({ expandedPaths: { ...settings.expandedPaths, [scope]: snapshot } })
  }

  function persistExpanded(): void {
    const scope = expandScope
    if (!scope) return
    const snapshot = snapshotExpanded()
    /** 本次写入针对的数据集，定时器触发时若已切换则丢弃 */
    const identity = datasetKey
    pendingExpandSave.current = { scope, snapshot, identity }
    if (expandSaveTimer.current) clearTimeout(expandSaveTimer.current)
    expandSaveTimer.current = setTimeout(() => {
      expandSaveTimer.current = null
      const pending = pendingExpandSave.current
      // 双保险：数据集已切换时通常已由 flush 先行写盘，这里不得再写
      if (!pending || datasetKey !== pending.identity) return
      pendingExpandSave.current = null
      writeExpanded(pending.scope, pending.snapshot)
    }, 400)
  }

  /** 立即写盘：用于「全部展开 / 全部折叠」这类明确的一次性操作，不给防抖留丢弃窗口 */
  function persistNow(): void {
    const scope = expandScope
    if (!scope) return
    const snapshot = snapshotExpanded()
    if (expandSaveTimer.current) clearTimeout(expandSaveTimer.current)
    expandSaveTimer.current = null
    pendingExpandSave.current = null
    writeExpanded(scope, snapshot)
  }

  /**
   * 把防抖中的快照写穿：数据集切换 / 组件卸载 / 窗口关闭前调用。
   * 快照在点击瞬间捕获、scope 与路径同源，此时写盘不会串库。
   */
  function flushExpanded(): void {
    if (expandSaveTimer.current) clearTimeout(expandSaveTimer.current)
    expandSaveTimer.current = null
    const pending = pendingExpandSave.current
    if (!pending) return
    pendingExpandSave.current = null
    writeExpanded(pending.scope, pending.snapshot)
  }

  /**
   * 数据集切换后，等新数据到位再应用展开状态。
   *
   * 三重判定，全部成立才应用：
   *   1. 不在扫描中；
   *   2. 当前键数据的归属（keysDataset）等于当前数据集身份 —— 数据确实换了；
   *   3. 与上次应用过的身份不同 —— 避免刷新/重扫把用户手动调好的状态冲掉。
   */
  const appliedDatasetKey = useRef('')

  /**
   * 数据集身份一变就立即清空折叠集（不等数据到位）。
   *
   * 为什么必须先清：
   * collapsed 存的是「路径字符串」，而路径是**跨数据集同形**的
   * （两台实例上都有 HALLOWEEN / mq 这种目录名）。切标签时
   * datasetKey 立刻变了，但 state.keys 还是上一个标签的数据，
   * 下面那个 effect 会因 `keysDataset !== datasetKey` 提前 return，
   * 于是 collapsed 保持上一个数据集的形态；等新数据到位后，
   * 同名路径不在 collapsed 里 → 显示为展开 ——
   * 用户看到的就是「切回这个连接，目录莫名其妙是展开的」。
   *
   * 这里先清成空集（= 全部展开的语义占位），
   * 随后 restoreExpanded 会按本数据集的存档重建，终态正确且不会串台。
   */
  useEffect(() => {
    setCollapsed(new Set())
    setExpandState('none')
    appliedDatasetKey.current = ''
  }, [datasetKey])

  useEffect(() => {
    if (state.loadingKeys) return
    /*
     * 键数据已被清空（断开 / 切换连接时的 reset）：
     * "已应用身份"的记忆随之作废。否则断开后重连同一实例时会被跳过恢复。
     */
    if (!state.keysDataset) {
      appliedDatasetKey.current = ''
      return
    }
    // 数据还没换到新数据集：此刻应用展开态必然算错
    if (state.keysDataset !== datasetKey) return
    // 同一数据集重复触发（刷新后仍停在本库）：不重置用户当前的展开状态
    if (datasetKey === appliedDatasetKey.current) return

    appliedDatasetKey.current = datasetKey
    restoreExpanded()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetKey, state.keysDataset, state.loadingKeys])

  /* 数据集即将离开时先写穿防抖快照（否则最后一次折叠可能落不了盘） */
  useEffect(() => {
    return () => flushExpanded()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetKey])

  /* 关窗/退出前写穿防抖快照 */
  useEffect(() => {
    window.addEventListener('beforeunload', flushExpanded)
    return () => window.removeEventListener('beforeunload', flushExpanded)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 连接断开**或切换到另一台实例**时，退出勾选模式并清空已选。
   * 切换连接更危险：勾的是 A 的键名，删除却发往 B —— 若 B 上恰好有同名键，会被无声删掉。
   */
  const prevActiveId = useRef(state.activeId)
  useEffect(() => {
    const prev = prevActiveId.current
    prevActiveId.current = state.activeId
    if (state.activeId && state.activeId === prev) return
    if (!prev && !state.activeId) return
    setSelecting(false)
    setPicked(new Set())
    /*
     * 提到具体键的弹窗也要关：重命名 / TTL / 新建键都靠 activeId 提交，
     * 断开或切换后留着它们，用户点确认只会作用在另一台实例上。
     */
    setRenameTarget(null)
    setTtlTarget(null)
    setCreateVisible(false)
    setCreatePrefix('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeId])

  /**
   * 「全部折叠」状态下，后加载的目录也要保持折叠。
   *
   * loadMore / loadAll 只是往 state.keys 追加，treeNodes 随之长出新目录；
   * 新路径不在 collapsed 里，默认就是展开 —— 用户明明点过「全部折叠」，
   * 一翻页又冒出一堆展开的目录，按钮状态与界面自相矛盾。
   */
  const knownParents = useRef<Set<string>>(new Set())
  useEffect(() => {
    const all = collectParents(treeNodes)
    const prev = knownParents.current
    knownParents.current = new Set(all)
    if (expandState === 'custom' || expandState === 'all') return
    const fresh = all.filter((path) => !prev.has(path))
    if (!fresh.length) return
    /*
     * 各状态下的补折口径（目录深度 = 路径分隔符段数）：
     *   none —— 新目录全部补折；
     *   L1   —— 第 2 层及以下的新目录补折；L2 —— 第 3 层及以下。
     */
    const minDepth = expandState === 'none' ? 1 : expandState === 'L1' ? 2 : expandState === 'L2' ? 3 : Infinity
    setCollapsed((current) => {
      const next = new Set(current)
      for (const path of fresh) {
        if (path.split(separator).length >= minDepth) next.add(path)
      }
      return next.size === current.size ? current : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeNodes])

  /* ---------------------------------------------------------------- 搜索 + 历史补全 */

  const searchHist = useSearchHistory(state.activeId, state.activeDb)

  /** 下拉展开态；histSel 为键盘选中行（-1 = 无） */
  const [histOpen, setHistOpen] = useState(false)
  const [histSel, setHistSel] = useState(-1)
  const filterInputEl = useRef<HTMLInputElement | null>(null)
  const ghostLeft = useRef(7)

  /** 当前输入命中的候选（子串、区分大小写 —— 与 filteredKeys 同语义） */
  const histRows = connected ? searchHist.matches(state.keyFilter) : []
  /** 幽灵目标（下拉展开时隐藏：列表本身就在展示全部候选） */
  const histGhost = histOpen ? null : searchHist.ghostTarget(state.keyFilter)
  /** 幽灵后缀文本 */
  const ghostRest = histGhost ? histGhost.q.slice(state.keyFilter.length) : ''

  const histConnName = state.connections.find((c) => c.id === state.activeId)?.name ?? ''
  const histCount = searchHist.entries.length

  /** 命中片段拆分（before/hit/after 三段渲染，避免 HTML 注入负担） */
  const histRowParts = (() => {
    const kw = state.keyFilter.trim()
    return histRows.map((e) => {
      const i = kw ? e.q.indexOf(kw) : -1
      return i < 0
        ? { e, before: e.q, hit: '', after: '' }
        : {
            e,
            before: e.q.slice(0, i),
            hit: e.q.slice(i, i + kw.length),
            after: e.q.slice(i + kw.length),
          }
    })
  })()

  /**
   * ghost 文字宽度测量：与输入框同字体。
   * canvas 只建一次；字体来自 getComputedStyle，运行期不变。
   */
  const textMeasure = useRef<CanvasRenderingContext2D | null>(null)

  function layoutGhost(): void {
    const el = filterInputEl.current
    if (!el || !ghostRest) return
    if (!textMeasure.current) {
      textMeasure.current = document.createElement('canvas').getContext('2d')
      if (!textMeasure.current) return
      const cs = getComputedStyle(el)
      textMeasure.current.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    }
    /* 7 = filter-box 的 padding-left；减 scrollLeft 处理长文本滚动 */
    ghostLeft.current = Math.max(0, 7 + textMeasure.current.measureText(state.keyFilter).width - el.scrollLeft)
  }

  useEffect(() => {
    setHistSel(-1) /* 输入变化后旧行号不再对应新列表 */
    requestAnimationFrame(layoutGhost)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.keyFilter])

  /* 连接 / 库切换：历史重新加载（按连接@库分桶），浮层立即收起防串数据 */
  useEffect(() => {
    setHistOpen(false)
    setHistSel(-1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeId, state.activeDb])

  /** 采纳幽灵补全；返回是否成功（失败时 Tab 继续默认的焦点移动） */
  function acceptGhost(): boolean {
    const t = searchHist.ghostTarget(state.keyFilter)
    if (!t) return false
    state.keyFilter = t.q
    return true
  }

  function closeHist(): void {
    setHistOpen(false)
    setHistSel(-1)
  }

  /** 执行查询并记录历史（回车 / 查询图标的统一入口） */
  function runSearch(): void {
    if (!connected) return
    searchCurrentDb()
    if (state.keyFilter.trim()) void searchHist.record(state.keyFilter)
    closeHist()
  }

  /** 从历史填入（只填不搜：填入后回车才执行，给用户确认长键名的机会） */
  function fillFromHistory(q: string): void {
    state.keyFilter = q
    closeHist()
    requestAnimationFrame(() => {
      const el = filterInputEl.current
      if (!el) return
      el.focus()
      el.setSelectionRange(q.length, q.length)
    })
  }

  function toggleHist(): void {
    if (histOpen) {
      closeHist()
    } else if (histRows.length) {
      setHistOpen(true)
      setHistSel(0)
    }
  }

  /** 搜索框键盘：方案 D 的完整交互路由 */
  function onFilterKeydown(e: React.KeyboardEvent): void {
    /* IME 组合期间的按键（拼音确认等）不参与任何交互路由 */
    if (e.nativeEvent.isComposing) return
    const key = e.key

    /* Tab / 光标在末尾的 → ：采纳幽灵（无候选时放行默认行为） */
    if (key === 'Tab' || (key === 'ArrowRight' && ghostRest)) {
      const atEnd = !filterInputEl.current || filterInputEl.current.selectionStart === state.keyFilter.length
      if ((key === 'Tab' || atEnd) && acceptGhost()) e.preventDefault()
      return
    }

    if (key === 'ArrowDown') {
      if (!histOpen) {
        if (!histRows.length) return /* 无候选不展开，保留 ↓ 的光标默认行为 */
        e.preventDefault()
        setHistOpen(true)
        setHistSel(0)
      } else {
        e.preventDefault()
        setHistSel((prev) => Math.min(prev + 1, histRows.length - 1))
      }
      return
    }

    if (key === 'ArrowUp' && histOpen) {
      e.preventDefault()
      setHistSel((prev) => Math.max(prev - 1, 0))
      return
    }

    if (key === 'Enter') {
      e.preventDefault()
      const row = histOpen && histSel >= 0 ? histRows[histSel] : undefined
      if (row) fillFromHistory(row.q) /* 有选中行：填入（第二次回车才执行） */
      else runSearch() /* 无选中：直接执行并记录 */
      return
    }

    if (key === 'Escape' && histOpen) {
      e.preventDefault()
      closeHist()
    }
  }


  /* ---------------------------------------------------------------- 平铺虚拟滚动 */

  const [flatScrollTop, setFlatScrollTop] = useState(0)
  const [flatViewH, setFlatViewH] = useState(600)
  const listEl = useRef<HTMLDivElement | null>(null)

  const flatStart = Math.max(0, Math.floor(flatScrollTop / FLAT_ROW_H) - FLAT_OVERSCAN)
  const flatEnd = Math.min(
    displayKeys.length,
    Math.ceil((flatScrollTop + flatViewH) / FLAT_ROW_H) + FLAT_OVERSCAN,
  )
  const visibleFlatKeys = displayKeys.slice(flatStart, flatEnd)

  useEffect(() => {
    const el = listEl.current
    if (!el) return
    setFlatViewH(el.clientHeight)
    const observer = new ResizeObserver(() => {
      if (listEl.current) setFlatViewH(listEl.current.clientHeight)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /**
   * 数据集切换中的全列表加载态：切库 / 改匹配模式 / 换连接后、新数据未到位的窗口期。
   * 判定复用 keysDataset（数据归属）而不是单看 loadingKeys。
   */
  const switchingDataset = state.loadingKeys && state.keysDataset !== datasetKey


  /* ---------------------------------------------------------------- 动作 */

  function applyPattern(): void {
    const next = draftPattern.trim() || '*'
    /*
     * 模式没变 = 用户点的是「重新扫描」：走增量刷新，
     * 列表原地替换，不闪骨架屏、不丢滚动位置与当前选中。
     * 模式变了才需要重置数据集，重新从游标 0 分页。
     */
    if (next === state.pattern) {
      void refreshKeys()
      return
    }
    /*
     * 只需改 pattern：datasetKey 会随之变化，
     * 上游的 effect 负责在新数据到位后折叠。
     */
    state.pattern = next
    void loadKeys(true)
  }

  function toggleNode(path: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    setExpandState('custom')
    persistExpanded()
  }

  function collapseAll(): void {
    setCollapsed(new Set(collectParents(treeNodes)))
    setExpandState('none')
    // 一次性明确操作：立即落盘。走防抖的话，点完就断开/退出会丢掉这次写入
    persistNow()
  }

  /*
   * 展开到第 N 层（1 / 2）：大库的安全版「全部展开」。
   * 实现 = 折叠所有深度 ≥ N+1 的目录，深度 1..N 保持展开。
   */
  function expandToLevel(level: 1 | 2): void {
    setCollapsed(new Set(collectParentsBelow(treeNodes, level + 1)))
    setExpandState(level === 1 ? 'L1' : 'L2')
    persistNow()
  }

  function expandAll(): void {
    setCollapsed(new Set())
    setExpandState('all')
    persistNow()
  }

  /** 展开某个键的全部祖先目录，保证新建的键在树中可见 */
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
    persistExpanded()
  }

  function handleSelectKey(key: string): void {
    void selectKey(key)
  }

  function handleDeleteKey(key: string): void {
    void deleteKeys([key])
  }

  function handleFlatClick(item: RedisKeyItem): void {
    /*
     * 勾选模式下整行点击 = 勾选，而不是"选中并加载值"。
     * 此时用户的目标是圈选一批键，点一下就去读值是多余的副作用。
     */
    if (selecting) {
      togglePick(item.key)
      return
    }
    void selectKey(item.key)
  }

  /** 树节点上报的右键：交由顶层统一打开菜单 */
  function handleNodeContext({
    node,
    event,
  }: {
    node: KeyTreeNodeModel
    depth: number
    event: React.MouseEvent
  }): void {
    const hasChildren = node.children.length > 0

    if (hasChildren) {
      /*
       * 子树目标（前缀）本身不是一个键，不参与选中 ——
       * 选中态表达的是"当前正在查看哪个键"，前缀没有对应的值可查看。
       */
      openKeyMenu(event, { kind: 'subtree', node, keys: collectSubtreeKeys(node) })
      return
    }

    if (node.leaf) {
      // 右键即选中：菜单内容针对该键，行高亮能让"操作对象是谁"一目了然
      markSelected(node.leaf.key)
      openKeyMenu(event, { kind: 'key', item: node.leaf, keys: [node.leaf.key] })
    }
  }

  function handleFlatContext(item: RedisKeyItem, event: React.MouseEvent): void {
    event.preventDefault()
    // 与树形一致：右键即选中该行
    markSelected(item.key)
    openKeyMenu(event, { kind: 'key', item, keys: [item.key] })
  }

  /* ---------------------------------------------------------------- 菜单动作 */

  /** 查看值：选中该键（若已是当前键则重新读取） */
  function menuViewValue(item: RedisKeyItem): void {
    void selectKey(item.key)
  }

  async function menuCopyName(item: RedisKeyItem): Promise<void> {
    const done = await copyText(item.key)
    notify(done ? 'ok' : 'err', done ? t('common.copiedKeyName') : t('common.copyFailedCheckClipboardPermissions'))
  }

  /**
   * 复制键值。
   * 非当前键时需先读取一次 —— 键列表只有元信息（类型 / TTL），不含值内容。
   */
  async function menuCopyValue(item: RedisKeyItem): Promise<void> {
    if (!state.activeId) return
    const res = await api.redis.value(state.activeId, item.key)
    if (!res.ok) {
      notify('err', t('keyBrowser.failedLoadKeyValue', { error: res.error }))
      return
    }
    const text = valueAsText(res.data.value, res.data.type)
    if (!text) {
      notify('err', t('keyBrowser.keyNothingCopy'))
      return
    }
    const done = await copyText(text)
    notify(done ? 'ok' : 'err', done ? t('keyBrowser.copiedKeyValue', { count: text.length }) : t('common.copyFailedCheckClipboardPermissions'))
  }

  /** 把各类值序列化为可粘贴文本 */
  function valueAsText(value: unknown, type: string): string {
    if (value == null) return ''
    if (typeof value === 'string') return value
    if (Array.isArray(value)) {
      // zset 的 member :: score、stream 的 id :: fields 原样保留分隔符
      return value.join('\n')
    }
    if (typeof value === 'object') {
      if (type === 'hash') {
        return Object.entries(value as Record<string, string>)
          .map(([field, val]) => `${field}=${val}`)
          .join('\n')
      }
      return JSON.stringify(value, null, 2)
    }
    return String(value)
  }

  /** 复制为 redis-cli 命令：让用户能直接在命令行复现这条数据 */
  async function menuCopyCommand(item: RedisKeyItem): Promise<void> {
    const command = buildRedisCommand(item)
    const done = await copyText(command)
    notify(done ? 'ok' : 'err', done ? t('keyBrowser.copiedCommand') : t('common.copyFailedCheckClipboardPermissions'))
  }

  /**
   * 按键类型生成对应的读取命令。
   * 只生成**读取类**命令（不生成删除等高危命令，避免误粘贴执行）。
   */
  function buildRedisCommand(item: RedisKeyItem): string {
    const key = /[\s"']/.test(item.key) ? `"${item.key}"` : item.key
    const byType: Record<string, string> = {
      string: `GET ${key}`,
      hash: `HGETALL ${key}`,
      list: `LRANGE ${key} 0 -1`,
      set: `SMEMBERS ${key}`,
      zset: `ZRANGE ${key} 0 -1 WITHSCORES`,
      stream: `XRANGE ${key} - +`,
    }
    return `${byType[item.type] ?? `TYPE ${key}`}\nTTL ${key}`
  }

  /* ---------------------------------------------------------------- 弹窗目标 */

  const [renameTarget, setRenameTarget] = useState<RedisKeyItem | null>(null)
  const [ttlTarget, setTtlTarget] = useState<RedisKeyItem | null>(null)

  function menuRename(item: RedisKeyItem): void {
    setRenameTarget(item)
  }

  function menuSetTtl(item: RedisKeyItem): void {
    setTtlTarget(item)
  }

  /* ---------------------------------------------------------------- 前缀动作 */

  /**
   * 以该前缀新建键。
   * 前缀取自节点路径（而不是某个键名），并锁定在弹窗里不可改 ——
   * 用户通过右键已经明确指向了这个目录，再让他手动输入完整键名容易手滑。
   */
  function menuCreateUnder(node: KeyTreeNodeModel): void {
    setCreatePrefix(node.path)
    setCreateVisible(true)
  }

  /** 复制前缀本身（便于粘贴到命令行或脚本里做前缀匹配） */
  async function menuCopyPrefix(node: KeyTreeNodeModel): Promise<void> {
    const done = await copyText(node.path)
    notify(done ? 'ok' : 'err', done ? t('keyBrowser.copiedPrefix', { prefix: node.path }) : t('common.copyFailedCheckClipboardPermissions'))
  }

  /** 复制该前缀下的全部键名，每行一个 */
  async function menuCopySubtreeKeys(node: KeyTreeNodeModel): Promise<void> {
    const keys = collectSubtreeKeys(node)
    if (!keys.length) {
      notify('err', t('keyBrowser.noKeysUnderPrefix'))
      return
    }
    const done = await copyText(keys.join('\n'))
    notify(done ? 'ok' : 'err', done ? t('keyBrowser.copiedCountKeyNames', { count: keys.length }) : t('common.copyFailedCheckClipboardPermissions'))
  }

  function handleCreateClose(): void {
    setCreateVisible(false)
    setCreatePrefix('')
  }

  /**
   * 工具条的「新建键」：不带前缀。
   * 必须显式清空 createPrefix —— 若上次是右键某个目录新建的，
   * 残留的前缀会让这次"普通新建"莫名其妙锁在一个旧前缀下。
   */
  function openCreateRoot(): void {
    setCreatePrefix('')
    setCreateVisible(true)
  }

  async function handleRenameConfirm(next: string): Promise<void> {
    const item = renameTarget
    setRenameTarget(null)
    if (!item) return
    await renameKey(item.key, next.trim())
    // 键名变化后列表需重扫才能反映新名字
    await loadKeys(true)
  }

  async function handleTtlConfirm(input: string): Promise<void> {
    const item = ttlTarget
    setTtlTarget(null)
    if (!item) return
    const seconds = Number(input.trim())
    await setTtl(item.key, Number.isFinite(seconds) ? seconds : 0)
    await loadKeys(true)
  }

  /**
   * 删除动作：单键与子树批量共用同一入口。
   * deleteKeys 内部会按数量自动切换确认框形态。
   */
  async function menuDelete(target: KeyMenuTarget): Promise<void> {
    if (!target.keys.length) {
      notify('err', t('keyBrowser.noDeletableKeysUnderPrefix'))
      return
    }
    await deleteKeys(target.keys)
  }

  /** Esc 关闭右键菜单；视口变化时坐标会失效，一并关闭 */
  useEffect(() => {
    function onKeydown(event: KeyboardEvent): void {
      if (event.key === 'Escape') closeKeyMenu()
    }
    function onResize(): void {
      closeKeyMenu()
    }
    window.addEventListener('keydown', onKeydown)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  async function handleCreated(key: string): Promise<void> {
    handleCreateClose()
    expandAncestors(key)
    await loadKeys(true)
    await selectKey(key)
  }

  /* ---------------------------------------------------------------- 渲染 */

  return (
    <section className="key-browser s-key-browser" style={browserStyle}>
      <div className="toolbar">
        <select
          className="db-select mono"
          value={state.activeDb}
          disabled={!connected}
          onChange={(event) => void switchDb(Number(event.target.value))}
        >
          {state.databases.map((item) => (
            <option key={item.db} value={item.db}>
              db{item.db} ({item.keys})
            </option>
          ))}
          {!state.databases.length ? <option value={0}>db0</option> : null}
        </select>

        <input
          value={draftPattern}
          onChange={(event) => setDraftPattern(event.target.value)}
          className="pattern mono"
          placeholder={t('keyBrowser.matchPatternExample')}
          disabled={!connected}
          onKeyUp={(event) => {
            if (event.key === 'Enter') applyPattern()
          }}
        />

        <button
          className="btn-ghost icon"
          {...tipProps(t('keyBrowser.rescan'))}
          disabled={!connected || state.refreshingKeys}
          onClick={applyPattern}
        >
          <DialogIcon
            name="refresh"
            size={13}
            className={state.loadingKeys || state.refreshingKeys ? 'spin' : undefined}
          />
        </button>
        <button className="btn-ghost icon add" {...tipProps(t('common.newKey'))} disabled={!connected} onClick={openCreateRoot}>
          <DialogIcon name="add" size={14} />
        </button>
      </div>

      <div className="viewbar">
        <div className="view-switch">
          <button className={viewMode === 'tree' ? 'on' : ''} onClick={() => setViewModeAndPersist('tree')}>
            <DialogIcon name="tree" size={12} />
            {t('keyBrowser.tree')}
          </button>
          <button className={viewMode === 'flat' ? 'on' : ''} onClick={() => setViewModeAndPersist('flat')}>
            <DialogIcon name="list" size={12} />
            {t('keyBrowser.flat')}
          </button>
        </div>

        {viewMode === 'tree' ? (
          <input
            value={rawSeparator}
            onChange={(event) => {
              markSepTouched()
              setRawSeparator(event.target.value)
            }}
            onBlur={(event) => {
              const value = event.target.value || ':'
              if (sepTouched.current && value !== settings.keySeparator) {
                void saveSettings({ keySeparator: value })
              }
            }}
            className="sep-input mono"
            maxLength={2}
            {...tipProps(t('keyBrowser.keySeparatorExample'))}
          />
        ) : null}

        <span className="spacer" />

        {viewMode === 'tree' && connected ? (
          <>
            {/* 层级展开：L1 只展开顶层目录、L2 到第二层 —— 大库下「全部展开」的安全版 */}
            <button
              className={`mini${expandState === 'L1' ? ' on' : ''}`}
              {...tipProps(t('keyBrowser.expandLevel1'))}
              onClick={() => expandToLevel(1)}
            >
              L1
            </button>
            <button
              className={`mini${expandState === 'L2' ? ' on' : ''}`}
              {...tipProps(t('keyBrowser.expandLevel2'))}
              onClick={() => expandToLevel(2)}
            >
              L2
            </button>
            <button className={`mini${expandState === 'all' ? ' on' : ''}`} {...tipProps(t('keyBrowser.expandAll'))} onClick={expandAll}>
              <DialogIcon name="expand" size={13} />
            </button>
            <button
              className={`mini${expandState === 'none' ? ' on' : ''}`}
              {...tipProps(t('keyBrowser.collapseAll'))}
              onClick={collapseAll}
            >
              <DialogIcon name="collapse" size={13} />
            </button>
          </>
        ) : null}

        {/* 分组分隔：左边是树形视图操作，右边开始是破坏性操作 */}
        {viewMode === 'tree' && connected ? <div className="viewbar-sep" /> : null}

        {/* 批量操作：进入勾选模式后在节点 / 数据行前显示复选框 */}
        {connected ? (
          <button
            className={`mini${selecting ? ' on' : ''}`}
            {...tipProps(selecting ? t('keyBrowser.exitSelection') : t('keyBrowser.bulkKeyOperations'))}
            onClick={toggleSelecting}
          >
            <DialogIcon name="check" size={13} />
          </button>
        ) : null}
      </div>

      {/* 勾选模式的操作条：只在有勾选时才展开主体，平时只占一行提示 */}
      {selecting ? (
        <div className={`pick-bar${pickedCount > 0 ? ' active' : ''}`}>
          <span className="pick-text">
            {t('keyBrowser.selected')} <b className="mono">{pickedCount}</b> {t('keyBrowser.keys')}
          </span>
          <span className="spacer" />
          <button className="btn tiny" onClick={toggleSelecting}>
            <DialogIcon name="cancel" size={11} />
            {t('common.cancel')}
          </button>
          <button className="btn tiny" disabled={!pickedCount} onClick={() => confirmPickedAction('ttl')}>
            <DialogIcon name="clock" size={12} />
            {t('common.setTtl')}
          </button>
          <button className="btn tiny" disabled={!pickedCount} onClick={() => confirmPickedAction('rename')}>
            <DialogIcon name="edit" size={12} />
            {t('common.rename')}
          </button>
          <button className="btn tiny btn-danger" disabled={!pickedCount} onClick={() => confirmPickedAction('delete')}>
            <DialogIcon name="trash" size={12} />
            {t('keyBrowser.deleteSelected')}
          </button>
        </div>
      ) : null}

      <div className="filter-row">
        <label className={`filter-box${connected ? '' : ' disabled'}`}>
          {/* 输入即筛已加载列表（filteredKeys）；回车/点查询图标才全库搜索当前 db */}
          <input
            ref={filterInputEl}
            value={state.keyFilter}
            onChange={(event) => {
              state.keyFilter = event.target.value
            }}
            className="filter"
            placeholder={state.keyFilterExact ? t('keyBrowser.enterFullKeyNameSearchAllDatabases') : t('keyBrowser.typeToFilterEnterSearchAllDatabases')}
            disabled={!connected}
            onKeyDown={onFilterKeydown}
            onBlur={() => {
              /* blur 延时收起：给浮层上的 mousedown 点击留出落地时间 */
              setTimeout(closeHist, 130)
            }}
          />
          {/* 幽灵后缀：最近一条前缀命中的剩余部分，Tab / → 采纳 */}
          {ghostRest ? (
            <span className="f-ghost" style={{ left: `${ghostLeft.current}px` }} aria-hidden="true">
              {ghostRest}
            </span>
          ) : null}
          {state.keyFilter ? (
            <button
              className="f-clear"
              {...tipProps(t('keyBrowser.clearFilter'))}
              onClick={() => {
                state.keyFilter = ''
              }}
            >
              <DialogIcon name="cancel" size={12} />
            </button>
          ) : null}
          {/* 历史候选展开开关：有候选才出现，↓ 同效 */}
          {connected && state.keyFilter && histRows.length ? (
            <button
              className={`f-caret${histOpen ? ' on' : ''}`}
              role="button"
              aria-expanded={histOpen}
              {...tipProps(t('keyBrowser.historySuggestions'))}
              onMouseDown={(event) => {
                event.preventDefault()
                toggleHist()
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
          ) : null}
          {/* 查询图标：点击强制全库搜索当前 db（不管本地是否已有匹配） */}
          <button
            className="f-search"
            disabled={!connected || !state.keyFilter.trim()}
            {...tipProps(t('keyBrowser.query'))}
            onClick={runSearch}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5 14 14" />
            </svg>
          </button>
          {/* 精确匹配开关：勾选后按「键名全等」而非子串筛选/搜索 */}
          <button
            className={`f-exact${state.keyFilterExact ? ' on' : ''}`}
            role="checkbox"
            aria-checked={state.keyFilterExact}
            disabled={!connected}
            {...tipProps(t('keyBrowser.exactMatch'))}
            onClick={() => {
              const next = !state.keyFilterExact
              state.keyFilterExact = next
              /*
               * 精确开关切换：正处于全库结果态时用新语义自动重搜
               * （用户已明确表达过「要搜全库」，开关只改匹配方式）。
               */
              if (state.remoteSearch && state.keyFilter.trim()) searchCurrentDb()
            }}
          >
            <span className="ex-box">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.5 8.5l3 3 6-7" />
              </svg>
            </span>
          </button>

          {/* 历史候选浮层：仅当前连接 @ 当前库；展开是显式动作（↓ / 箭头） */}
          {histOpen ? (
            <div className="hist-pop">
              <div className="hp-head">
                <span>{t('keyBrowser.currentConnectionOnly')}</span>
                <span className="hp-name">{histConnName}</span>
                <span className="hp-db">· DB {state.activeDb}</span>
                <span className={`hp-count${histCount >= SEARCH_HISTORY_LIMIT ? ' full' : ''}`}>
                  {histCount}/{SEARCH_HISTORY_LIMIT}
                </span>
              </div>
              <div className="hp-body">
                {!histRowParts.length ? (
                  <div className="hp-empty">
                    {state.keyFilter.trim() ? t('keyBrowser.noMatchingHistory') : t('keyBrowser.noSearchHistoryForConnection')}
                    <br />
                    {t('keyBrowser.runQuery')}
                  </div>
                ) : null}
                {histRowParts.map((row, i) => (
                  <div
                    key={row.e.q}
                    className={`hp-row${i === histSel ? ' sel' : ''}`}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      fillFromHistory(row.e.q)
                    }}
                  >
                    <span className="hp-q mono">
                      {row.before ? <span>{row.before}</span> : null}
                      {row.hit ? <mark>{row.hit}</mark> : null}
                      {row.after ? <span>{row.after}</span> : null}
                    </span>
                    <span className="hp-meta mono">
                      ×{row.e.count} · {formatHistoryTime(row.e.at)}
                    </span>
                    <button
                      className="hp-del"
                      {...tipProps(t('keyBrowser.deleteHistoryEntry'))}
                      onMouseDown={(event) => {
                        event.stopPropagation()
                        event.preventDefault()
                        void searchHist.remove(row.e.q)
                      }}
                    >
                      <DialogIcon name="cancel" size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="hp-foot">
                <span className="hp-keys">
                  <kbd>Tab</kbd>{t('keyBrowser.acceptGhost')} <kbd>↑</kbd>
                  <kbd>↓</kbd>{t('keyBrowser.selectHistoryEntry')} <kbd>Enter</kbd>{t('keyBrowser.fillHistoryEntry')}
                </span>
                <button
                  className="hp-clear"
                  onMouseDown={(event) => {
                    event.preventDefault()
                    void searchHist.clear().then(closeHist)
                  }}
                >
                  <DialogIcon name="trash" size={12} />
                  {t('keyBrowser.clearConnectionHistory')}
                </button>
              </div>
            </div>
          ) : null}
        </label>
        <span className="counter mono">
          {remoteActive ? t('keyBrowser.allDatabasesCount', { count: displayKeys.length }) : `${filteredKeys.length} / ${state.keys.length}`}
        </span>
      </div>

      <div
        ref={listEl}
        className="key-list"
        onScroll={(event) => {
          if (selecting || viewMode === 'flat') setFlatScrollTop(event.currentTarget.scrollTop)
          else setFlatScrollTop(event.currentTarget.scrollTop)
        }}
      >
        {/*
          全库搜索提示条：吸附在滚动区顶部。
          ⚠️ 必须放在 key-list 内部 —— 若插在外层布局流（filter-row 与列表之间），
          条件插拔会推挤列表与 footer，点击查询时整个页面抖动。
        */}
        {remoteActive && state.remoteSearch ? (
          <div className={`remote-bar${state.remoteSearch.scanning ? ' scanning' : ''}`}>
            <span className="rb-text">
              {t('keyBrowser.allDatabasesSearchFound', {
                keyword: state.remoteSearch.keyword,
                count: state.remoteSearch.scanning ? state.remoteSearch.found : state.remoteKeys.length,
              })}
              {state.remoteSearch.scanning ? (
                <> · {t('keyBrowser.scanning')}</>
              ) : state.remoteSearch.capped ? (
                <> · {t('keyBrowser.limitReachedRefineKeyword')}</>
              ) : (
                <> · {t('keyBrowser.finishedScanningCurrentDb')}</>
              )}
            </span>
            <span className="spacer" />
            {state.remoteSearch.scanning ? (
              <button className="btn tiny" onClick={stopRemoteSearch}>
                <DialogIcon name="stop" size={11} />
                {t('keyBrowser.stop')}
              </button>
            ) : null}
          </div>
        ) : null}

        {/* 切库 / 换数据集期间旧键列表已失效，整块换成统一风格的加载态 */}
        {switchingDataset ? (
          <div className="loading-state">
            <span className="spinner" />
            <span className="loading-text">{t('keyBrowser.loadingKeyList')}</span>
          </div>
        ) : connected && viewMode === 'tree' ? (
          <>
            {treeNodes.map((node) => (
              <KeyTreeNode
                key={node.path}
                node={node}
                depth={0}
                separator={separator}
                selectedKey={state.selectedKey}
                collapsed={collapsed}
                selecting={selecting}
                isPicked={isNodePicked}
                isIndeterminate={isNodeIndeterminate}
                onToggle={toggleNode}
                onSelect={handleSelectKey}
                onRemove={handleDeleteKey}
                onPick={togglePickNode}
                onContext={handleNodeContext}
              />
            ))}
            {/* 扫描未完成前不显示空态：列表空 ≠ 没有结果，可能是还没扫到 */}
            {!treeNodes.length && !state.loadingKeys && !remoteScanning ? (
              <p className="placeholder">
                {remoteActive ? (
                  <>
                    {t('keyBrowser.noMatchesAllDatabases')}
                    <br />
                    <span className="hint">{t('keyBrowser.tryAnotherKeywordOrClearFilter')}</span>
                  </>
                ) : (
                  <>
                    {t('keyBrowser.noMatchesCurrentDb')}
                    <br />
                    <span className="hint">{t('keyBrowser.tryBroaderPattern')}</span>
                  </>
                )}
              </p>
            ) : remoteScanning && !treeNodes.length ? (
              <p className="placeholder scan-state">
                <span className="spinner" />
                <span>{t('keyBrowser.scanningAllDatabases')}</span>
              </p>
            ) : null}
          </>
        ) : connected ? (
          <>
            {/* 虚拟滚动 spacer：撑起窗口上方的高度，滚动条与全量渲染一致 */}
            {displayKeys.length ? (
              <div className="flat-spacer" aria-hidden="true" style={{ height: `${flatStart * FLAT_ROW_H}px` }} />
            ) : null}
            {visibleFlatKeys.map((item) => (
              <div
                key={item.key}
                className={`key-item${item.key === state.selectedKey ? ' active' : ''}${
                  selecting && isPicked(item.key) ? ' picked' : ''
                }`}
                onClick={() => handleFlatClick(item)}
                onContextMenu={(event) => handleFlatContext(item, event)}
              >
                {selecting ? (
                  <label className="pick-box" onClick={(event) => event.stopPropagation()}>
                    <input type="checkbox" checked={isPicked(item.key)} onChange={() => togglePick(item.key)} />
                  </label>
                ) : null}
                <span className={`type-badge type-${item.type}`} {...tipProps(typeLabel(item.type))}>
                  {typeAbbr(item.type)}
                </span>
                <span className="key-name mono ellipsis" {...tipProps(item.key)}>
                  {item.key}
                </span>
                <LiveTtl className="ttl mono" ttl={item.ttl} ttlAt={ttlAtOf(item)} />
                <button
                  className="del-btn"
                  {...tipProps(t('common.deleteThisKey'))}
                  onClick={(event) => {
                    event.stopPropagation()
                    void deleteKeys([item.key])
                  }}
                >
                  <DialogIcon name="cancel" size={11} />
                </button>
              </div>
            ))}
            {displayKeys.length ? (
              <div
                className="flat-spacer"
                aria-hidden="true"
                style={{ height: `${(displayKeys.length - flatEnd) * FLAT_ROW_H}px` }}
              />
            ) : null}
            {/* 扫描未完成前不显示空态：列表空 ≠ 没有结果，可能是还没扫到 */}
            {!displayKeys.length && !state.loadingKeys && !remoteScanning ? (
              <p className="placeholder">
                {remoteActive ? (
                  <>
                    {t('keyBrowser.noMatchesAllDatabases')}
                    <br />
                    <span className="hint">{t('keyBrowser.tryAnotherKeywordOrClearFilter')}</span>
                  </>
                ) : (
                  <>
                    {t('keyBrowser.noMatchesCurrentDb')}
                    <br />
                    <span className="hint">{t('keyBrowser.tryBroaderPattern')}</span>
                  </>
                )}
              </p>
            ) : remoteScanning && !displayKeys.length ? (
              <p className="placeholder scan-state">
                <span className="spinner" />
                <span>{t('keyBrowser.scanningAllDatabases')}</span>
              </p>
            ) : null}
          </>
        ) : (
          <p className="placeholder">{t('keyBrowser.selectConnectionFirst')}</p>
        )}
      </div>

      <footer className="list-foot">
        <span className="mono loaded">
          {t('keyBrowser.loadedCount', { count: state.keys.length })}
          {currentDbKeys ? <> / {currentDbKeys}</> : null}
        </span>
        <span className="spacer" />
        {state.loadingKeys ? (
          <span className="mono scanning">{t('keyBrowser.scanning')}</span>
        ) : state.refreshingKeys ? (
          <span className="mono scanning">{t('keyBrowser.refreshing')}</span>
        ) : remoteActive ? (
          state.remoteSearch?.scanning ? (
            <span className="mono scanning">{t('keyBrowser.scanningAllDatabasesShort')}</span>
          ) : (
            <span className="mono done">{t('keyBrowser.searchResultsCount', { count: state.remoteKeys.length })}</span>
          )
        ) : connected && state.cursor !== '0' ? (
          <>
            <button className="btn-ghost more" {...tipProps(t('keyBrowser.loadAnotherPage'))} onClick={() => void loadMore()}>
              <DialogIcon name="add" size={12} />
              {t('keyBrowser.loadMore')}
            </button>
            <button className="btn-ghost more" {...tipProps(t('keyBrowser.keepLoadingUntilEnd'))} onClick={() => void loadAll()}>
              <DialogIcon name="arrow-down" size={12} />
              {t('keyBrowser.loadAll')}
            </button>
          </>
        ) : connected && state.keys.length ? (
          <span className="mono done">{t('keyBrowser.allLoaded')}</span>
        ) : null}
      </footer>

      {createVisible ? (
        <CreateKeyDialog
          prefix={createPrefix || undefined}
          separator={separator}
          onClose={handleCreateClose}
          onCreated={(key) => void handleCreated(key)}
        />
      ) : null}

      {/* 键右键菜单：树形与平铺共用同一份，避免递归节点各挂一个浮层 */}
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
                  {menuHead && !menuHead.isSubtree ? (
                    <span className={`type-badge type-${menuHead.type}`} {...tipProps(typeLabel(menuHead.type))}>
                      {typeAbbr(menuHead.type)}
                    </span>
                  ) : (
                    <DialogIcon name="folder" size={13} className="km-prefix-icon" />
                  )}
                  <span className="mono ellipsis" {...tipProps(menuHead?.key ?? '')}>
                    {menuHead?.key}
                  </span>
                </div>

                {menuHead && !menuHead.isSubtree ? (
                  <>
                    <button className="km-item" onClick={() => runSingleKeyAction(menuViewValue)}>
                      <DialogIcon name="eye" size={14} className="km-icon" />
                      <span>{t('keyBrowser.viewValue')}</span>
                    </button>

                    <div className="km-group">{t('common.copy')}</div>
                    <button className="km-item" onClick={() => runSingleKeyAction((item) => void menuCopyName(item))}>
                      <DialogIcon name="text" size={14} className="km-icon" />
                      <span>{t('common.copyKeyName')}</span>
                    </button>
                    <button className="km-item" onClick={() => runSingleKeyAction((item) => void menuCopyValue(item))}>
                      <DialogIcon name="copy" size={14} className="km-icon" />
                      <span>{t('keyBrowser.copyKeyValue')}</span>
                    </button>
                    <button className="km-item" onClick={() => runSingleKeyAction((item) => void menuCopyCommand(item))}>
                      <DialogIcon name="terminal" size={14} className="km-icon" />
                      <span>{t('keyBrowser.copyCommand')}</span>
                    </button>

                    <div className="km-group">{t('keyBrowser.manage')}</div>
                    <button className="km-item" onClick={() => runSingleKeyAction(menuRename)}>
                      <DialogIcon name="edit" size={14} className="km-icon" />
                      <span>{t('common.renameKey')}</span>
                    </button>
                    <button className="km-item" onClick={() => runSingleKeyAction(menuSetTtl)}>
                      <DialogIcon name="clock" size={14} className="km-icon" />
                      <span>{t('common.setTtl')}</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button className="km-item" onClick={() => runPrefixAction(menuCreateUnder)}>
                      <DialogIcon name="add" size={14} className="km-icon" />
                      <span>{t('keyBrowser.addNewKey')}</span>
                    </button>

                    <div className="km-group">{t('common.copy')}</div>
                    <button className="km-item" onClick={() => runPrefixAction((node) => void menuCopyPrefix(node))}>
                      <DialogIcon name="text" size={14} className="km-icon" />
                      <span>{t('keyBrowser.copyPrefix')}</span>
                    </button>
                    <button className="km-item" onClick={() => runPrefixAction((node) => void menuCopySubtreeKeys(node))}>
                      <DialogIcon name="copy" size={14} className="km-icon" />
                      <span>{t('keyBrowser.copyAllKeyNames')}</span>
                    </button>
                  </>
                )}

                <div className="km-sep" />

                <button className="km-item danger" onClick={() => runKeyMenuAction((target) => void menuDelete(target))}>
                  <DialogIcon name="trash" size={14} className="km-icon" />
                  <span>
                    {menuHead?.isSubtree
                      ? t('common.bulkDeleteCountKeys', { count: menuHead.count })
                      : t('common.deleteKey')}
                  </span>
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}

      {/* 重命名键 */}
      {renameTarget ? (
        <PromptDialog
          title={t('common.renameKey')}
          label={t('common.newKeyName')}
          initialValue={renameTarget.key}
          placeholder={t('common.enterNewKeyName')}
          hint={t('keyBrowser.renamingPreservesOriginalTtlValue')}
          confirmText={t('common.rename')}
          onConfirm={(next) => void handleRenameConfirm(next)}
          onCancel={() => setRenameTarget(null)}
        />
      ) : null}

      {/* 设置 TTL */}
      {ttlTarget ? (
        <PromptDialog
          title={t('common.setTtl')}
          label={t('keyBrowser.timeLive')}
          initialValue={ttlTarget.ttl > 0 ? String(ttlTarget.ttl) : ''}
          placeholder={t('keyBrowser.blank0MeansNoExpiration')}
          hint={t('keyBrowser.enter0LeaveBlankRemove')}
          confirmText={t('keyBrowser.apply')}
          onConfirm={(next) => void handleTtlConfirm(next)}
          onCancel={() => setTtlTarget(null)}
        />
      ) : null}
    </section>
  )
}

export default KeyBrowser

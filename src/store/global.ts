import { api, isElectron } from '@/api'
import { t } from '@/i18n'
import { settings, settingsHolder, useSettings } from '@/services/settings'
import { defineStore } from '@/store'
import {
  createSession,
  type AppState,
  type BulkAction,
  type BulkTask,
  type CliEntry,
  type ConfirmRequest,
  type RedisSessionApi,
  type SessionSnapshot,
  type Toast,
  type ConnectionItem,
} from './session'
import type {
  CacheConnectionConfig,
  ConnectionStatus,
  MemcachedConnectionState,
  RedisConnectionConfig,
  RedisConnectionState,
} from '@shared/types'

export type {
  AppState,
  BulkAction,
  BulkTask,
  CliEntry,
  ConfirmRequest,
  RedisSessionApi,
  SessionSnapshot,
  Toast,
}
export { renamedKey } from './session'
export type { ConnectionItem } from './session'

/** 全局层状态：连接列表 / 标签栏 / 全局提示 */
export interface GlobalState {
  ready: boolean
  envLabel: string
  connections: ConnectionItem[]
  activeId: string | null
  toast: Toast | null
  confirm: (ConfirmRequest & { resolve: (value: boolean) => void }) | null
  tabs: string[]
  activeTabId: string | null
}

const { save: saveSettings } = useSettings()

/**
 * 运行时环境标签（侧栏 footer 展示）。
 *
 * 文案随语言变化，所以不能在模块加载时就把 t() 的结果定死：设置是异步
 * 读盘的，模块初始化那一刻 locale 还是默认值。这里每次调用都按当前语言
 * 求值，再由下方对 settings 的订阅在读盘完成 / 切换语言后刷新。
 */
function environmentLabel(): string {
  return isElectron ? t('Electron 运行时') : t('浏览器预览（Mock 数据）')
}

export const globalHolder = defineStore<GlobalState>({
  ready: false,
  envLabel: environmentLabel(),
  connections: [],
  activeId: null,
  toast: null,
  confirm: null,
  tabs: [],
  activeTabId: null,
})

export const globalState: GlobalState = globalHolder.store

/* 设置写入（含读盘完成与切换语言）后同步环境标签，保证英文界面下不是中文 */
settingsHolder.subscribe(() => {
  const label = environmentLabel()
  if (globalState.envLabel !== label) globalState.envLabel = label
})

let toastTimer: ReturnType<typeof setTimeout> | null = null

/**
 * toast 停留时长，按类型区分。
 *
 * 原来统一 3200ms：复制这类操作的结果文案较长（"已复制全部内容"），
 * 用户视线还在工具栏上，回神时提示已经消失，等于没反馈。
 * 成功类延长到 5s（够读完一句话），失败类 6.5s ——
 * 错误信息通常更长，且需要用户判断"要不要重试"，多给一点时间。
 */
const TOAST_DURATION: Record<Toast['kind'], number> = {
  ok: 5000,
  err: 6500,
}

function notify(kind: Toast['kind'], text: string): void {
  globalState.toast = { kind, text }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(
    () => {
      globalState.toast = null
    },
    TOAST_DURATION[kind] ?? 5000,
  )
}

function failure(error: unknown, fallback: string): void {
  const text = error instanceof Error ? error.message : fallback
  notify('err', text)
}

/**
 * 请求用户确认高危操作。
 * 关闭「删除键前确认」设置时直接放行，避免增加无谓点击；
 * force 请求（如删除连接）不受该设置影响。
 */
function askConfirm(options: ConfirmRequest): Promise<boolean> {
  if (!options.force && !settings.confirmDelete) return Promise.resolve(true)
  return new Promise((resolve) => {
    globalState.confirm = { ...options, resolve }
  })
}

function resolveConfirm(value: boolean): void {
  const request = globalState.confirm
  globalState.confirm = null
  request?.resolve(value)
}

/* ---------------------------------------------------------------- 标签会话管理 */

/** 打开中的标签会话：key = 连接 id，生命周期与 tabs 数组严格同步 */
const sessions = new Map<string, RedisSessionApi>()

/**
 * 关标签 / 断开时保留的会话快照（仅内存，重启不恢复 —— 开机不自动
 * 连生产库的原则不变，重启后永远从主页开始）。
 */
const snapshots = new Map<string, SessionSnapshot>()

/** 无快照时的初始库号：跟随「最近一个活跃会话」或上次的设置值（跨连接保留库偏好） */
function currentInitialDb(): number {
  const id = globalState.activeTabId
  const active = id ? sessions.get(id) : undefined
  return active?.state.activeDb ?? settings.lastDb ?? 0
}

/**
 * 全库搜索进度监听：模块级注册一次。
 * 主进程 SCAN 循环逐批推 {connectionId, found}，按连接路由到对应会话 ——
 * 多标签下后台标签的扫描进度同样实时更新，与「当前激活哪个标签」无关。
 */
let searchProgressBound = false
function bindSearchProgress(): void {
  if (searchProgressBound) return
  searchProgressBound = true
  api.redis.onSearchProgress((progress) => {
    const session = sessions.get(progress.connectionId)
    if (!session) return
    const rs = session.state.remoteSearch
    if (!rs?.scanning) return
    session.state.remoteSearch = { ...rs, found: progress.found }
  })
}

/**
 * 加载一个（新建的）会话的初始数据：库列表 + 服务端概览 + 键列表，
 * 并在快照记录了选中键时恢复查看状态。
 */
async function hydrateSession(session: RedisSessionApi, restoreKey: string | null): Promise<void> {
  /*
   * 键扫描与「库列表 + 服务端信息」并行。
   *
   * 原来键扫描要等两者都回来才开始：经 SSH 隧道时这是白等 2 个 RTT
   * （每条命令 50–150ms），而用户最先想看到的就是键列表。
   *
   * 并行的安全性：键扫描只依赖 activeId / activeDb / pattern，
   * 都不由那两个请求决定 —— 唯一的耦合是「快照里的库号可能超出本实例
   * 的库数」，因此把那次越界校验改成**在 scan 之后**再兜底（见下），
   * 最坏情况是多扫了一次空库，远小于 2 RTT 的代价。
   */
  const metaReady = Promise.all([session.loadDatabases(), session.loadServerInfo()])
  await Promise.all([metaReady, session.loadKeys(true)])

  /*
   * 校验库序号在目标实例上是否有效：快照里的库号来自上一台实例，
   * 对方库数可能更少，越界就退回 db0，而不是把必然失败的扫描发出去。
   */
  const maxDb = session.state.databases.length
    ? Math.max(...session.state.databases.map((d) => d.db))
    : 0
  if (session.state.activeDb > maxDb) {
    session.state.activeDb = 0
    /* 越界才补扫：并行阶段已按旧库号扫过一次（多为空库），这里纠正一次即可 */
    await session.loadKeys(true)
  }

  /*
   * 快照选中键的恢复：键可能已被删除，先 lookup 确认存在再选中，
   * 避免重开标签的瞬间弹「读取键值失败」的干扰提示。
   */
  if (restoreKey && session.state.activeId) {
    try {
      const res = await api.redis.lookupKey(
        session.state.activeId,
        restoreKey,
        session.state.activeDb,
      )
      if (res.ok && res.data) await session.selectKey(restoreKey)
    } catch {
      /* 键已不存在：静默跳过，快照的其余部分照常恢复 */
    }
  }
}

/**
 * 打开或激活一个连接的标签。
 *
 * - 标签不存在：建会话（带快照恢复）→ 加入标签栏 → 异步加载数据；
 * - 标签已存在：默认只激活（数据都在，切换零成本）；
 *   refresh=true 时强制重载（编辑连接配置后重连的场景）。
 */
function activateOrOpenTab(id: string, options?: { refresh?: boolean }): void {
  let session = sessions.get(id)
  if (!session) {
    const snapshot = snapshots.get(id) ?? null
    session = createSession(id, snapshot, {
      notify,
      failure,
      askConfirm,
      bindSearchProgress,
      initialDb: currentInitialDb(),
    })
    sessions.set(id, session)
    globalState.tabs.push(id)
    void hydrateSession(session, snapshot?.selectedKey ?? null)
  } else if (options?.refresh) {
    void hydrateSession(session, null)
  }
  globalState.activeTabId = id
}

/**
 * 关闭一个连接标签：断开连接、存快照、销毁会话、从标签栏移除。
 * 「关标签 = 用完这个连接」：侧栏连接同步断开（绿点熄灭），
 * 快照保留 —— 下次点连接重连后仍按快照恢复界面。
 * 断开异步静默（不弹 toast）：显式断开（菜单 disconnect）先置状态再走
 * closeTab，到这里已不是 connected，不会二次断开；被动掉线推送到达时
 * closeTab 幂等（标签已移除）。
 */
function closeTab(id: string): void {
  const index = globalState.tabs.indexOf(id)
  if (index < 0) return

  /* 连接还连着就顺手断开：作废在途搜索 + 主进程断开 + 状态回落。
   * 失败静默（连接可能已删 / 已被动断开 / 已在断开中）。 */
  const conn = globalState.connections.find((item) => item.id === id)
  if (conn?.status === 'connected') {
    void api.redis.searchCancel(id)
    void api.connection
      .disconnect(id)
      .then(() => {
        const target = globalState.connections.find((item) => item.id === id)
        if (target) target.status = 'disconnected'
      })
      .catch(() => {})
  }

  const session = sessions.get(id)
  if (session) {
    snapshots.set(id, {
      activeDb: session.state.activeDb,
      pattern: session.state.pattern,
      keyFilter: session.state.keyFilter,
      keyFilterExact: session.state.keyFilterExact,
      selectedKey: session.state.selectedKey,
    })
    session.dispose()
  }
  sessions.delete(id)
  globalState.tabs.splice(index, 1)

  /*
   * 关的是激活标签时，激活右邻（不存在则取末尾）；全部关完回主页。
   * activeId 必须同步 —— 它决定「标签外组件（侧栏高亮 / CLI / 确认弹窗）
   * 读哪个会话」。只改 activeTabId 不改 activeId，会出现
   * 页签已切到 B、侧栏仍高亮 A 的错位。
   */
  if (globalState.activeTabId === id) {
    const next = globalState.tabs[Math.min(index, globalState.tabs.length - 1)] ?? null
    globalState.activeTabId = next
    globalState.activeId = next
  }
}

/**
 * 一致性守卫：清掉「不该存在」的页签。
 *
 * 为什么要保底：关标签的**主路径**有 4 条（主动断开 / 删除连接 / 批量删除 /
 * 主进程被动状态推送），但都是"各自触发各自收"。只要有一条路径因为
 * 时序或异常没跑到，页签就会变成孤儿 —— 左侧连接已断开（灰点）、
 * 右侧页签还在，点进去只会看到空的键列表，用户以为是数据丢了。
 *
 * 判据（只处理确定无争议的情况）：
 *   ① 连接配置已不存在（被删除 / 配置被外部改坏）→ 页签必然无意义；
 *   ② 连接状态为 error（重试耗尽、认证失败等终态）→ 会话已不可用。
 * 注意**不处理** disconnected：用户主动断开时 status 会先变 disconnected，
 * 而 closeTab 正在异步收尾；此处若也收，会和主路径抢同一件事
 * （虽然幂等，但会让"断开后立刻重连"的快照写入时机变得不确定）。
 * reconnecting（connecting）同样跳过 —— 那只是中间态。
 */
function reconcileTabs(): void {
  const doomed: string[] = []
  for (const id of globalState.tabs) {
    const conn = globalState.connections.find((item) => item.id === id)
    if (!conn) {
      doomed.push(id)
      continue
    }
    if (conn.status === 'error') doomed.push(id)
  }
  for (const id of doomed) closeTab(id)
}

/** 切换激活标签（TabBar 点击）；null = 回到固定的主页标签 */
function activateTab(id: string | null): void {
  globalState.activeTabId = id
  globalState.activeId = id
  // 记录偏好（只记、不触发连接），不改 activeId
  persistLastTarget()
  /* 切标签是个高频且低风险的动作，顺带做一次守卫，成本可忽略 */
  reconcileTabs()
}

/**
 * 记录当前激活标签与库号（只记、不触发连接 —— 与「开机不自动连生产库」
 * 的原则一致）。lastDb 让下次打开任何新标签时延续用户的库偏好。
 */
function persistLastTarget(): void {
  const id = globalState.activeTabId
  const session = id ? sessions.get(id) : undefined
  if (!session) {
    void saveSettings({ lastConnectionId: '' })
    return
  }
  void saveSettings({ lastConnectionId: id, lastDb: session.state.activeDb })
}

/**
 * 关闭除 keepId 外的全部连接标签（右键菜单「关闭其他」）。
 * 先把激活切到 keepId 再逐个关闭 —— closeTab 对激活标签有
 * 「激活右邻/末尾」的转移逻辑，批量场景下逐个转移可能中途
 * 落到即将被关的标签上；先固定住结果标签，语义也符合浏览器
 * 惯例（操作完成后留在发起操作的标签上）。
 */
function closeOtherTabs(keepId: string): void {
  if (!globalState.tabs.includes(keepId)) return
  activateTab(keepId)
  for (const id of [...globalState.tabs]) {
    if (id !== keepId) closeTab(id)
  }
}

/**
 * 关闭 id 右侧的全部连接标签（右键菜单「关闭右侧」）。
 * 从尾部逆序关闭：下标不因删除而漂移；若激活标签在被关的
 * 右侧区间里，先切到发起标签（浏览器同款语义）。
 */
function closeTabsToRight(id: string): void {
  const index = globalState.tabs.indexOf(id)
  if (index < 0) return
  const rightIds = globalState.tabs.slice(index + 1)
  if (!rightIds.length) return
  if (rightIds.includes(globalState.activeTabId ?? '')) activateTab(id)
  for (let i = globalState.tabs.length - 1; i > index; i--) {
    closeTab(globalState.tabs[i]!)
  }
}

/* ---------------------------------------------------------------- 连接管理 */

async function bootstrap(): Promise<void> {
  try {
    const res = await api.connection.list()
    if (!res.ok) throw new Error(res.error)
    globalState.connections = res.data.map((item) => ({ ...item, status: 'disconnected' as const }))
  } catch (error) {
    failure(error, t('加载连接列表失败'))
  } finally {
    globalState.ready = true
    /*
     * 连接列表刚从磁盘重新读入：若某个已开标签对应的连接已被外部删除
     * （手改 connections.json / 另一实例删过），这里必须收掉页签，
     * 否则页签指向一个不存在的连接，点进去永远转圈。
     */
    reconcileTabs()
  }
}

async function connect(config: CacheConnectionConfig): Promise<boolean> {
  const index = globalState.connections.findIndex((item) => item.id === config.id)

  /*
   * 凭据解不开时直接给出针对性提示，不发请求。
   *
   * 这类情况（换 Windows 账户 / 重装应用 / safeStorage 密钥变化）下，
   * 密文已经解不出来，password 是空的。若照常发请求，
   * Redis 会返回 "NOAUTH Authentication required"，
   * 用户以为是服务端配置问题，完全想不到是本地密码失效。
   *
   * 提示里明确"重新输入密码"，才指向正确的修复动作。
   */
  if (config.credentialError) {
    notify('err', config.credentialError)
    if (index >= 0) {
      globalState.connections[index] = {
        ...globalState.connections[index]!,
        status: 'error',
        message: config.credentialError,
      }
    }
    return false
  }

  if (index >= 0) {
    globalState.connections[index] = { ...globalState.connections[index]!, status: 'connecting' }
  }

  try {
    const res = await api.connection.connect(config)
    if (!res.ok) throw new Error(res.error)

    /*
     * 返回值不含凭据与部分配置字段，这里按引擎把配置里的原值补回。
     *
     * 曾只补 password：连接一次后 state.connections 里的这条就丢了
     * ssh/sshEnabled → 打开编辑对话框 SSH 表单全空（用户以为没保存上）→
     * 原样再保存一次，磁盘上的 SSH 配置就被抹成 undefined 了。
     * pinned 是同族第 4 例：主进程 identity 挑字段构造返回值，pinned 不在其中，
     * 不补回的话「连接成功」就把置顶悄悄取消（图钉消失、排序回落）。
     *
     * ⚠️ 必须按引擎分支补字段：db/password/tls 只有 Redis 有，
     * 一旦 Memcached 条目被打上 db/password，数据就被污染，界面上还会冒出"db0"。
     * ssh/sshEnabled 则是两种引擎共用的隧道配置，两边都要补回。
     */
    const next: ConnectionItem =
      config.engine === 'memcached'
        ? {
            ...(res.data as MemcachedConnectionState),
            engine: 'memcached',
            poolSize: config.poolSize,
            ssh: config.ssh,
            sshEnabled: config.sshEnabled,
            ...(config.pinned !== undefined ? { pinned: config.pinned } : {}),
          }
        : {
            ...(res.data as RedisConnectionState),
            engine: 'redis',
            password: config.password,
            ssh: config.ssh,
            sshEnabled: config.sshEnabled,
            ...(config.pinned !== undefined ? { pinned: config.pinned } : {}),
          }
    if (index >= 0) globalState.connections[index] = next
    else globalState.connections.push(next)

    if (next.status !== 'connected') {
      notify('err', next.message || t('连接失败'))
      return false
    }

    /*
     * 多标签：连接成功即打开（或激活）该连接的标签页。
     * 库列表 / 服务端信息 / 键列表由 hydrateSession 按会话加载；
     * refresh=true 兼顾「编辑配置后对已连接实例重连」——
     * 标签虽在，数据必须按新连接重新拉一遍。
     */
    activateOrOpenTab(next.id, { refresh: true })
    notify(
      'ok',
      t('已连接 {name} · {engine} {version}', {
        name: next.name,
        engine: next.engine === 'memcached' ? 'Memcached' : 'Redis',
        version: next.version ?? '-',
      }),
    )
    return true
  } catch (error) {
    if (index >= 0) {
      globalState.connections[index] = { ...globalState.connections[index]!, status: 'error' }
    }
    failure(error, t('连接失败'))
    return false
  }
}

async function disconnect(id: string): Promise<void> {
  // 作废该连接的在途全库搜索（真实主进程 disconnect 也会递增令牌，mock 靠这次调用）
  void api.redis.searchCancel(id)
  try {
    await api.connection.disconnect(id)
  } catch (error) {
    /*
     * 主进程断开失败（连接早已消失 / 通道异常）也必须收掉页签：
     * 本地已经不该再展示这个会话，留着页签只会让用户点进一个死连接。
     * 这里只记录不弹错 —— 用户意图是"断开"，目的已达成。
     */
    void error
  } finally {
    const target = globalState.connections.find((item) => item.id === id)
    if (target) target.status = 'disconnected'
    // 标签随会话一起收掉；快照已在 closeTab 里保留，重连即可恢复
    closeTab(id)
  }
  notify('ok', t('已断开连接'))
}

/**
 * 退出前断开全部连接。
 *
 * 与 disconnect 的区别：只做"通知主进程断开"这一件事，不关标签、不改
 * 选中项、不弹 toast —— 窗口马上就没了，这些副作用既看不见也无意义，
 * 反而可能因为中途改 state 触发渲染，在退出路径上白白引入不确定性。
 *
 * 并行发起而不是串行：每个断开都是一次 IPC 往返，10 个连接串行
 * 会有肉眼可见的等待；并行时总耗时取决于最慢的那一个。
 * 全部失败也照常放行 —— 退出的目的是让本地窗口消失，
 * 不能因为某个实例连不上就把用户锁在应用里。
 */
async function disconnectAllForQuit(): Promise<void> {
  const online = globalState.connections.filter((item) => item.status === 'connected')
  if (!online.length) return
  await Promise.all(
    online.map(async (item) => {
      try {
        await api.connection.disconnect(item.id)
      } catch {
        /* 单个失败不影响整体退出，主进程的 before-quit 还会再兜一次 */
      }
    }),
  )
}

/**
 * 点击侧栏连接项：
 * - 已连接：打开 / 激活它的标签（标签被关过则按快照重建）；
 * - 未连接：不动。发起连接由菜单里的 connect 负责 ——
 *   「选中未连接项」在多标签时代不再有界面含义（主区域由标签栏接管）。
 */
function selectConnection(id: string): void {
  const target = globalState.connections.find((item) => item.id === id)
  if (target?.status === 'connected') activateOrOpenTab(id)
}

/** 新增或更新一条连接配置，成功返回 true */
async function saveConnection(config: CacheConnectionConfig): Promise<boolean> {
  try {
    const res = await api.connection.save(config)
    if (!res.ok) throw new Error(res.error)
    await bootstrap()
    return true
  } catch (error) {
    failure(error, t('保存连接失败'))
    return false
  }
}

/** 删除连接配置，并清理它在界面上的残留状态（标签 / 快照） */
async function removeConnection(id: string): Promise<void> {
  try {
    const target = globalState.connections.find((item) => item.id === id)
    if (target?.status === 'connected') {
      await api.connection.disconnect(id)
      /* 先置回落再 closeTab：closeTab 会顺手断开 connected 连接，
       * 这里已断过，不置状态会再发一次 disconnect。 */
      target.status = 'disconnected'
    }

    const res = await api.connection.remove(id)
    if (!res.ok) throw new Error(res.error)

    closeTab(id)
    snapshots.delete(id)
    await bootstrap()
    notify('ok', t('连接已删除'))
  } catch (error) {
    failure(error, t('删除连接失败'))
  }
}

/**
 * 批量删除连接（用户需求：连接列表多选删除）。
 *
 * 与单删的差异是刻意设计：
 *   · 静默循环 —— 逐个 removeConnection 会弹 N 个「连接已删除」toast、
 *     N 次 bootstrap 全量刷新，批量场景下体验崩坏；
 *   · 一次 bootstrap + 一个汇总 toast（成功 N / 失败 M）；
 *   · 单条失败不中断整批（继续删其余），失败名单进汇总提示 ——
 *     批量操作里「删了 8 个挂了 1 个」比「全部中止」更有用。
 */
async function removeConnections(ids: string[]): Promise<void> {
  if (!ids.length) return
  let succeeded = 0
  const failed: string[] = []

  for (const id of ids) {
    try {
      const target = globalState.connections.find((item) => item.id === id)
      if (target?.status === 'connected') {
        await api.connection.disconnect(id)
        target.status = 'disconnected'
      }
      const res = await api.connection.remove(id)
      if (!res.ok) throw new Error(res.error)
      closeTab(id)
      snapshots.delete(id)
      succeeded += 1
    } catch {
      const target = globalState.connections.find((item) => item.id === id)
      failed.push(target?.name ?? id)
    }
  }

  await bootstrap()
  if (failed.length) {
    notify(
      'err',
      t('已删除 {done} 个，失败 {failed} 个：{names}', {
        done: succeeded,
        failed: failed.length,
        names: failed.join('、'),
      }),
    )
  } else {
    notify('ok', t('已删除 {count} 个连接', { count: succeeded }))
  }
}

/** 以现有连接为模板克隆一份（保留密码），便于快速改配置连另一套环境 */
async function cloneConnection(source: ConnectionItem): Promise<void> {
  const base = {
    id: `conn-${Date.now().toString(36)}`,
    name: t('{name} - 副本', { name: source.name }),
    host: source.host,
    port: source.port,
  }

  /*
   * 克隆必须按引擎挑字段。
   * 早先逐字段手写漏掉 ssh/sshEnabled，克隆出的连接走不了隧道；
   * 这里反过来做：每个引擎显式列出它该带的字段，避免
   * "给 Memcached 克隆出一份带 db0 的配置"这种跨引擎污染。
   */
  const cloned: CacheConnectionConfig =
    source.engine === 'memcached'
      ? {
          ...base,
          engine: 'memcached',
          poolSize: source.poolSize,
          // 深拷贝一层：ssh 是对象，直接引用会让两份配置共享同一实例
          ssh: source.ssh ? { ...source.ssh } : undefined,
          sshEnabled: source.sshEnabled,
        }
      : {
          ...base,
          engine: 'redis',
          username: source.username,
          password: source.password,
          db: source.db,
          tls: source.tls,
          // 深拷贝一层：ssh 是对象，直接引用会让两份配置共享同一实例
          ssh: source.ssh ? { ...source.ssh } : undefined,
          sshEnabled: source.sshEnabled,
        }

  if (await saveConnection(cloned)) notify('ok', t('已克隆为「{name}」', { name: cloned.name }))
}

/**
 * 置顶 / 取消置顶。
 *
 * 刻意不调 bootstrap()：它会把全部连接重置为 disconnected，
 * 置顶一个已连接的连接时用户会看到"绿点瞬间熄灭"，误以为连接被掐了。
 * 这里只原位更新目标条目的 pinned，排序由 ConnectionSidebar 的 selector 完成。
 */
async function pinConnection(id: string, pinned: boolean): Promise<void> {
  try {
    const res = await api.connection.setPinned(id, pinned)
    if (!res.ok) throw new Error(res.error)
    const index = globalState.connections.findIndex((item) => item.id === id)
    if (index >= 0) {
      globalState.connections[index] = { ...globalState.connections[index]!, pinned }
    }
    notify('ok', pinned ? t('已置顶') : t('已取消置顶'))
  } catch (error) {
    failure(error, t('设置置顶失败'))
  }
}

/**
 * 拖拽排序：把 drag 项移到显示列表中 target 项的前/后，并持久化。
 *
 * 重排按**显示顺序**（置顶优先）计算，再把整个数组写回 globalState.connections ——
 * 磁盘数组顺序 = 显示顺序。加载时 sortedConnections 做置顶优先稳定排序：
 * 置顶项数组序本就靠前、组内先后不变，重启后还原同一视图。
 * 条目对象只移动引用、不重构，运行时状态（status/latency/pinned）零丢失。
 */
function moveConnection(dragId: string, targetId: string, pos: 'before' | 'after'): void {
  const display = [...globalState.connections].sort(
    (a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false),
  )
  const from = display.findIndex((item) => item.id === dragId)
  if (from < 0) return
  const [moved] = display.splice(from, 1)
  const insertAt = display.findIndex((item) => item.id === targetId)
  if (insertAt < 0) return
  display.splice(insertAt + (pos === 'after' ? 1 : 0), 0, moved!)
  globalState.connections = display
  void reorderConnections(display.map((item) => item.id))
}

/** 排序落盘（connection:reorder）。失败只提示：本地顺序保留，重启后回到磁盘顺序。 */
async function reorderConnections(ids: string[]): Promise<void> {
  try {
    const res = await api.connection.reorder(ids)
    if (!res.ok) throw new Error(res.error)
  } catch (error) {
    failure(error, t('保存排序失败'))
  }
}

/**
 * 「刷新服务端指标」菜单项：目标不是激活标签时先切过去，
 * 再刷新该会话的库列表 / 概览 / 键列表（既已"刷新"，不该留着旧扫描结果）。
 */
async function activateAndRefresh(id: string): Promise<void> {
  const target = globalState.connections.find((item) => item.id === id)
  if (!target || target.status !== 'connected') return

  if (globalState.activeTabId !== id) {
    activateOrOpenTab(id, { refresh: true })
    return
  }

  const session = sessions.get(id)
  if (!session) return
  await Promise.all([session.loadDatabases(), session.loadServerInfo()])
  await session.loadKeys(true)
}

/* ---------------------------------------------------------------- 装配 */

/** 取某连接的会话（标签树内使用） */
export function getSession(connId: string): RedisSessionApi | null {
  return sessions.get(connId) ?? null
}

/** 取当前激活标签的会话；主页态为 null */
export function currentSession(): RedisSessionApi | null {
  const id = globalState.activeTabId
  return id ? (sessions.get(id) ?? null) : null
}

/** 全局动作：连接管理 + 标签栏（会话动作见下） */
export const globalActions = {
  bootstrap,
  connect,
  disconnect,
  selectConnection,
  saveConnection,
  removeConnection,
  removeConnections,
  cloneConnection,
  pinConnection,
  moveConnection,
  disconnectAllForQuit,
  activateAndRefresh,
  resolveConfirm,
  activateTab,
  closeTab,
  closeOtherTabs,
  closeTabsToRight,
  notify,
  askConfirm,
  failure,
}

export type GlobalActions = typeof globalActions

/**
 * 会话动作转发器：函数体执行那一刻才解析当前激活会话并转发参数，
 * 无会话（主页态）时静默返回。
 *
 * 为什么需要转发而不是在组件里直接取会话：
 * 标签外的组件（CLI 面板、确认弹窗等）在挂载时拿到的若是当时的会话引用，
 * 之后切换标签它不会跟着换，操作永远打到旧连接上。
 */
const SESSION_ACTION_KEYS = [
  'loadDatabases',
  'loadServerInfo',
  'loadKeys',
  'loadMore',
  'loadAll',
  'switchDb',
  'selectKey',
  'markSelected',
  'refreshSelected',
  'dropElementLocally',
  'insertElementLocally',
  'replaceElementLocally',
  'renameFieldLocally',
  'deleteKeys',
  'openBulkTask',
  'runBulkTask',
  'cancelBulkTask',
  'closeBulkTask',
  'saveValue',
  'setTtl',
  'renameKey',
  'runCli',
  'clearCli',
  'stopRemoteSearch',
  'searchCurrentDb',
  'resetRemoteSearch',
  'setKeyFilterExact',
] as const

export type SessionActionKey = (typeof SESSION_ACTION_KEYS)[number]

export const sessionActions = Object.fromEntries(
  SESSION_ACTION_KEYS.map((key) => [
    key,
    (...args: unknown[]) => {
      const session = currentSession()
      if (!session) return Promise.resolve()
      const fn = (session as unknown as Record<string, (...a: unknown[]) => unknown>)[key]
      return fn(...args)
    },
  ]),
) as unknown as { [K in SessionActionKey]: (...args: any[]) => any }

/** 全局层派生：已连接列表 */
export function onlineConnections(): ConnectionItem[] {
  return globalState.connections.filter((item) => item.status === 'connected')
}

/** 全局层的 activeConnection（按激活标签计算） */
export function globalActiveConnection(): ConnectionItem | null {
  return globalState.connections.find((item) => item.id === globalState.activeId) ?? null
}

/* ---------------------------------------------------------------- 被动状态推送 */

/*
 * 连接被动状态变化（服务端重启、网络闪断、自动重连）：
 * 主进程通过 ioredis 生命周期事件推送，这里同步到左侧连接列表。
 * 没有这条链路，绿点只会在用户主动操作时更新 ——
 * 用户以为连接正常，直到下一次读写报错才发现早就断了。
 *
 * 进入终态断开（disconnected / error）时连标签一起收掉：
 * 会话数据已不可用，留着只会误导（reconnecting 期间不收，等结果）。
 */
if (isElectron) {
  api.connection.onStatusChange((payload) => {
    const target = globalState.connections.find((item) => item.id === payload.id)
    if (!target) return
    target.status = payload.status
    target.message = payload.message
    /*
     * 终态（disconnected / error）收标签。
     * error 是"重试耗尽/认证失败"这类不可自愈的终态，必须收；
     * disconnected 是用户主动断开或对端正常关闭，也收（快照已保留，
     * 重连能恢复界面）。connecting（重连中）不收，等最终结果。
     */
    if (payload.status === 'disconnected' || payload.status === 'error') closeTab(payload.id)
    /* 兜底：本轮推送可能只是"最后一条"，仍有别的孤儿页签（多标签并发断开） */
    reconcileTabs()
  })
}

import { api } from '@/api'
import { settings } from '@/services/settings'
import { defineStore, type AppStore } from '@/store'
import { renamedKey } from '@/utils/renamedKey'
import type {
  ConnectionStatus,
  DatabaseInfo,
  RedisConnectionConfig,
  KeyValue,
  RedisKeyItem,
  ServerInfo,
} from '@shared/types'

/** 界面使用的连接条目：在配置基础上叠加运行时状态 */
export interface ConnectionItem extends RedisConnectionConfig {
  status: ConnectionStatus
  message?: string
  version?: string
  mode?: string
  latency?: number
  sshHost?: string
}

export interface CliEntry {
  kind: 'input' | 'output' | 'error'
  text: string
  costMs?: number
}

export interface Toast {
  kind: 'ok' | 'err'
  text: string
}

/** 需要用户确认的高危操作请求 */
export interface ConfirmRequest {
  title: string
  /** 简要说明（面向人的一句话）；与 details / preview 可并存 */
  message: string
  confirmText?: string
  /**
   * 结构化明细：键名、位置、大小等。
   * 用键值对而非拼成长文本，界面才能对「标签」与「值」分别着色，
   * 让用户一眼抓住重点，而不是面对一大段同色文字。
   */
  details?: Array<{
    label: string
    value: string
    /** 宽格展示（键名、位置等数据类值） */
    mono?: boolean
    tone?: 'normal' | 'danger' | 'muted'
  }>
  /** 待操作内容的预览（如待删元素内容），单独区块展示 */
  preview?: { label: string; text: string; truncated?: boolean }
  /** 不可逆等风险提示，用醒目色单独成行 */
  warning?: string
  /**
   * 需要精确输入的确认短语。
   * 用于不可逆操作（如 FLUSHALL）：用户必须完整输入该短语才能提交，
   * 从机制上排除"手滑点确认"的可能。
   */
  requirePhrase?: string
  /** 危险级：确认按钮使用强调样式 */
  danger?: boolean
  /**
   * 无条件弹确认（默认 false）。
   * 默认受设置「删除键前确认」控制：关闭时直接放行，服务高频键删除工作流。
   * 连接删除这类低频且代价高的操作应置 true —— 删掉的是整套配置
   * （含 SSH、密码），设置开关不该波及它。
   */
  force?: boolean
}

/** 批量操作类型：删除键 / 统一设置 TTL / 前缀替换重命名 */
export type BulkAction = 'delete' | 'ttl' | 'rename'

/**
 * 批量操作任务。
 *
 * 三种操作共用一套任务结构（清单 / 进度 / 失败记录 / 中止），
 * 差异只在执行分支与参数：ttl 携带目标秒数，rename 携带前缀替换规则。
 */
export interface BulkTask {
  action: BulkAction
  /** 待处理的键（含元信息，便于展示类型与 TTL） */
  items: RedisKeyItem[]
  /** 已处理数量（无论成功失败都计入，用于进度条） */
  done: number
  /** 已成功的键名（删除 / 已设置 / 已重命名，统一记成功） */
  succeeded: string[]
  /** 处理失败的键名与原因 */
  failed: Array<{ key: string; reason: string }>
  /** 是否正在执行 */
  running: boolean
  /** 是否已取消 */
  cancelled: boolean
  /** ttl：目标秒数，-1 表示移除过期（转永久） */
  ttlSeconds: number
  /** rename：被替换的原前缀，留空 = 给所有键添加新前缀 */
  renameFrom: string
  /** rename：替换成的新前缀 */
  renameTo: string
}

/** 会话状态：一个标签页独占一份 */
export interface RedisState {
  ready: boolean
  envLabel: string
  activeId: string | null
  databases: DatabaseInfo[]
  activeDb: number
  keys: RedisKeyItem[]
  cursor: string
  pattern: string
  loadingKeys: boolean
  /**
   * 当前 `keys` 数组**属于哪个数据集**（`连接|库|模式`）。
   *
   * 为什么需要这个标记：
   * 切库时 activeDb 会先变、keys 后换，两者之间存在一个窗口 ——
   * 此窗口内 activeDb 已是新值，keys 还是旧库的。任何"跟随 activeDb 计算"的逻辑
   * （树形折叠态、键数量统计）在这个窗口里算出来的都是错的。
   * 界面据此判断"数据是否已经换过来"，而不是靠 loading 标志去猜 ——
   * loading 标志只说明"有没有请求在飞"，不说明"手上的数据属于谁"。
   */
  keysDataset: string
  keyFilter: string
  /**
   * 键搜索精确模式（输入框内的复选框）：
   * true 时本地筛选与全库兜底都按「键名全等」匹配，而不是子串包含。
   * 与 keyFilter 一样属于操作偏好，跨连接保留，不参与断开清理。
   */
  keyFilterExact: boolean
  /**
   * 全库搜索：显式触发（查询图标 / 回车），SCAN 循环整体下沉主进程
   * （redis:searchAll 一次调用），结果存 remoteKeys。
   *
   * found 是扫描中的实时命中数（主进程逐批推送），完成后与 remoteKeys.length 一致。
   *
   * 为什么单独存而不写进 keys：keys 是「已加载列表」，被搜索结果
   * 替换后用户清空筛选词就回不去原列表了；分开存则双向切换零成本。
   */
  remoteSearch: { keyword: string; scanning: boolean; done: boolean; capped: boolean; found: number } | null
  remoteKeys: RedisKeyItem[]
  selectedKey: string | null
  selectedValue: KeyValue | null
  loadingValue: boolean
  /** 刷新当前键（键未变）：值区叠加轻量 loading，不走骨架屏 */
  refreshingValue: boolean
  serverInfo: ServerInfo | null
  cliEntries: CliEntry[]
  cliRunning: boolean
  toast: Toast | null
  /** 待确认的高危操作；由 ConfirmDialog 渲染并回填结果 */
  confirm: (ConfirmRequest & { resolve: (value: boolean) => void }) | null
  /**
   * 批量操作任务（删除 / 设置 TTL / 重命名）。非空时值区让位给 BulkOpsPanel。
   *
   * 大量键（阈值以上）不再塞进确认弹窗：弹窗只能展示前 30 条，
   * 1000 个键既看不清也核对不了，还容易误点确认。
   * 改为在值区开一个独立面板，能滚动浏览、搜索筛选、逐个执行看进度。
   */
  bulkTask: BulkTask | null
}

/**
 * 应用级状态形状（多标签架构）：
 * 全局层与每个标签的会话层共用同一接口 —— 组件拿到的永远是
 * 「本标签的会话」或回退到「全局」，类型完全一致，消费方零改动。
 *
 * - 全局层：ready / envLabel / connections / toast / confirm +
 *   标签栏（tabs / activeTabId，null 表示主页）。会话字段恒为默认值。
 * - 会话层：activeId 固定为标签连接 id，其余会话字段各自独立；
 *   全局字段（connections 等）在取值时透传到全局层（见 sessionGetters）。
 * - cliHistory / cliHistoryIndex：CLI 输入历史跟随标签。
 */
export interface AppState extends RedisState {
  /**
   * 全局字段的「代理声明」：读取时由 useRedis 转发到全局层。
   * 类型上必须出现在 AppState 里，组件才能直接 state.connections ——
   * 与 Vue 版 reactive getter 透传的消费形态完全一致。
   */
  connections: ConnectionItem[]
  cliHistory: string[]
  cliHistoryIndex: number
  tabs: string[]
  activeTabId: string | null
}

/**
 * 关闭标签 / 断开连接时保留的会话快照（仅内存，重启不恢复）。
 *
 * 记录的是「用户操作到哪了」：选中了哪个库、搜了什么、正在看哪个键。
 * 再次点该连接重连后据此恢复界面（关标签即断开，恢复靠重连）。
 * 树展开、滚动位置等组件本地状态不在此列 —— 快照只还原数据层。
 */
export interface SessionSnapshot {
  activeDb: number
  pattern: string
  keyFilter: string
  keyFilterExact: boolean
  selectedKey: string | null
}

/**
 * 按前缀替换规则计算键的新名字（面板预览与执行共用同一规则）。
 * 实现位于 @/utils/renamedKey（纯函数文件，可被 node 环境单元测试加载）。
 */
export { renamedKey }

/** 「加载全部」的安全上限，避免在超大库上一口气拉取过多数据 */
const LOAD_ALL_LIMIT = 5000

/**
 * 骨架屏最短可感知时长（毫秒）。
 *
 * 本地 / 同主机隧道的 Redis 读值是毫秒级，loadingValue 在一帧内 true→false，
 * 骨架屏根本渲染不出来 —— 用户感知是"点了没反应，值突然蹦出来"。
 * 首次加载（非刷新）补足到该时长，让"点击 → 加载中 → 内容"的反馈链完整。
 * 刷新（silent）不补：自动刷新每 5 秒一次，强制延迟会造成周期性卡顿感。
 *
 * 取值 80ms：实测主进程取值只要 40-50ms（元信息与数据各一次往返），
 * 补足到 80ms 已够骨架屏出现一帧，再多都是纯损耗。
 * 演进：260ms（用户反馈慢）→ 130ms → 80ms。
 * 值区渲染本身有实测：切换键端到端 148-159ms（含这 80ms）。
 */
const MIN_VALUE_SKELETON_MS = 80

/**
 * 删除走批量面板的键数阈值：超过 1 个（即 2 个及以上）就走面板。
 *
 * 语义（2026-10 用户需求反转）：**只有删除单个键才弹确认窗**，
 * 批量删除（≥2 个）一律在值区面板中确认与执行 ——
 * 面板有完整的纵向空间，能搜索、能看进度、能中止，
 * 多键清单在弹窗的小预览区里滚动核对本身就很别扭；
 * 单键保留弹窗是为了那一条「类型 / TTL」元信息核对的高频轻量路径。
 */
const BULK_DELETE_THRESHOLD = 1

/**
 * CLI 的只读命令集合。
 *
 * 目的：CLI 里敲了写命令（SET / DEL / FLUSHDB…）后，键列表与库计数
 * 不会自己变 —— 用户在界面上找不到刚写入的键，会误以为"命令成功但
 * 数据没进去"。因此非只读命令执行后主动刷新。
 * 名单外的命令一律视为写（多刷一次无害，漏刷却会误导）；
 * SELECT 不在此列：切库后必须按新库重扫。
 */
const CLI_READONLY_COMMANDS = new Set([
  'PING', 'ECHO', 'HELLO',
  'GET', 'MGET', 'STRLEN', 'GETRANGE', 'GETBIT', 'SUBSTR',
  'EXISTS', 'TYPE', 'TTL', 'PTTL', 'KEYS', 'SCAN', 'DUMP', 'RANDOMKEY',
  'OBJECT', 'MEMORY', 'INFO', 'DBSIZE', 'TIME', 'LASTSAVE', 'LOLWUT', 'COMMAND',
  'CLIENT', 'CLUSTER', 'SLOWLOG', 'LATENCY', 'MODULE',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HSTRLEN', 'HEXISTS', 'HRANDFIELD', 'HSCAN',
  'LRANGE', 'LINDEX', 'LLEN', 'LPOS',
  'SMEMBERS', 'SISMEMBER', 'SMISMEMBER', 'SCARD', 'SRANDMEMBER', 'SINTER', 'SINTERCARD', 'SUNION', 'SUNIONCARD', 'SDIFF', 'SDIFFCARD', 'SSCAN',
  'ZRANGE', 'ZREVRANGE', 'ZRANGEBYSCORE', 'ZREVRANGEBYSCORE', 'ZRANGEBYLEX', 'ZREVRANGEBYLEX',
  'ZSCORE', 'ZMSCORE', 'ZCARD', 'ZCOUNT', 'ZLEXCOUNT', 'ZRANK', 'ZREVRANK', 'ZRANDMEMBER',
  'GEOPOS', 'GEODIST', 'GEOHASH', 'GEOSEARCH',
  'BITCOUNT', 'BITPOS', 'BITFIELD_RO',
  'XLEN', 'XRANGE', 'XREVRANGE', 'XREAD', 'XINFO',
])

const REMOTE_SEARCH_LIMIT = 1000

/**
 * 会话 state → 内部 store 句柄的登记表。
 * 用 WeakMap 而不是往 state 上挂属性：state 是 Proxy，
 * 挂只读不可配置属性会让经代理的读取直接抛异常（见 createSession 内注释）。
 */
const sessionHolders = new WeakMap<object, AppStore<AppState>>()

function registerSessionHolder(state: AppState, holder: AppStore<AppState>): void {
  sessionHolders.set(state, holder)
}

export function getSessionHolder(state: AppState): AppStore<AppState> | undefined {
  return sessionHolders.get(state)
}

/** 会话工厂依赖的全局工具（由 tabs 层注入，避免循环依赖） */
export interface SessionDeps {
  notify: (kind: Toast['kind'], text: string) => void
  failure: (error: unknown, fallback: string) => void
  askConfirm: (options: ConfirmRequest) => Promise<boolean>
  /** 全库搜索进度监听的绑定入口（模块级注册一次，全局共享） */
  bindSearchProgress: () => void
  /** 无快照时的初始库号（「跨连接保留库偏好」语义的来源值） */
  initialDb: number
}

/** 会话（一个标签）的完整 API */
export interface RedisSessionApi {
  state: AppState
  currentDbKeys: () => number
  filteredKeys: () => RedisKeyItem[]
  loadDatabases: () => Promise<void>
  loadServerInfo: () => Promise<void>
  loadKeys: (reset?: boolean) => Promise<void>
  loadMore: () => Promise<void>
  loadAll: () => Promise<void>
  switchDb: (db: number) => Promise<void>
  selectKey: (key: string, options?: { silent?: boolean }) => Promise<void>
  markSelected: (key: string | null) => void
  refreshSelected: (options?: { silent?: boolean }) => Promise<void>
  dropElementLocally: (match: (item: string, index: number) => boolean) => void
  insertElementLocally: (value: string, index?: number, position?: 'before' | 'after') => void
  replaceElementLocally: (target: { index: number } | { field: string }, value: string) => void
  renameFieldLocally: (from: string, to: string, value: string) => void
  deleteKeys: (keys: string[]) => Promise<void>
  openBulkTask: (action: BulkAction, keys: string[]) => void
  runBulkTask: () => Promise<void>
  cancelBulkTask: () => void
  closeBulkTask: () => void
  saveValue: (
    key: string,
    type: KeyValue['type'],
    payload: string | string[] | Record<string, string>,
    ttlSeconds?: number,
    isNew?: boolean,
  ) => Promise<boolean>
  setTtl: (key: string, seconds: number) => Promise<void>
  renameKey: (key: string, newKey: string) => Promise<void>
  runCli: (command: string) => Promise<void>
  clearCli: () => void
  stopRemoteSearch: () => void
  searchCurrentDb: () => void
  notify: (kind: Toast['kind'], text: string) => void
  askConfirm: (options: ConfirmRequest) => Promise<boolean>
  /** 关闭标签时调用：作废在途请求、中止批量任务 */
  dispose: () => void
  /**
   * 会话字段的「全局透传」表：connections / tabs 等字段的读写都落到全局层。
   * 移植说明：Vue 用 reactive 对象的 getter 实现；store 的 Proxy 无法被
   * getter/setter 替换（整体赋值会断掉响应式），因此改为在读取处合并。
   */
  globals: Pick<AppState, 'ready' | 'envLabel' | 'connections' | 'toast' | 'confirm' | 'tabs' | 'activeTabId'>
}

/**
 * 创建一个标签会话：state.activeId 固定为 connId，
 * 全局字段由 sessionGetters 在读取时合并。
 */
export function createSession(
  connId: string,
  snapshot: SessionSnapshot | null,
  deps: SessionDeps,
): RedisSessionApi {
  const { notify, failure, askConfirm } = deps

  const stateHolder = defineStore<AppState>({
    /* 全局字段：此处的值不参与渲染（读取时由 useRedis 合并全局层），仅为形状完整 */
    ready: false,
    envLabel: '',
    connections: [],
    activeId: connId,
    databases: [],
    activeDb: snapshot?.activeDb ?? deps.initialDb,
    keys: [],
    cursor: '0',
    pattern: snapshot?.pattern ?? '*',
    loadingKeys: false,
    keysDataset: '',
    keyFilter: snapshot?.keyFilter ?? '',
    keyFilterExact: snapshot?.keyFilterExact ?? false,
    remoteSearch: null,
    remoteKeys: [],
    selectedKey: null,
    selectedValue: null,
    loadingValue: false,
    refreshingValue: false,
    serverInfo: null,
    cliEntries: [
      { kind: 'output', text: 'RedisDocter CLI 就绪。输入命令后回车执行，例如 PING / DBSIZE / GET key' },
    ],
    cliRunning: false,
    cliHistory: [],
    cliHistoryIndex: -1,
    bulkTask: null,
    toast: null,
    confirm: null,
    tabs: [],
    activeTabId: null,
  })
  const state = stateHolder.store

  const currentDbKeys = (): number =>
    state.databases.find((item) => item.db === state.activeDb)?.keys ?? 0

  async function loadDatabases(): Promise<void> {
    if (!state.activeId) return
    const res = await api.redis.databases(state.activeId)
    if (!res.ok) return failure(res.error, '读取数据库列表失败')
    state.databases = res.data
  }

  async function loadServerInfo(): Promise<void> {
    if (!state.activeId) return
    const res = await api.redis.info(state.activeId)
    if (!res.ok) return failure(res.error, '读取服务端信息失败')
    state.serverInfo = res.data
  }

  /** 当前数据集身份：连接 + 库 + 匹配模式，必须与界面侧 datasetKey 完全一致 */
  function datasetIdentity(): string {
    return `${state.activeId}|${state.activeDb}|${state.pattern}`
  }

  async function loadKeys(reset = true): Promise<void> {
    if (!state.activeId) return

    /*
     * 固定本次请求所属的数据集。
     *
     * 请求是异步的，回来时 activeId / activeDb / pattern 可能已经变了
     * （用户快速切库、改匹配模式）。若不固化，就会把 A 库的结果
     * 标记成 B 库的数据，界面据此恢复折叠态就会错位。
     */
    const connIdNow = state.activeId
    const db = state.activeDb
    const match = state.pattern
    const identity = `${connIdNow}|${db}|${match}`

    state.loadingKeys = true
    try {
      const res = await api.redis.scan(connIdNow, {
        db,
        cursor: reset ? '0' : state.cursor,
        match,
        count: settings.pageSize,
      })
      if (!res.ok) throw new Error(res.error)

      /*
       * 过期响应直接丢弃。
       *
       * 快速连续切库时，A 库的请求可能比 B 库的晚返回；若照写不误，
       * 界面会显示 B 的库号、A 的键 —— 树结构、键数、折叠态全对不上。
       * 判定用"当前数据集身份是否还等于发起时的身份"，比计数器更直观。
       */
      /*
       * 过期响应丢弃。
       *
       * 注意不能整体 return 掉「数据写入」之外的收尾：这里只丢弃**写入**，
       * loadingKeys 由 finally 复位，否则界面会永久停在「正在加载键列表…」。
       * 首次连接时 activeId 刚由 null 变为连接 id、pattern 可能刚被快照恢复，
       * 期间 identity 会发生一次变化 —— 若把这种"身份刚稳定"的首次响应也丢掉，
       * 用户看到的就是"连上了但列表永远在转圈"。
       * 因此判定放宽为：只有**身份明确指向另一个数据集**时才丢弃。
       */
      const current = datasetIdentity()
      const identityChanged = reset && current !== identity

      /*
       * 身份已变但「键数据仍为空」时照常写入：这属于首次加载的竞态，
       * 丢弃会让界面永久空白；后续合法切换由下一次请求覆盖（reset 会清空并重扫）。
       */
      if (identityChanged && state.keys.length > 0) return

      state.keys = reset ? res.data.keys : [...state.keys, ...res.data.keys]
      state.cursor = res.data.cursor
      /*
       * 只有「全量重置」才更新归属：追加分页（reset=false）时数据仍属同一数据集。
       * 归属写成**发起时**的身份而不是当前身份 —— 数据确实属于发起时的那个数据集。
       */
      if (reset) {
        state.keysDataset = identity
        state.selectedKey = null
        state.selectedValue = null
      }
    } catch (error) {
      failure(error, '扫描键失败')
    } finally {
      state.loadingKeys = false
    }
  }

  async function loadMore(): Promise<void> {
    if (state.cursor === '0') return
    await loadKeys(false)
  }

  /**
   * 连续 SCAN 直到游标归零，把当前匹配模式的键全部拉取到本地。
   * 受 LOAD_ALL_LIMIT 保护：超大库不会被一次性全量加载拖垮界面。
   */
  async function loadAll(): Promise<void> {
    if (!state.activeId || state.cursor === '0') return

    /*
     * 固定连接：循环中途标签被关（dispose 会把 activeId 置 null）时立刻停。
     * 否则后续 scan 全部失败，用户会看到一串"扫描失败"，
     * 还以为库出了问题。
     */
    const connIdNow = state.activeId

    state.loadingKeys = true
    try {
      let cursor = state.cursor
      const seen = new Set(state.keys.map((item) => item.key))

      while (cursor !== '0' && state.keys.length < LOAD_ALL_LIMIT) {
        if (state.activeId !== connIdNow) break
        const res = await api.redis.scan(connIdNow, {
          db: state.activeDb,
          cursor,
          match: state.pattern,
          count: settings.pageSize,
        })
        if (!res.ok) throw new Error(res.error)

        for (const item of res.data.keys) {
          if (seen.has(item.key)) continue
          seen.add(item.key)
          state.keys.push(item)
        }
        cursor = res.data.cursor
        state.cursor = cursor
      }
    } catch (error) {
      failure(error, '加载全部失败')
    } finally {
      state.loadingKeys = false
    }
  }

  async function switchDb(db: number): Promise<void> {
    state.activeDb = db
    await loadKeys(true)
  }

  /**
   * 仅标记选中，不读取值。
   *
   * 用于右键唤出菜单的场景：用户此时只是想看看有哪些操作，
   * 若顺手触发一次网络请求，会产生"右键一下就转圈"的干扰。
   * 真正要查看值，可在菜单里点「查看值」（走 selectKey）。
   */
  function markSelected(key: string | null): void {
    state.selectedKey = key
  }

  /**
   * selectKey 的竞态令牌。
   *
   * 快速连点两个键时两次取值请求并发：若 A 的响应后到，会覆盖掉 B 的值
   * （selectedKey 已是 B，内容却是 A 的），且 A 的 finally 会把 B 正在展示的
   * 骨架屏提前撤掉。每次 selectKey 递增序号，过期响应（序号不再是最新）
   * 一律静默丢弃，loading 状态只由最新一次管理。
   */
  let valueLoadSeq = 0

  async function selectKey(key: string, options?: { silent?: boolean }): Promise<void> {
    if (!state.activeId) return
    const seq = ++valueLoadSeq
    state.selectedKey = key

    /*
     * silent 用于「刷新当前键」：键没有变，只是重新读取内容。
     * 此时不该走骨架屏 —— 骨架屏是「内容将整块替换」的信号，
     * 用于刷新会让人误以为切换了键，也会让界面无谓地闪一下。
     * 改为轻量刷新态，由界面在值区叠加一层半透明 loading 即可。
     */
    if (options?.silent) state.refreshingValue = true
    else state.loadingValue = true

    const startedAt = Date.now()
    try {
      const res = await api.redis.value(state.activeId, key)
      if (seq !== valueLoadSeq) return
      if (!res.ok) throw new Error(res.error)

      // 骨架屏补足最短时长（仅首次加载；期间又点了别的键则交给新请求）
      if (!options?.silent) {
        const elapsed = Date.now() - startedAt
        if (elapsed < MIN_VALUE_SKELETON_MS) {
          await new Promise((resolve) => setTimeout(resolve, MIN_VALUE_SKELETON_MS - elapsed))
          if (seq !== valueLoadSeq) return
        }
      }

      state.selectedValue = res.data
    } catch (error) {
      if (seq !== valueLoadSeq) return
      state.selectedValue = null
      failure(error, '读取键值失败')
    } finally {
      // 过期请求不得动 loading —— 它属于最新一次 selectKey
      if (seq === valueLoadSeq) {
        state.loadingValue = false
        state.refreshingValue = false
      }
    }
  }

  /**
   * 重新读取当前选中的键。
   * @param silent 用于「刷新」场景：不触发骨架屏，改由值区叠加轻量 loading
   */
  async function refreshSelected(options?: { silent?: boolean }): Promise<void> {
    if (state.selectedKey) await selectKey(state.selectedKey, options)
    state.keys = state.keys.map((item) => ({ ...item }))
  }

  /**
   * 本地重命名 hash 字段（连同新值一起写入），避免整表重读。
   *
   * 字段名变更在服务端等价于 HDEL 旧 + HSET 新，
   * 因此本地也按「删除旧键、按原顺序插入新键」处理 ——
   * 直接改 record 的 key 会把字段挪到末尾，与用户预期的位置不符。
   */
  function renameFieldLocally(from: string, to: string, value: string): void {
    const current = state.selectedValue
    if (!current || Array.isArray(current.value) || !current.value) return

    const record = current.value as Record<string, string>
    if (!(from in record)) return

    const next: Record<string, string> = {}
    for (const [field, val] of Object.entries(record)) {
      if (field === from) next[to] = value
      else next[field] = val
    }

    state.selectedValue = { ...current, value: next }
  }

  /**
   * 本地替换元素内容（list 改元素值 / hash 改字段值），避免整表重读。
   *
   * 改动结果完全可预期（新值来自用户输入、目标位置已知），
   * 无需回读服务端。list 按真实下标定位，hash 按字段名定位。
   */
  function replaceElementLocally(
    target: { index: number } | { field: string },
    value: string,
  ): void {
    const current = state.selectedValue
    if (!current) return

    if (Array.isArray(current.value) && 'index' in target) {
      const items = [...current.value]
      if (target.index < 0 || target.index >= items.length) return
      items[target.index] = value
      state.selectedValue = { ...current, value: items }
      return
    }

    if (current.value && typeof current.value === 'object' && 'field' in target) {
      const record = { ...(current.value as Record<string, string>) }
      if (!(target.field in record)) return
      record[target.field] = value
      state.selectedValue = { ...current, value: record }
    }
  }

  /**
   * 本地插入元素（list 的追加 / 指定位置插入），避免整表重读。
   *
   * 与 dropElementLocally 同样的理由：refreshSelected() 会让界面闪骨架屏。
   * 插入的结果是可确定的 —— 内容由用户输入、位置由操作语义给定，
   * 因此不需要回读服务端。用 splice 保持与 Redis 一致的插入语义：
   * before 插在目标下标之前，after 插在其后。
   */
  function insertElementLocally(value: string, index?: number, position: 'before' | 'after' = 'after'): void {
    const current = state.selectedValue
    if (!current || !Array.isArray(current.value)) return

    const items = [...current.value]
    // 未指定 index（或超出范围）即追加到末尾
    const at = index == null || index >= items.length
      ? items.length
      : position === 'before'
        ? index
        : index + 1

    items.splice(at, 0, value)

    state.selectedValue = {
      ...current,
      value: items,
      length: items.length,
    }
    state.keys = state.keys.map((item) => ({ ...item }))
  }

  /**
   * 本地移除已删除的元素，避免整表重读。
   *
   * 为什么需要：refreshSelected() 会走一遍 selectKey，把 loadingValue 置为 true，
   * 界面于是闪出骨架屏 —— 明明只删了一行，却像整页重新加载。
   * 这里直接改动 selectedValue：同步移除元素、更新 length、
   * 让 hash / list 的行数据即时收敛，不产生任何 IPC 往返。
   *
   * 只用于「删除」这类结果可预期的确定性操作；新增 / 修改涉及服务端计算
   * （如 zset 的 score 规范化）时仍应回读，避免本地状态与服务端不一致。
   */
  function dropElementLocally(match: (item: string, index: number) => boolean): void {
    const current = state.selectedValue
    if (!current) return

    if (Array.isArray(current.value)) {
      const next = current.value.filter((item, index) => !match(item, index))
      if (next.length === current.value.length) return

      state.selectedValue = {
        ...current,
        value: next,
        // 最后一个元素被删除时 Redis 会连带移除键，此处保持 length 与实际一致
        length: next.length,
      }
      state.keys = state.keys.map((item) => ({ ...item }))
      return
    }

    if (current.value && typeof current.value === 'object') {
      const record = { ...(current.value as Record<string, string>) }
      let removed = false
      Object.keys(record).forEach((field, index) => {
        if (match(field, index)) {
          delete record[field]
          removed = true
        }
      })
      if (!removed) return

      state.selectedValue = {
        ...current,
        value: record,
        length: Object.keys(record).length,
      }
      state.keys = state.keys.map((item) => ({ ...item }))
    }
  }

  /**
   * 直接把一批键装进批量操作面板（不等用户点「执行」）。
   *
   * 与 `deleteKeys` 的区别：它不看数量阈值。勾选操作是用户主动圈选的行为，
   * 勾 2 个也是明确要"逐个处理并看得见过程"，此时退回小确认框反而打断了他
   * 刚建立的操作预期（他刚刚才在列表里一个个勾选）。
   */
  function openBulkTask(action: BulkAction, keys: string[]): void {
    if (!state.activeId || !keys.length) return
    const targets = keys
      .map((key) => state.keys.find((item) => item.key === key))
      /* keys 可能包含已从列表移除的键，兜底构造一个最小元信息 */
      .map((item, index) => item ?? { key: keys[index]!, type: 'none' as const, ttl: -1 })

    state.bulkTask = {
      action,
      items: targets,
      done: 0,
      succeeded: [],
      failed: [],
      running: false,
      cancelled: false,
      ttlSeconds: 3600,
      renameFrom: '',
      renameTo: '',
    }
    // 面板占满值区，清掉当前选中避免左侧仍高亮一个即将被处理的键
    state.selectedKey = null
    state.selectedValue = null

    /*
     * 尊重「删除键前确认」设置：关闭时与单键删除一样立即执行，
     * 只是过程放到面板里展示（1000 个键逐个处理需要时间和可见反馈）。
     * 否则会出现"设了不确认、批量却还要确认一次"的不一致。
     * TTL 与重命名不是破坏性操作，不适用该设置，始终等用户确认参数后执行。
     */
    if (action === 'delete' && !settings.confirmDelete) {
      // 等一帧让面板先渲染出来，用户能看到进度从 0 开始推进
      void Promise.resolve().then(() => runBulkTask())
    }
  }

  /*
   * 列表同步：state.keys（已加载）与 state.remoteKeys（全库搜索结果）
   * 是平铺与树形共同的展示来源（KeyBrowser 的 displayKeys 优先取 remoteKeys）。
   * 键删除 / 改 TTL / 重命名成功后必须两处同步——只改 state.keys 时，
   * 搜索态下的列表与树不会更新（键删了还挂着、TTL 与键名不回写）。
   */
  function syncRemove(keys: string[]): void {
    state.keys = state.keys.filter((entry) => !keys.includes(entry.key))
    if (state.remoteKeys.length) {
      state.remoteKeys = state.remoteKeys.filter((entry) => !keys.includes(entry.key))
    }
  }

  function syncPatch(key: string, patch: (entry: RedisKeyItem) => RedisKeyItem): void {
    state.keys = state.keys.map((entry) => (entry.key === key ? patch(entry) : entry))
    if (state.remoteKeys.length) {
      state.remoteKeys = state.remoteKeys.map((entry) => (entry.key === key ? patch(entry) : entry))
    }
  }

  /** 删除键；默认经过确认弹窗（可在设置中关闭确认） */
  async function deleteKeys(keys: string[]): Promise<void> {
    if (!state.activeId || !keys.length) return

    /*
     * 大批量走独立面板，逻辑与弹窗路径一致（同样需要确认，同样不可撤销），
     * 区别只在于「在哪确认、怎么看清单、怎么显示执行过程」。
     */
    if (keys.length > BULK_DELETE_THRESHOLD) {
      openBulkTask('delete', keys)
      return
    }

    /*
     * 确认框内容按「一句话说明 + 结构化明细 + 预览 + 风险提示」组织，
     * 与 ValueViewer 中删除元素 / 成员的确认框保持同一套规范。
     *
     * 为什么不再把键名拼进 message：
     * 拼接后的长文本只能整段同色显示，用户难以快速核对；
     * 改为 details（数量等元信息）+ preview（待删键名逐行展示）后，
     * 标签与值可以分别着色，界面也更容易扫读。
     */
    const single = keys.length === 1
    /** 目标键的元信息：单键时直接给出类型与 TTL，便于确认删对了对象（搜索态下键可能只在 remoteKeys 里） */
    const target = single
      ? state.keys.find((item) => item.key === keys[0]) ??
        state.remoteKeys.find((item) => item.key === keys[0])
      : undefined

    const PREVIEW_LIMIT = 30
    const shown = keys.slice(0, PREVIEW_LIMIT)
    const truncated = keys.length > PREVIEW_LIMIT

    const details: NonNullable<ConfirmRequest['details']> = [
      { label: single ? '键名' : '数量', value: single ? keys[0]! : `${keys.length} 个键`, mono: true },
    ]
    if (target) {
      details.push({ label: '类型', value: target.type, mono: true })
      details.push({
        label: '过期',
        value: target.ttl > 0 ? `${target.ttl} 秒后` : '永久',
        mono: true,
        tone: 'muted',
      })
    }

    const confirmed = await askConfirm({
      title: single ? '删除键' : `批量删除 ${keys.length} 个键`,
      message: single ? '即将从当前库中移除该键：' : '即将从当前库中移除以下键：',
      details,
      /*
       * 单键不展示 preview：键名已在 details 中给出，
       * 再单独开一块重复显示同一内容反而显得冗余。
       */
      preview: single
        ? undefined
        : {
            label: '待删除的键名',
            text: shown.join('\n'),
            truncated,
          },
      warning: single
        ? '此操作不可撤销，键及其全部数据将被立即删除。'
        : '此操作不可撤销，这些键及其全部数据将被立即删除。',
      confirmText: single ? '删除' : `删除 ${keys.length} 个键`,
      danger: true,
    })
    if (!confirmed) return

    try {
      const res = await api.redis.remove(state.activeId, keys)
      if (!res.ok) throw new Error(res.error)
      notify('ok', res.data.message ?? '已删除')
      syncRemove(keys)
      if (state.selectedKey && keys.includes(state.selectedKey)) {
        state.selectedKey = null
        state.selectedValue = null
      }
      await loadDatabases()
    } catch (error) {
      failure(error, '删除失败')
    }
  }

  /**
   * 执行批量操作（逐个进行，实时更新进度）。
   *
   * 为什么逐个而不是一次 DEL 全部：
   * - 1000 个大 key 一次性删除会让 Redis 长时间阻塞主线程（DEL 是同步的），
   *   线上实例可能因此抖动；
   * - 逐个处理能显示真实进度、支持中途取消，失败也能精确定位到某个键。
   *
   * 三种操作共用这套循环骨架（进度 / 中止 / 失败记录），差异只在每个键做什么：
   * - delete：删除并从左侧列表移出，列表同步收缩；
   * - ttl：EXPIRE / PERSIST 后把列表里的 TTL 改成目标值，左侧即时反映；
   * - rename：按前缀规则算新名，目标名与现有键冲突时主进程会拒绝
   *   （Redis 原生 RENAME 会静默覆盖目标键，那比失败更糟），
   *   替换后没有变化的行直接记成功跳过，不发无谓的请求。
   */
  async function runBulkTask(): Promise<void> {
    const task = state.bulkTask
    if (!task || task.running || !state.activeId) return

    /*
     * 固定本次任务所属的连接。
     * 循环里若直接读 state.activeId，中途标签被关（dispose 置 null），
     * 后面每个请求都失败并被记成"处理失败" —— 用户会看到几百条假失败。
     */
    const connIdNow = state.activeId

    task.running = true
    task.cancelled = false

    for (const item of task.items) {
      // 取消：停止后续处理，已完成的不可回滚
      if (task.cancelled) break

      /*
       * 会话已销毁（标签关闭 / 连接断开）：立即收工。
       * 继续跑只会产生一串"未连接"的失败记录，且任务对象可能已被丢弃。
       */
      if (state.activeId !== connIdNow) {
        task.cancelled = true
        break
      }

      try {
        if (task.action === 'delete') {
          const res = await api.redis.remove(connIdNow, [item.key])
          if (!res.ok) throw new Error(res.error)
          task.succeeded.push(item.key)
          syncRemove([item.key])
        } else if (task.action === 'ttl') {
          const res = await api.redis.setTtl(connIdNow, item.key, task.ttlSeconds)
          if (!res.ok) throw new Error(res.error)
          task.succeeded.push(item.key)
          syncPatch(item.key, (entry) => ({ ...entry, ttl: task.ttlSeconds }))
        } else {
          const next = renamedKey(item.key, task.renameFrom, task.renameTo)
          if (next === item.key) {
            // 前缀未命中 / 替换后无变化：不发起请求，直接记成功
            task.succeeded.push(item.key)
          } else {
            const res = await api.redis.rename(connIdNow, item.key, next)
            if (!res.ok) throw new Error(res.error)
            task.succeeded.push(item.key)
            syncPatch(item.key, (entry) => ({ ...entry, key: next }))
          }
        }
      } catch (error) {
        task.failed.push({
          key: item.key,
          reason: error instanceof Error ? error.message : String(error),
        })
      } finally {
        task.done += 1
      }
    }

    task.running = false

    /*
     * 收尾：成功数大于 0 才刷新库统计，避免全部失败时也白跑一次。
     * 失败项保留在面板里供查看，成功项已在列表中体现。
     */
    if (task.succeeded.length) {
      if (state.selectedKey && task.succeeded.includes(state.selectedKey)) {
        state.selectedKey = null
        state.selectedValue = null
      }
      await loadDatabases()
    }

    if (task.failed.length) {
      notify('err', `${task.failed.length} 个键${verbOf(task.action)}失败，可在面板中查看原因`)
    } else if (!task.cancelled) {
      notify('ok', resultSummary(task))
    }
  }

  /** 操作动词（用于通知文案）：删除 / 设置 TTL / 重命名 */
  function verbOf(action: BulkAction): string {
    if (action === 'delete') return '删除'
    if (action === 'ttl') return '设置'
    return '重命名'
  }

  /** 完成通知：按操作类型给出结果数量 */
  function resultSummary(task: BulkTask): string {
    const count = task.succeeded.length
    if (task.action === 'delete') return `已删除 ${count} 个键`
    if (task.action === 'ttl')
      return task.ttlSeconds < 0 ? `已将 ${count} 个键设为永久` : `已为 ${count} 个键设置 TTL`
    return `已重命名 ${count} 个键`
  }

  /** 中止批量操作（已开始的那一个会执行完） */
  function cancelBulkTask(): void {
    if (state.bulkTask?.running) state.bulkTask.cancelled = true
    else state.bulkTask = null
  }

  /** 关闭批量操作面板 */
  function closeBulkTask(): void {
    if (state.bulkTask?.running) return
    state.bulkTask = null
  }

  async function saveValue(
    key: string,
    type: KeyValue['type'],
    payload: string | string[] | Record<string, string>,
    ttlSeconds?: number,
    isNew = false,
  ): Promise<boolean> {
    if (!state.activeId) return false
    try {
      const res = await api.redis.setValue(state.activeId, key, type, payload, ttlSeconds, isNew)
      if (!res.ok) throw new Error(res.error)
      notify('ok', res.data.message ?? '已保存')
      await Promise.all([loadKeys(true), loadDatabases()])
      await selectKey(key)
      return true
    } catch (error) {
      failure(error, '保存失败')
      return false
    }
  }

  async function setTtl(key: string, seconds: number): Promise<void> {
    if (!state.activeId) return
    try {
      const res = await api.redis.setTtl(state.activeId, key, seconds)
      if (!res.ok) throw new Error(res.error)
      notify('ok', res.data.message ?? 'TTL 已更新')
      await selectKey(key)
    } catch (error) {
      failure(error, '设置 TTL 失败')
    }
  }

  async function renameKey(key: string, newKey: string): Promise<void> {
    if (!state.activeId) return
    try {
      const res = await api.redis.rename(state.activeId, key, newKey)
      if (!res.ok) throw new Error(res.error)
      notify('ok', '已重命名')
      await loadKeys(true)
      await selectKey(newKey)
    } catch (error) {
      failure(error, '重命名失败')
    }
  }

  async function runCli(command: string): Promise<void> {
    const trimmed = command.trim()
    if (!trimmed || !state.activeId) return
    state.cliEntries.push({ kind: 'input', text: trimmed })
    state.cliRunning = true
    try {
      const res = await api.redis.cli(state.activeId, trimmed)
      if (!res.ok) throw new Error(res.error)
      const { output, error, costMs, db } = res.data
      if (error) state.cliEntries.push({ kind: 'error', text: error, costMs })
      else state.cliEntries.push({ kind: 'output', text: output, costMs })

      /*
       * CLI 切库（SELECT / SWAPDB）后同步界面库选择器。
       * 不同步的话：连接实际已在 db2，界面上还显示 db0，
       * 键列表、库计数、后续操作全部错位。
       */
      if (db !== undefined && db !== state.activeDb) state.activeDb = db

      /*
       * 非只读命令（含 SELECT）后刷新键列表与库计数：
       * 让"CLI 写入的数据"立即出现在界面上，而不是要用户手点重扫。
       */
      const cmd = trimmed.split(/\s+/)[0]?.toUpperCase()
      if (!error && cmd && !CLI_READONLY_COMMANDS.has(cmd)) {
        void loadKeys(true)
        void loadDatabases()
      }
    } catch (error) {
      state.cliEntries.push({ kind: 'error', text: error instanceof Error ? error.message : '执行失败' })
    } finally {
      state.cliRunning = false
    }
  }

  function clearCli(): void {
    state.cliEntries.splice(0, state.cliEntries.length)
  }

  /** 会话级全库搜索的竞态令牌（与全局解耦，各标签互不干扰） */
  let remoteSearchSeq = 0

  /**
   * 精确匹配的键名已知：不再全库 SCAN，直接单键查询短路（见 searchKeysAll 开头）。
   */
  async function searchKeysAll(keyword: string): Promise<void> {
    if (!state.activeId) return
    const kw = keyword.trim()
    if (!kw) return

    const seq = ++remoteSearchSeq
    const connIdNow = state.activeId
    const db = state.activeDb
    state.remoteKeys = []
    state.remoteSearch = { keyword: kw, scanning: true, done: false, capped: false, found: 0 }
    deps.bindSearchProgress()

    try {
      /*
       * 精确模式短路：键名已知，单键 TYPE/TTL 一次往返即可命中（O(N)→O(1)），
       * 不必全库 SCAN。键名原样传，无 glob 转义 —— 这不是 MATCH 模式。
       */
      if (state.keyFilterExact) {
        const res = await api.redis.lookupKey(connIdNow, kw, db)
        if (seq !== remoteSearchSeq) return
        if (!res.ok) throw new Error(res.error)
        if (res.data) state.remoteKeys.push(res.data)
        state.remoteSearch = {
          keyword: kw,
          scanning: false,
          done: true,
          capped: false,
          found: state.remoteKeys.length,
        }
        return
      }

      /*
       * 模糊模式：SCAN 循环整体下沉主进程（redis:searchAll）——
       * 旧实现渲染层逐批调 scan IPC，主进程每批都对匹配键做 TYPE/TTL
       * pipeline（批数 × 往返）；现在主进程循环内只取键名（砍逐批
       * TYPE/TTL），结束后对结果集（≤ 1000）一次批量元信息。
       * 进度由主进程逐批推送（bindSearchProgress 更新 found）。
       */
      const res = await api.redis.searchAll(connIdNow, {
        db,
        match: `*${kw}*`,
        limit: REMOTE_SEARCH_LIMIT,
      })
      if (!res.ok) throw new Error(res.error)
      /*
       * 令牌失效分两种：
       *   - 新一轮搜索 / 数据集切换（seq 变化）→ 丢弃结果（return）；
       *   - 用户停止（stopRemoteSearch 不再递增 seq，改走主进程取消令牌）
       *     → cancelled 结果照常接受，保留「已找到的部分」。
       */
      if (seq !== remoteSearchSeq) return
      state.remoteKeys = res.data.keys
      state.remoteSearch = {
        keyword: kw,
        scanning: false,
        done: true,
        capped: res.data.capped,
        found: res.data.keys.length,
      }
    } catch (error) {
      if (seq !== remoteSearchSeq) return
      state.remoteSearch = null
      state.remoteKeys = []
      failure(error, '全库搜索失败')
    }
  }

  /** 显式全库搜索（查询图标 / 回车）：扫当前 db 全部键名，匹配语义随精确开关 */
  function searchCurrentDb(): void {
    const kw = state.keyFilter.trim()
    if (!kw) return
    void searchKeysAll(kw)
  }

  /**
   * 手动停止：通知主进程取消在途扫描（递增主进程令牌，循环下一批即停），
   * 本地立即结束扫描态；已找到的部分由 searchAll 的 cancelled 返回值补齐。
   */
  function stopRemoteSearch(): void {
    if (state.activeId) void api.redis.searchCancel(state.activeId)
    if (state.remoteSearch?.scanning) {
      state.remoteSearch = { ...state.remoteSearch, scanning: false, done: true, capped: false }
    }
  }

  /**
   * 本地筛选。
   * 区分大小写：与 Redis SCAN MATCH（以及整个 Redis 键空间）的语义一致。
   * 曾用 toLowerCase 做不区分匹配，但远程 MATCH 天然区分大小写，
   * 两套结果不一致会造成「本地搜得到、全库搜不到」的错觉。
   */
  function filteredKeys(): RedisKeyItem[] {
    const keyword = state.keyFilter.trim()
    if (!keyword) return state.keys
    if (state.keyFilterExact) return state.keys.filter((item) => item.key === keyword)
    return state.keys.filter((item) => item.key.includes(keyword))
  }

  /*
   * 输入与数据集变化只负责「清掉过期的远程结果」，不发起搜索：
   *   - keyFilter 变化（继续输入）—— 旧词的全库结果已无意义，
   *     取消在途扫描、回到本地即时筛选；
   *   - keysDataset 变化（切库 / 改匹配模式 / 换连接）—— 旧库的结果
   *     不能混进新库的界面。
   * 刷新 / 保存键不会改 keysDataset，远程结果得以保留。
   *
   * 移植说明：Vue 用 watch；React 版由 KeyBrowser 在输入框 onChange 与
   * 数据集变化处调用 resetRemoteSearch()，行为一致且没有隐式副作用。
   */
  function resetRemoteSearch(): void {
    remoteSearchSeq++
    state.remoteSearch = null
    state.remoteKeys = []
  }

  /**
   * 精确开关切换：正处于全库结果态时用新语义自动重搜
   * （用户已明确表达过「要搜全库」，开关只改匹配方式）；
   * 非远程态不做任何事 —— 本地筛选是纯函数，自动响应。
   */
  function setKeyFilterExact(value: boolean): void {
    state.keyFilterExact = value
    const kw = state.keyFilter.trim()
    if (state.remoteSearch && kw) void searchKeysAll(kw)
  }

  /**
   * 会话销毁（关标签 / 断开）：
   * - activeId 置 null：所有「固定连接再比对」的循环与守卫自动失效，
   *   在途请求回来后写的是孤儿 state（无人渲染），且不会再发新请求；
   * - 批量任务标记取消；CLI 运行态复位；
   * - 令牌递增，作废在途搜索。
   */
  function dispose(): void {
    state.activeId = null
    if (state.bulkTask?.running) state.bulkTask.cancelled = true
    state.cliRunning = false
    remoteSearchSeq++
  }

  /*
   * 登记 store 句柄：组件按「本会话」订阅、并需要拿到真实 store 做写入代理。
   *
   * 不能挂在 state 上 —— state 是 Proxy，挂只读不可配置属性后，
   * 经代理读取会触发引擎 invariant 校验（'get' on proxy: property is
   * a read-only and non-configurable data property…），整个渲染崩掉。
   * 改用 WeakMap 登记：对象身份为键、无属性语义，天然绕过 Proxy 陷阱。
   */
  registerSessionHolder(state, stateHolder)

  return {
    state,
    globals: {
      ready: false,
      envLabel: '',
      connections: [],
      toast: null,
      confirm: null,
      tabs: [],
      activeTabId: null,
    },
    currentDbKeys,
    filteredKeys,
    loadDatabases,
    loadServerInfo,
    loadKeys,
    loadMore,
    loadAll,
    switchDb,
    selectKey,
    markSelected,
    refreshSelected,
    dropElementLocally,
    insertElementLocally,
    replaceElementLocally,
    renameFieldLocally,
    deleteKeys,
    openBulkTask,
    runBulkTask,
    cancelBulkTask,
    closeBulkTask,
    saveValue,
    setTtl,
    renameKey,
    runCli,
    clearCli,
    stopRemoteSearch,
    searchCurrentDb,
    resetRemoteSearch,
    setKeyFilterExact,
    notify,
    askConfirm,
    dispose,
  } as RedisSessionApi & { resetRemoteSearch: () => void; setKeyFilterExact: (v: boolean) => void }
}

export type ExtendedSessionApi = ReturnType<typeof createSession>

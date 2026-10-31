/**
 * 主进程 / 预加载 / 渲染进程共用的类型契约。
 * 三方共享同一份定义，避免 IPC 边界上的类型漂移。
 */

/** Redis 值类型 */
export type RedisValueType =
  | 'string'
  | 'hash'
  | 'list'
  | 'set'
  | 'zset'
  | 'stream'
  | 'none'

/** 连接状态 */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/** 连接配置（可持久化） */
/**
 * SSH 隧道配置。
 *
 * 场景：Redis 实例只监听内网 / 回环地址，需要先登录跳板机再访问。
 * 隧道在本机随机端口监听，ioredis 连 `127.0.0.1:<本地端口>`，
 * 由 ssh2 把流量转发到跳板机视角下的 `host:port`。
 */
/**
 * 中间跳板机配置（多级跳板链的一环）。
 * 字段与 SshConfig 的认证部分一致；不含 targetFromRemote（只对最后一跳有意义）。
 */
export interface SshHop {
  host: string
  port: number
  username: string
  authMethod: SshAuthMethod
  password?: string
  privateKey?: string
  passphrase?: string
}

export interface SshConfig {
  /** 跳板机地址（多级跳板时为最后一跳，离 Redis 最近） */
  host: string
  /** 跳板机 SSH 端口，默认 22 */
  port: number
  /** 登录用户名 */
  username: string
  /** 认证方式：密码或私钥 */
  authMethod: SshAuthMethod
  /** 密码认证时的密码 */
  password?: string
  /** 私钥认证时的私钥内容（PEM / OpenSSH 格式全文） */
  privateKey?: string
  /** 私钥口令（私钥本身加密时需要） */
  passphrase?: string
  /**
   * 中间跳板链（堡垒机场景）：
   * 按顺序从本机逐级登录，host/port 字段表示最后一跳。
   * 例如 Redis 在 IDC 内网，路径：本机 → 边界机 A → 堡垒机 B → Redis，
   * 则 hops=[A]，host/port=B 的地址。
   * 每级认证独立配置；未配置（undefined/空数组）时行为与单级跳板完全一致。
   */
  hops?: SshHop[]
  /**
   * 目标地址是否以跳板机视角解析。
   * 绝大多数情况为 true（Redis 在内网，只有跳板机能访问）；
   * 若希望由本机直连、仅借道 SSH 加密，可关闭。
   */
  targetFromRemote?: boolean
}

export type SshAuthMethod = 'password' | 'key'

/**
 * 缓存引擎标识。
 *
 * 为什么要有这个字段：应用同时支持 Redis 与 Memcached，
 * 两者的连接参数、状态结构、可执行命令完全不同。
 * 用判别联合（discriminated union）而不是"一个大而全的可选字段对象"，
 * 是为了让编译器替我们检查分支遗漏 —— 以后新增引擎时，
 * 所有 switch 会立刻报"缺少分支"，而不是在运行期拿到 undefined。
 */
export type CacheEngine = 'redis' | 'memcached'

/**
 * 所有引擎共有的连接字段。
 * 只放"与引擎无关"的东西：标识、名称、地址、置顶。
 * 引擎专属字段一律放在各自的子类型里，避免出现
 * "Memcached 配置里挂着一个永远用不到的 db 字段"这种污染。
 */
export interface BaseConnectionConfig {
  id: string
  name: string
  host: string
  port: number
  /**
   * 是否在连接列表中置顶。只影响渲染排序，不参与连接逻辑。
   *
   * 注意它由专用的 connection:setPinned 通道维护 ——
   * 走普通 save 通道时，编辑对话框的 payload 必须把它带上，
   * 否则「编辑名称保存」会把置顶状态悄悄抹掉。
   */
  pinned?: boolean
  /**
   * 凭据解密失败的原因（仅由主进程在读取配置时回填，不落盘）。
   *
   * 存在这个字段说明：配置文件里的密码密文已经解不开了
   * （换 Windows 账户、重装应用、或 safeStorage 密钥变化）。
   * 界面应提示用户重新输入密码，而不是报笼统的"连接失败"——
   * 后者会让用户怀疑地址填错、服务端挂了，排查方向完全跑偏。
   */
  credentialError?: string
}

/** Redis 连接配置（可持久化） */
export interface RedisConnectionConfig extends BaseConnectionConfig {
  /** 判别字段。旧配置文件没有它，读取时按 'redis' 补齐（见 connection-store） */
  engine: 'redis'
  username?: string
  password?: string
  /** 默认库序号 */
  db: number
  tls?: boolean
  /** SSH 隧道；未设置表示直连 */
  ssh?: SshConfig
  /** 是否启用 SSH 隧道（与 ssh 是否存在分开，便于临时关闭而不丢失配置） */
  sshEnabled?: boolean
}

/**
 * Memcached 连接配置（可持久化）。
 *
 * 与 Redis 的差异：
 *   · 没有 db —— Memcached 不分区，所有 key 共用一个命名空间；
 *   · 没有 username/password —— 标准协议无认证（SASL 是二进制扩展，
 *     主流部署罕用，且 memjs 主要支持文本协议）；
 *   · 没有 TLS —— 项目内不做（如需可后续单独加）；
 *   · 多了 poolSize —— 单线程事件循环下，多个 TCP 连接才能压满吞吐，
 *     默认 4 是常规取值，太小在大并发下成为瓶颈。
 *   · SSH 隧道与 Redis 共用同一套配置结构（本地端口转发不感知上层协议）。
 */
export interface MemcachedConnectionConfig extends BaseConnectionConfig {
  engine: 'memcached'
  /** 连接池大小，默认 4 */
  poolSize?: number
  /** SSH 隧道；未设置表示直连 */
  ssh?: SshConfig
  /** 是否启用 SSH 隧道（与 ssh 是否存在分开，便于临时关闭而不丢失配置） */
  sshEnabled?: boolean
}

/** 任意引擎的连接配置联合类型 —— 界面与持久化层只认这个 */
export type CacheConnectionConfig = RedisConnectionConfig | MemcachedConnectionConfig

/* ---------------------------------------------------------------- 连接导入导出 */

/**
 * 导出选项。
 *
 * 默认不含凭据：导出文件是可读的 JSON，任何人拿到都能看到内容；
 * 凭据必须由用户显式勾选，且界面需要二次确认。
 */
export interface ConnectionExportOptions {
  includeCredentials: boolean
}

export interface ConnectionExportResult {
  /** 用户在保存对话框里取消时为 false */
  saved: boolean
  path?: string
  /** 实际写入文件的连接数 */
  exported: number
  /** 因密文解不开而只能按「无凭据」导出的条数 */
  missingCredentials: number
}

/** 预览里的冲突类型：none 无冲突；id 命中已有连接；name 仅名称重复 */
export type ConnectionImportConflict = 'none' | 'id' | 'name'

export interface ConnectionImportPreviewItem {
  /** 在文件 connections 数组中的下标，用于和 issues 对齐 */
  index: number
  engine: CacheEngine
  name: string
  host: string
  port: number
  username?: string
  db?: number
  tls?: boolean
  poolSize?: number
  sshEnabled: boolean
  sshHost?: string
  sshHopCount?: number
  /** 是否带凭据（只回布尔，绝不把密码 / 私钥交给预览界面） */
  hasPassword: boolean
  hasSshCredential: boolean
  conflict: ConnectionImportConflict
  /** 冲突条目当前处于连接中 —— 覆盖策略下会被跳过 */
  connected: boolean
}

export interface ConnectionImportIssue {
  /** 文件里的条目下标；整文件级别的错误为 -1 */
  index: number
  message: string
}

export interface ConnectionImportPreview {
  /** 一次性导入令牌：应用阶段凭它取回主进程缓存的解析结果 */
  token: string
  fileName: string
  formatVersion: number
  exportedAt?: string
  appVersion?: string
  /** 文件头声明；导入时以实际字段重新判断 */
  includesCredentials: boolean
  /** 文件中的条目总数（含非法条目） */
  total: number
  /** 通过校验、可导入的条数 */
  valid: number
  items: ConnectionImportPreviewItem[]
  issues: ConnectionImportIssue[]
}

export interface ConnectionImportApplyOptions {
  /**
   * 按 ID 覆盖已有配置；默认 false（全部生成新 ID）。
   * 已连接的命中项一律跳过 —— 会话仍跑旧配置，覆盖只会让界面与会话不一致。
   */
  overwrite: boolean
}

export interface ConnectionImportSummary {
  imported: number
  overwritten: number
  skipped: number
}

export interface ConnectionImportResult {
  /** 导入后的全量连接列表（含明文凭据，与 connection:list 同规则） */
  connections: CacheConnectionConfig[]
  summary: ConnectionImportSummary
  /** 因仍处于连接中而跳过的连接名 */
  skippedConnected: string[]
}

/**
 * 检查更新的结果。
 *
 * 只描述"事实"（远端最新版本 / 是否更新 / 下载地址），
 * 判断与文案都交给渲染层 —— 主进程不该生成 UI 文案。
 */
export interface UpdateCheckResult {
  /** 当前运行版本（便于用户对照） */
  currentVersion: string
  /** 远端最新 tag 名（已去掉前缀 v，如 1.1.0） */
  latestVersion: string
  /** 远端是否比本地新 */
  hasUpdate: boolean
  /** 版本说明（tag message 原文，可能为空） */
  notes: string | null
  /** 仓库主页 / 版本页，用于「查看详情」 */
  pageUrl: string
  /** 检查时间（ISO），用于界面提示"多久之前检查的" */
  checkedAt: string
  /** 远端确实可达但拿不到版本信息时的说明（例如仓库尚无 tag） */
  notice: string | null
  /**
   * 是否支持应用内下载并安装。
   * 只有打包版走 electron-updater 检查时为 true；开发态 / 回退到
   * GitHub 版本页时为 false，界面只提供「查看下载」。
   */
  canAutoUpdate: boolean
  /** 更新包大小（字节）；更新源未提供时为 null */
  packageSize: number | null
}

/** 应用内更新的运行时阶段 */
export type UpdateDownloadPhase = 'idle' | 'downloading' | 'downloaded' | 'error'

/**
 * 下载 / 安装阶段的状态快照。
 *
 * 由主进程维护并推送：面板关掉再打开时先用 update.state() 拉一次，
 * 不会因为错过进度事件而"回到未下载"。
 */
export interface UpdateDownloadState {
  phase: UpdateDownloadPhase
  /** 本次更新目标版本；没有进行中的任务时为 null */
  version: string | null
  /** 0–100，总量未知时为 null */
  percent: number | null
  /** 已下载字节数 */
  transferred: number
  /** 总字节数，未知时为 null */
  total: number | null
  /** 实时速度（字节/秒） */
  bytesPerSecond: number | null
  /** 失败原因（phase 为 error 时） */
  message: string | null
}

/** 连接运行时状态（与引擎无关的公共部分） */
export interface BaseConnectionState extends Omit<BaseConnectionConfig, 'credentialError'> {
  engine: CacheEngine
  status: ConnectionStatus
  /** 错误或提示信息 */
  message?: string
  /** 服务端版本，如 7.2.4 / 1.6.21 */
  version?: string
  /** PING 往返耗时（毫秒） */
  latency?: number
}

/**
 * Redis 的运行时状态。
 *
 * 之所以不用 `Omit<RedisConnectionConfig, 'password'|'ssh'>` 直接派生：
 * 那样会把 engine/name/host 等从配置类型"继承"过来，导致
 * 状态类型与配置类型被强行绑死 —— 配置里加一个字段，
 * 状态里就自动多一个可能并不该暴露给界面的字段。
 * 显式列出，边界清楚。
 */
export interface RedisConnectionState extends BaseConnectionState {
  engine: 'redis'
  /** 默认库序号 */
  db: number
  username?: string
  tls?: boolean
  /** 部署模式：standalone / cluster / sentinel */
  mode?: string
  /** 是否经 SSH 隧道（界面用于标注，不含任何凭据） */
  sshEnabled?: boolean
  /** 跳板机地址（仅用于展示） */
  sshHost?: string
}

/**
 * Memcached 的运行时状态。
 * 没有 db / mode —— 这些概念在 Memcached 里不存在，
 * 留空字段会让界面误以为"连上了只是没读到"。
 */
export interface MemcachedConnectionState extends BaseConnectionState {
  engine: 'memcached'
  /** 连接池大小 */
  poolSize?: number
  /** 是否经 SSH 隧道（界面用于标注，不含任何凭据） */
  sshEnabled?: boolean
  /** 跳板机地址（仅用于展示） */
  sshHost?: string
}

/** 任意引擎的运行时状态 */
export type ConnectionState = RedisConnectionState | MemcachedConnectionState

export interface RedisKeyItem {
  key: string
  type: RedisValueType
  /** 剩余存活秒数，-1 表示永久，-2 表示已过期 */
  ttl: number
  /** 内存占用（字节），未统计时为 undefined */
  size?: number
}

export interface ScanOptions {
  db?: number
  cursor?: string
  match?: string
  count?: number
}

export interface ScanResult {
  cursor: string
  keys: RedisKeyItem[]
  /** 本次扫描的库 */
  db: number
}

/** 全库搜索入参：SCAN 循环整体下沉主进程，渲染层一次调用 */
export interface SearchAllOptions {
  db?: number
  /** SCAN MATCH 模式（渲染层构造好的 `*kw*` 包夹），缺省 '*' */
  match?: string
  /** 结果上限（与渲染层 REMOTE_SEARCH_LIMIT 同源），主进程钳制 1..1000 */
  limit?: number
}

export interface SearchAllResult {
  keys: RedisKeyItem[]
  /** 因达上限退出（游标未归零）才为 true；自然扫完 / 被取消均为 false */
  capped: boolean
  /** 被取消（停止 / 新一轮搜索覆盖）：仍返回已找到的部分，供「停止保留结果」语义 */
  cancelled: boolean
}

/** 主 → 渲染：全库搜索进度推送（每批 SCAN 后发一次） */
export interface SearchProgress {
  connectionId: string
  /** 当前已去重的命中数 */
  found: number
}

/** 单键详情 */
export interface KeyValue {
  key: string
  type: RedisValueType
  ttl: number
  encoding?: string
  /**
   * 元素总数：hash/list/set/zset/stream 为服务端真实总数，
   * 而 value 只包含已加载的部分（见 nextCursor）。
   */
  length?: number
  /** 内存占用（字节） */
  size?: number
  value: string | string[] | Record<string, string> | null
  /**
   * 下一页游标；null / undefined 表示已全部加载。
   * hash/set 为 SCAN 游标，list/zset 为下一个偏移量，stream 为最后一条条目 ID。
   */
  nextCursor?: string | null
}

/** 首屏取值选项（大 key 只读一页，避免整键回传卡死界面） */
export interface ValueReadOptions {
  /** 单页元素上限，缺省 500，主进程钳制 1..20000 */
  limit?: number
}

/** 分页读取后续元素 */
export interface ValuePageOptions {
  /** 键类型（首屏已确定，省一次 TYPE 往返） */
  type: RedisValueType
  /** 首屏 / 上一页返回的 nextCursor */
  cursor: string
  /** 单页元素上限，缺省 500，主进程钳制 1..20000 */
  limit?: number
}

export interface ValuePageResult {
  key: string
  type: RedisValueType
  /** 服务端最新元素总数（分页期间可能变化），用于更新底部计数 */
  length?: number
  /** 本页元素：hash 为对象，其余为数组 */
  value: string | string[] | Record<string, string> | null
  /** 下一页游标；null 表示已到末尾 */
  nextCursor: string | null
}

/** 键列表增量刷新入参 */
export interface RefreshKeysOptions {
  db?: number
  /** SCAN MATCH 模式，缺省 '*' */
  match?: string
  /**
   * 最多收集多少键（0 / 缺省 = 扫完整个库）。
   * 扫描到的最后一批即使超出该值也会完整返回，避免游标越过未展示的键。
   */
  limit?: number
}

export interface RefreshKeysResult {
  keys: RedisKeyItem[]
  /** 停止处的 SCAN 游标：'0' 表示已扫完整个库 */
  cursor: string
  /** 本次扫描的库 */
  db: number
}

export interface ServerInfo {
  version: string
  mode: string
  os: string
  /** 服务端进程 PID（INFO Server 段 process_id） */
  processId: number
  uptimeInDays: number
  connectedClients: number
  usedMemoryHuman: string
  /** Lua 脚本引擎占用内存（INFO Memory 段 used_memory_lua_human） */
  usedMemoryLua: string
  totalKeys: number
  hitRate: number
  opsPerSec: number
}

/**
 * 一次监控采样（只含数值指标，供曲线绘制）。
 *
 * 与 ServerInfo 分开的原因：曲线需要高频轮询，而 ServerInfo 里
 * 混着版本 / 操作系统等字符串与人工摘要，反复传输纯属浪费；
 * 数值从 INFO 原样解析，不在主进程做展示格式（单位换算在渲染层）。
 *
 * 命中率是**累计值**（进程启动至今），不是采样区间命中率；
 * 同时给出 hits / misses 原始计数，渲染层可自行按增量计算区间命中率。
 */
export interface MetricsSample {
  /** 采样时刻（毫秒时间戳，主进程生成） */
  at: number
  /** used_memory（字节） */
  usedMemory: number
  /** used_memory_peak（字节） */
  usedMemoryPeak: number
  /** maxmemory（字节），0 表示未设置上限 */
  maxMemory: number
  /** instantaneous_ops_per_sec */
  opsPerSec: number
  connectedClients: number
  blockedClients: number
  /** 当前库的键数（DBSIZE） */
  totalKeys: number
  /** 累计命中率（百分比，一位小数） */
  hitRate: number
  keyspaceHits: number
  keyspaceMisses: number
  /** 累计淘汰 / 过期键数 */
  evictedKeys: number
  expiredKeys: number
  /** 累计处理命令数 */
  totalCommands: number
  /** 累计网络入口 / 出口字节数 */
  netInputBytes: number
  netOutputBytes: number
}

/** 键空间通知配置（notify-keyspace-events 的原始值） */
export interface KeyspaceConfig {
  /** 形如 "KEA" / "gxE" / 空串（关闭） */
  events: string
}

/**
 * 键空间通知事件（主进程 → 渲染层推送）。
 *
 * 统一订阅 `__keyevent@*__:*`：频道名带事件类型、消息体是键名，
 * 一次订阅即可覆盖全部库；库号从频道名解析后单独给出，
 * 界面不用再去拆字符串。
 */
export interface KeyspaceEvent {
  connectionId: string
  /** 事件发生的库号 */
  db: number
  /** 事件类型：set / del / expire / hset / ... */
  event: string
  /** 触发事件的键名 */
  key: string
  /** 原始频道名（排查时可对照 Redis 文档） */
  channel: string
  timestamp: number
}

export interface DatabaseInfo {
  db: number
  keys: number
}

/** 版本信息中的一个分组（对应 INFO 的一个段落） */
export interface VersionInfoGroup {
  section: string
  entries: Array<{ key: string; value: string }>
}

/**
 * 连接对应的服务端详细信息。
 * groups 按 INFO 段落组织；raw 保留完整原始输出，便于排查未收录的字段。
 */
export interface VersionInfo {
  version: string
  mode: string
  groups: VersionInfoGroup[]
  raw: string
}

/** 慢查询日志单条记录（SLOWLOG GET 的一行） */
export interface SlowlogEntry {
  /** 日志 ID：实例内单调递增，可用于识别新产生的条目 */
  id: number
  /** 命令发生时的 Unix 时间戳（秒） */
  timestamp: number
  /** 执行耗时（微秒） */
  duration: number
  /** 命令及参数，第一个元素是命令名 */
  command: string[]
  /** 客户端地址与端口（Redis 4.0+，形如 127.0.0.1:58217） */
  client: string
  /** 客户端连接名（CLIENT SETNAME 设置过才有值） */
  clientName: string
}

/** 慢查询日志整体视图：当前保留条数 + 最近条目 */
export interface SlowlogOverview {
  /** 服务端当前保留的慢日志条数（SLOWLOG LEN，受 slowlog-max-len 限制） */
  len: number
  /** 最近条目（按调用方指定的条数返回，时间倒序） */
  entries: SlowlogEntry[]
}

/** Pub/Sub 收到的一条消息（主进程 → 渲染层推送） */
export interface PubsubMessage {
  /** 所属连接 id（多连接并存时区分来源） */
  connectionId: string
  /** message = 精确频道订阅命中；pmessage = 模式订阅命中 */
  kind: 'message' | 'pmessage'
  /** 实际命中的频道名 */
  channel: string
  /** 模式订阅时命中的 pattern；精确订阅为空串 */
  pattern: string
  /** 消息体 */
  payload: string
  /** 收到时刻（毫秒时间戳） */
  timestamp: number
}

/** 连接的订阅状态：精确频道与模式两组 */
export interface PubsubState {
  channels: string[]
  patterns: string[]
}

/** 键内存分析：按前缀聚合的一行 */
export interface MemoryBucket {
  /** 聚合前缀（键按 `:` 取前 depth 段；段数不足时为完整键名） */
  prefix: string
  /** 该前缀下的键数量 */
  keys: number
  /** 该前缀的总内存占用（字节，MEMORY USAGE 之和） */
  bytes: number
}

/** 键内存分析整体视图 */
export interface MemoryAnalysis {
  /** 聚合粒度：前缀取前 N 段 */
  depth: number
  /** 实际扫描的键数 */
  scanned: number
  /** 是否因超过扫描上限被截断（结果是近似值） */
  truncated: boolean
  /** 前缀桶数量是否超过上限被截断（仅保留内存降序前 200 的前缀） */
  bucketsTruncated: boolean
  /** 已扫描键的总内存（字节） */
  totalBytes: number
  /** 聚合行，按内存降序 */
  buckets: MemoryBucket[]
}

export interface CliResult {
  output: string
  error?: string
  costMs: number
  /**
   * 命令执行后连接所在的库。
   * 仅在命令改变了库（SELECT / SWAPDB）时返回，供界面同步库选择器。
   */
  db?: number
}

export interface OperationResult {
  ok: boolean
  message?: string
}

/** 运行环境信息，用于欢迎页展示本机与应用版本构成 */
export interface EnvInfo {
  appVersion: string
  electron: string
  chrome: string
  node: string
  v8: string
  /** 形如 win32 x64 */
  platform: string
  arch: string
  locale: string
  /** 当前是否运行在 Electron 容器内 */
  inElectron: boolean
}

/** 统一响应包裹，便于渲染进程做错误提示 */
export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

/** ---------------------------------------------------------------- 设置 */

/** 应用级设置（持久化于 <userData>/settings.json） */
export interface AppSettings {
  /** 界面基准字号（px），其余字号由它推导 */
  fontSize: number
  /** 界面语言 */
  locale: 'zh-CN' | 'zh-TW' | 'en'
  /** 界面字体标识（见渲染层的字体映射表） */
  uiFont: string
  /** 代码字体标识 */
  monoFont: string
  /** 列表密度 */
  density: 'compact' | 'cozy'
  /** 每次加载（SCAN）的键数量 */
  pageSize: number
  /** 键名默认分隔符 */
  keySeparator: string
  /** 删除键前是否二次确认 */
  confirmDelete: boolean
  /** 操作日志保留天数 */
  logRetentionDays: number

  /* -------------------------------------------------- 以下为界面状态记忆 */

  /**
   * 主题：跟随系统 / 亮色 / 暗色，外加七套皮肤（深海/墨林/暖纸/樱花/薄荷/雾蓝/极光）。
   * 皮肤即主题 —— 选项直接落在 data-theme 上，不单独建皮肤体系；
   * 皮肤自带明暗（深海/墨林=暗，其余=亮），原生控件由 colorScheme 跟随。
   */
  theme:
    | 'system'
    | 'light'
    | 'dark'
    | 'ocean'
    | 'solarized'
    | 'forest'
    | 'sakura'
    | 'mint'
    | 'mist'
    | 'aurora'
  /** 键列表视图：树形 / 平铺 */
  viewMode: 'tree' | 'flat'
  /** CLI 控制台是否收起 */
  cliCollapsed: boolean
  /** 连接栏是否收起（收起后左栏只留一条窄条，把空间让给键列表与值区） */
  sidebarCollapsed: boolean
  /** 键列表栏宽度（px），可拖动分隔条调整 */
  keyBrowserWidth: number
  /**
   * 上次使用的连接与库。
   * 只用于"恢复选择"，不自动发起连接 —— 开机就静默连上生产库太危险。
   */
  lastConnectionId: string | null
  lastDb: number
  /**
   * 树节点的展开状态，按「连接 id @ 库号」分组存路径列表。
   * 只存**展开**的路径（而非折叠的）：默认折叠是主行为，
   * 存展开项数量通常远小于折叠项，且新键出现时默认收起更符合预期。
   */
  expandedPaths: Record<string, string[]>
}

/** ---------------------------------------------------------------- 键搜索历史 */

/**
 * 一条键搜索历史。
 *
 * 按「连接 id @ 库号」分桶（键空间本来就是 db 级的，跨 db 共享补全
 * 只会给出当前库根本不存在的键名）；桶内 LRU 语义、上限 30 条。
 * 与 expandedPaths 的 `connId@db` 键格式保持同一惯例。
 */
export interface SearchHistoryEntry {
  /** 搜索词原样保留（区分大小写，通配符不展开） */
  q: string
  /** 使用次数（重复查询提升到最前时累加） */
  count: number
  /** 最近一次使用的毫秒时间戳 */
  at: number
}

/** 全部历史落盘结构：桶键 = `${connectionId}@${db}` */
export type SearchHistoryFile = Record<string, SearchHistoryEntry[]>

/** ---------------------------------------------------------------- 操作日志 */

/** 一条手动操作日志 */
export interface LogEntry {
  /** 时间戳（毫秒） */
  timestamp: number
  /**
   * 所属引擎。旧日志文件没有这一列，读取时按 'redis' 补齐 ——
   * 历史日志全部来自 Redis 时期，这个默认值是准确的而不是猜测。
   */
  engine: CacheEngine
  connectionId: string
  connectionName: string
  /** 操作类别，如 命令 / 写入 / 删除键 / 新建键 */
  action: string
  /** 操作目标与参数摘要 */
  detail: string
  ok: boolean
  /** 结果摘要 */
  result: string
  costMs?: number
}

/** 日志查询条件 */
export interface LogQuery {
  /** 日期，格式 yyyymmdd；缺省为今天 */
  date?: string
  /** 按引擎过滤；缺省为全部 */
  engine?: CacheEngine
  /** 按连接名过滤 */
  connection?: string
  /** 关键字过滤（匹配操作与详情） */
  keyword?: string
}

export interface LogFileInfo {
  /** yyyymmdd */
  date: string
  /** 字节数 */
  size: number
}
/**
 * 渲染层 / 主进程错误报告（错误落盘用，2026-10 用户需求）。
 *
 * 「报错信息尽量全面」的落地字段：错误消息、完整堆栈、Vue 组件信息
 * （onErrorCaptured 的 info）、应用版本、平台与 Electron 版本、
 * 层级来源（renderer / main）—— 排查问题时这些缺一不可。
 */
export interface ErrorReport {
  /** 错误来源层级：renderer（Vue 错误边界）/ main（进程级未捕获） */
  source: 'renderer' | 'main'
  /** 错误消息（error.message 或 String(error)） */
  message: string
  /** 完整堆栈（多行原文，不截断） */
  stack?: string
  /** Vue onErrorCaptured 的组件信息（触发错误的组件链） */
  info?: string
  /** 应用版本（对照用户反馈的报错对应哪个发布版） */
  version?: string
  /** 平台与运行时（如 win32-x64 / Electron 33.2.1） */
  platform?: string
  /** 发生时间戳（毫秒） */
  timestamp: number
}

/* ===========================================================================
 * Memcached 专属类型
 *
 * 刻意不复用 Redis 的 ServerInfo / RedisKeyItem：
 * 两者语义不同（Memcached 没有 db、没有 TTL-1 的约定、没有值类型），
 * 复用会导致界面到处写"这个字段对 Memcached 无意义"的判断。
 * =========================================================================== */

/** Memcached 概览：面板顶部卡片与统计页签的来源 */
export interface MemcachedOverview {
  /** stats 原始键值（命中、内存、条目、连接等），界面按需取值 */
  stats: Record<string, string>
  /** slabs 原始键值（items:<slab>:xxx） */
  items: Record<string, string>
  /** stats settings 原始键值；服务端禁用时为空对象 */
  settings: Record<string, string>
  /** 服务端版本，如 1.6.21 */
  version: string
}

/** 一个 slab class 的条目分布 */
export interface MemcachedSlab {
  /** slab class 编号 */
  slab: number
  /** 该 class 当前条目数 */
  count: number
  /** 最老条目存活秒数 */
  age: number
  /** 因内存不足被淘汰的条目数 */
  evicted: number
}

/** 键枚举来源：metadump 覆盖全部分段；cachedump 仅 COLD 分段（旧服务端回退） */
export type MemcachedKeySource = 'metadump' | 'cachedump'

/** 一个缓存项的元信息 */
export interface MemcachedKeyItem {
  key: string
  /** 值的字节数 */
  bytes: number
  /** 过期时间戳（秒）；0 表示永不过期 */
  expiresAt: number
  /** 所属 slab class */
  slab: number
}

/** 键列表的一页（主进程按全局「每页加载键数」切片） */
export interface MemcachedKeyList {
  items: MemcachedKeyItem[]
  /** 当前快照中的键总数（翻页期间保持不变） */
  total: number
  /** 是否还有下一页 */
  hasMore: boolean
  /** 下一页的 offset；hasMore 为 false 时为 0 */
  nextOffset: number
  /** 数据来源：metadump 全量；cachedump 仅 COLD 分段 */
  source: MemcachedKeySource
  /** 结果是否可能不完整（cachedump 回退，或被 slab/取样上限截断） */
  truncated: boolean
  /** 拒绝执行 cachedump 的 slab（仅回退模式下可能出现） */
  deniedSlabs: number[]
}

/** 单个键的值 */
export interface MemcachedValue {
  found: boolean
  /** 按 UTF-8 解码的内容（二进制值可能出现替换符） */
  data: string
  /** 原始字节数 */
  bytes: number
  /** 协议 flags，业务侧自解释 */
  flags: number
  /** 剩余存活秒数：-1 永久；undefined 表示服务端不支持 meta 协议，无法得知 */
  ttl?: number
}

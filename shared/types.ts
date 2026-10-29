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

export interface RedisConnectionConfig {
  id: string
  name: string
  host: string
  port: number
  username?: string
  password?: string
  /** 默认库序号 */
  db: number
  tls?: boolean
  /** SSH 隧道；未设置表示直连 */
  ssh?: SshConfig
  /** 是否启用 SSH 隧道（与 ssh 是否存在分开，便于临时关闭而不丢失配置） */
  sshEnabled?: boolean
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
}

/** 连接运行时状态 */
export interface ConnectionState extends Omit<RedisConnectionConfig, 'password' | 'ssh'> {
  status: ConnectionStatus
  /** 错误或提示信息 */
  message?: string
  /** 服务端版本，如 7.2.4 */
  version?: string
  /** 部署模式：standalone / cluster / sentinel */
  mode?: string
  /** PING 往返耗时（毫秒） */
  latency?: number
  /** 是否经 SSH 隧道（界面用于标注，不含任何凭据） */
  sshEnabled?: boolean
  /** 跳板机地址（仅用于展示） */
  sshHost?: string
}

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
  /** 元素个数（hash/list/set/zset）或字符串长度 */
  length?: number
  /** 内存占用（字节） */
  size?: number
  value: string | string[] | Record<string, string> | null
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

import type {
  ApiResponse,
  AppSettings,
  CliResult,
  ConnectionStatus,
  ConnectionState,
  DatabaseInfo,
  EnvInfo,
  ErrorReport,
  FavoriteEntry,
  KeyValue,
  KeyspaceConfig,
  KeyspaceEvent,
  LogEntry,
  LogFileInfo,
  LogQuery,
  MemoryAnalysis,
  MetricsSample,
  OperationResult,
  CacheConnectionConfig,
  ConnectionExportOptions,
  ConnectionExportResult,
  ConnectionImportApplyOptions,
  ConnectionImportPreview,
  ConnectionImportResult,
  MemcachedKeyList,
  MemcachedOverview,
  MemcachedSlab,
  MemcachedValue,
  RedisConnectionConfig,
  RedisKeyItem,
  RedisValueType,
  ScanOptions,
  ScanResult,
  SearchAllOptions,
  SearchAllResult,
  SearchHistoryEntry,
  SearchProgress,
  ServerInfo,
  SlowlogOverview,
  PubsubMessage,
  PubsubState,
  VersionInfo,
  UpdateCheckResult,
  UpdateDownloadState,
  ValuePageOptions,
  ValuePageResult,
  ValueReadOptions,
  ValueBinaryOptions,
  ValueBinaryResult,
  SaveBytesOptions,
  SaveBytesResult,
  RefreshKeysOptions,
  RefreshKeysResult,
  StreamGroup,
  StreamConsumer,
  StreamPendingSummary,
  StreamPendingPage,
  StreamPendingOptions,
  StreamMutationResult,
  StreamTrimOptions,
} from './types'

/**
 * 预加载层通过 contextBridge 暴露给渲染进程的完整接口。
 * 渲染进程只依赖这份定义，不直接感知 IPC 通道名。
 */
export interface RedisDesktopApi {
  app: {
    getVersion: () => Promise<ApiResponse<string>>
    getEnvInfo: () => Promise<ApiResponse<EnvInfo>>
  }

  update: {
    /**
     * 检查是否有新版本。
     *
     * 走主进程而不是渲染层直接 fetch：
     *   · 渲染进程在 file:// 下受 CORS 限制，请求会被拦；
     *   · 主进程可以统一设置超时与 UA，失败时能给明确原因。
     */
    check: () => Promise<ApiResponse<UpdateCheckResult>>
    /** 在系统浏览器中打开指定地址（下载页 / 版本说明） */
    openPage: (url: string) => Promise<ApiResponse<OperationResult>>
    /** 当前下载 / 安装状态（面板重新打开时恢复进度） */
    state: () => Promise<ApiResponse<UpdateDownloadState>>
    /**
     * 开始下载更新（electron-updater 增量下载）。
     * 必须在 check() 返回 hasUpdate=true 且 canAutoUpdate=true 后调用。
     */
    download: (version: string) => Promise<ApiResponse<UpdateDownloadState>>
    /** 退出应用并安装已下载的更新 */
    install: () => Promise<ApiResponse<OperationResult>>
    /** 订阅下载 / 安装状态变化，返回取消订阅函数 */
    onStateChange: (listener: (state: UpdateDownloadState) => void) => () => void
  }

  settings: {
    get: () => Promise<ApiResponse<AppSettings>>
    save: (patch: Partial<AppSettings>) => Promise<ApiResponse<AppSettings>>
    /** 配置文件所在目录（便携模式可能回退到 userData） */
    configInfo: () => Promise<ApiResponse<{ dir: string; portable: boolean; reason: string | null }>>
  }

  /**
   * 键搜索历史（补全数据源）。
   *
   * 按「连接 id @ 库号」分桶，桶内 LRU + 30 条上限。
   * 四个方法都返回该桶最新列表 —— 前端不需要记录后再发一次 get。
   * 历史文件独立于 settings.json（config/search-history.json），
   * 连接被删除时主进程同步清理其全部桶。
   */
  searchHistory: {
    /** 取某连接某库的历史（连接建立 / 切换 db 时调用一次） */
    get: (connId: string, db: number) => Promise<ApiResponse<SearchHistoryEntry[]>>
    /** 记录一次执行的查询（空词忽略），返回最新列表 */
    record: (connId: string, db: number, term: string) => Promise<ApiResponse<SearchHistoryEntry[]>>
    /** 删除单条，返回最新列表 */
    remove: (connId: string, db: number, term: string) => Promise<ApiResponse<SearchHistoryEntry[]>>
    /** 清空该桶，返回空列表 */
    clear: (connId: string, db: number) => Promise<ApiResponse<SearchHistoryEntry[]>>
  }

  /**
   * 键收藏。
   *
   * 按连接分桶，条目带 db；四个方法都返回该连接最新列表，
   * 前端与搜索历史同一约定：不做本地合并，直接整体替换。
   */
  favorites: {
    list: (connId: string) => Promise<ApiResponse<FavoriteEntry[]>>
    /** 已收藏则移除、未收藏则新增，返回最新列表 */
    toggle: (connId: string, db: number, key: string) => Promise<ApiResponse<FavoriteEntry[]>>
    remove: (connId: string, db: number, key: string) => Promise<ApiResponse<FavoriteEntry[]>>
    clear: (connId: string) => Promise<ApiResponse<FavoriteEntry[]>>
  }

  /** CLI 命令历史（按连接分桶，新的在前） */
  cliHistory: {
    get: (connId: string) => Promise<ApiResponse<string[]>>
    record: (connId: string, command: string) => Promise<ApiResponse<string[]>>
    clear: (connId: string) => Promise<ApiResponse<string[]>>
  }

  log: {
    /** 可用日志日期（倒序），用于日期筛选下拉 */
    dates: () => Promise<ApiResponse<LogFileInfo[]>>
    read: (query: LogQuery) => Promise<ApiResponse<LogEntry[]>>
    dir: () => Promise<ApiResponse<string>>
    /** 在系统文件管理器中打开日志目录 */
    openDir: () => Promise<ApiResponse<OperationResult>>
    /**
     * 渲染层错误落盘（fire-and-forget）。
     *
     * 错误边界（main.ts errorHandler / App.vue onErrorCaptured）调用；
     * 主进程写 <配置目录>/logs/errors-yyyymmdd.log。返回值无人消费 ——
     * 落盘失败不能反过来把错误边界再炸一遍，调用侧一律 void + catch 吞掉。
     */
    reportError: (report: ErrorReport) => Promise<ApiResponse<OperationResult>>
  }

  file: {
    /** 弹出保存对话框并把文本写入本地文件（导出键值用） */
    saveText: (options: {
      suggestedName?: string
      content: string
    }) => Promise<ApiResponse<{ saved: boolean; path?: string }>>
    /** 保存二进制内容（图片 / Hex 导出用），入参为 base64 */
    saveBytes: (options: SaveBytesOptions) => Promise<ApiResponse<SaveBytesResult>>
  }

  connection: {
    /*
     * 连接配置通道对所有引擎通用 —— 它们是"配置实体"，不是引擎命令。
     * 具体连接行为由引擎适配器实现（见 electron/services/engines）。
     * 返回全量列表而不是单条：连接数量有限（几十条量级），
     * 每次回全量让渲染层无需自己做合并，也天然避免两份状态不一致。
     */
    list: () => Promise<ApiResponse<CacheConnectionConfig[]>>
    save: (config: CacheConnectionConfig) => Promise<ApiResponse<CacheConnectionConfig[]>>
    remove: (id: string) => Promise<ApiResponse<CacheConnectionConfig[]>>
    /**
     * 置顶 / 取消置顶。
     *
     * 专用通道而非复用 save：save 需要传全量配置（含密码），
     * 而 credentialError 场景下 password 已是 undefined，
     * 拿现有条目组一个全量对象再存会把密文抹掉；
     * 这里只改 pinned 一个字段，主进程在磁盘条目上原位修改，完全不碰凭据。
     */
    setPinned: (id: string, pinned: boolean) => Promise<ApiResponse<CacheConnectionConfig[]>>
    /**
     * 拖拽排序：把全量连接 id 按新的显示顺序写回磁盘数组。
     * 磁盘数组顺序即列表排序 —— 加载时渲染端做置顶优先的稳定排序，
     * 组内先后完全由这里落盘的顺序决定。
     */
    reorder: (ids: string[]) => Promise<ApiResponse<CacheConnectionConfig[]>>
    /**
     * 导出全部连接。文件路径由主进程的保存对话框决定，
     * 渲染层只传「是否包含凭据」—— 不允许指定任意路径。
     */
    exportToFile: (options: ConnectionExportOptions) => Promise<ApiResponse<ConnectionExportResult>>
    /**
     * 选择并解析导入文件，返回脱敏预览与一次性 token。
     * 用户取消文件对话框时 data 为 null。
     */
    importPick: () => Promise<ApiResponse<ConnectionImportPreview | null>>
    /** 确认导入：主进程重新读盘合并、一次落盘并返回全量列表 */
    importApply: (
      token: string,
      options: ConnectionImportApplyOptions,
    ) => Promise<ApiResponse<ConnectionImportResult>>
    /** 放弃预览时释放主进程缓存的解析结果（过期也会自动清理） */
    importCancel: (token: string) => Promise<ApiResponse<OperationResult>>
    /**
     * 批量新建（URI 批量导入用）：主进程重新校验、分配不冲突的 ID，
     * 一次落盘，避免逐条 save 的 N 次 IPC 与 N 次全量刷新。
     */
    saveMany: (configs: CacheConnectionConfig[]) => Promise<ApiResponse<ConnectionImportResult>>
    /** 测试连接：按 config.engine 路由到对应引擎的适配器 */
    test: (config: CacheConnectionConfig) => Promise<ApiResponse<OperationResult>>
    /** 建立连接：同上，返回该引擎特有的状态对象 */
    connect: (config: CacheConnectionConfig) => Promise<ApiResponse<ConnectionState>>
    disconnect: (id: string) => Promise<ApiResponse<OperationResult>>
    status: (id: string) => Promise<ApiResponse<boolean>>
    /**
     * 订阅连接状态变化（主 → 渲染推送），返回取消订阅函数。
     *
     * 背景：连接建立后状态只在「用户主动操作」时更新；服务端重启 /
     * 网络闪断这类**被动**变化由主进程的 ioredis 生命周期事件捕获并推送，
     * 否则左侧绿点恒亮，用户以为连接正常，直到某次操作报错才发现断了。
     */
    onStatusChange: (
      listener: (payload: { id: string; status: ConnectionStatus; message?: string }) => void,
    ) => () => void
  }

  redis: {
    info: (id: string) => Promise<ApiResponse<ServerInfo>>
    /**
     * 监控采样：一次返回 INFO 中的数值指标 + 当前库 DBSIZE。
     * 供概览「监控」页签的高频轮询使用（只传数字，不传文案）。
     */
    metrics: (id: string) => Promise<ApiResponse<MetricsSample>>
    /** 服务端详细信息（按 INFO 段落分组） */
    versionInfo: (id: string) => Promise<ApiResponse<VersionInfo>>
    /**
     * 慢查询日志：SLOWLOG LEN + SLOWLOG GET 合并返回。
     * count 是返回条数上限；服务端最多保留 slowlog-max-len 条。
     */
    slowlog: (id: string, count?: number) => Promise<ApiResponse<SlowlogOverview>>
    /** 清空慢查询日志（SLOWLOG RESET，不可恢复） */
    slowlogReset: (id: string) => Promise<ApiResponse<OperationResult>>
    /**
     * Pub/Sub 订阅。⚠️ 用独立连接承载：SUBSCRIBE 后连接进入订阅模式，
     * 不能再执行普通命令 —— 复用主连接会把浏览 / CLI 全部弄坏。
     * pattern=true 时按 PSUBSCRIBE 模式订阅。
     */
    pubsubSubscribe: (id: string, targets: string[], pattern?: boolean) => Promise<ApiResponse<PubsubState>>
    /** 退订（pattern=true 时按 PUNSUBSCRIBE） */
    pubsubUnsubscribe: (id: string, targets: string[], pattern?: boolean) => Promise<ApiResponse<PubsubState>>
    /** 发布消息，返回接收该消息的订阅者数量（可用于确认有没有人在听） */
    pubsubPublish: (id: string, channel: string, message: string) => Promise<ApiResponse<number>>
    /** 断开该连接的 Pub/Sub 专用连接（面板关闭 / 切换连接时调用） */
    pubsubStop: (id: string) => Promise<ApiResponse<OperationResult>>
    /**
     * 订阅 Pub/Sub 消息推送（主 → 渲染），返回取消订阅函数。
     * 与 onStatusChange 相同的桥接模式。
     */
    onPubsubMessage: (listener: (message: PubsubMessage) => void) => () => void
    /**
     * 键空间通知配置。
     *
     * CONFIG GET 在托管 Redis 上常被禁用 —— 失败时按 ApiResponse 错误返回，
     * 由面板提示「去控制台改参数」，而不是假装配置为空。
     */
    keyspaceConfig: (id: string) => Promise<ApiResponse<KeyspaceConfig>>
    /** 修改 notify-keyspace-events（CONFIG SET，可能被服务端拒绝） */
    setKeyspaceConfig: (id: string, events: string) => Promise<ApiResponse<OperationResult>>
    /**
     * 订阅键空间事件。与 Pub/Sub 一样使用独立连接（订阅模式无法执行普通命令），
     * 但另开一条，避免与 Pub/Sub 面板互相干扰（各自的停止 / 退订互不牵连）。
     * patterns 通常是 `__keyevent@*__:*`（事件名在频道、键名在消息体）。
     */
    keyspaceSubscribe: (id: string, patterns: string[]) => Promise<ApiResponse<PubsubState>>
    keyspaceUnsubscribe: (id: string, patterns: string[]) => Promise<ApiResponse<PubsubState>>
    /** 断开该连接的键空间订阅连接（面板关闭 / 切换连接时调用） */
    keyspaceStop: (id: string) => Promise<ApiResponse<OperationResult>>
    /** 订阅键空间事件推送（主 → 渲染），返回取消订阅函数 */
    onKeyspaceEvent: (listener: (event: KeyspaceEvent) => void) => () => void
    /**
     * 键内存分析：SCAN 全库 + MEMORY USAGE，按前缀聚合。
     * ⚠️ 逐键探测是重操作，主进程有扫描上限（超限截断并在结果中标记），
     * 因此面板不自动加载，由用户显式触发。
     */
    memoryAnalysis: (id: string, depth?: number) => Promise<ApiResponse<MemoryAnalysis>>
    databases: (id: string) => Promise<ApiResponse<DatabaseInfo[]>>
    scan: (id: string, options?: ScanOptions) => Promise<ApiResponse<ScanResult>>
    /** 单键元信息查询（TYPE/TTL 一次 pipeline 往返）：精确搜索直达，键不存在返回 null */
    lookupKey: (id: string, key: string, db?: number) => Promise<ApiResponse<RedisKeyItem | null>>
    /**
     * 全库搜索：SCAN 循环整体下沉主进程（渲染层一次调用），
     * 循环内只取键名（砍逐批 TYPE/TTL），结束后对结果集一次批量元信息。
     * 可被 searchCancel / 新一轮搜索取消；取消时仍返回已找到部分（cancelled=true）。
     */
    searchAll: (id: string, options?: SearchAllOptions) => Promise<ApiResponse<SearchAllResult>>
    /** 取消该连接的在途全库搜索（停止按钮 / 断开时调用） */
    searchCancel: (id: string) => Promise<ApiResponse<OperationResult>>
    /** 订阅全库搜索进度推送（主 → 渲染），返回取消订阅函数。与 onPubsubMessage 相同的桥接模式 */
    onSearchProgress: (listener: (progress: SearchProgress) => void) => () => void
    /**
     * 键列表增量刷新：从游标 0 重扫当前模式，一次返回整批新元信息。
     * 与 scan 的区别：无逐页 IPC、无骨架屏语义，供「重新扫描」原地替换列表。
     */
    refreshKeys: (id: string, options?: RefreshKeysOptions) => Promise<ApiResponse<RefreshKeysResult>>
    /** 单键首屏（大 key 只取一页，返回 nextCursor 供 valuePage 续读） */
    value: (id: string, key: string, options?: ValueReadOptions) => Promise<ApiResponse<KeyValue>>
    /** string 值的原始字节（base64），可顺手做 gzip / zlib 解压 */
    valueBinary: (
      id: string,
      key: string,
      options?: ValueBinaryOptions,
    ) => Promise<ApiResponse<ValueBinaryResult>>
    /** 读取大 key 的后续一页 */
    valuePage: (id: string, key: string, options: ValuePageOptions) => Promise<ApiResponse<ValuePageResult>>
    setValue: (
      id: string,
      key: string,
      type: RedisValueType,
      payload: string | string[] | Record<string, string>,
      ttlSeconds?: number,
      isNew?: boolean,
    ) => Promise<ApiResponse<OperationResult>>
    remove: (id: string, keys: string[]) => Promise<ApiResponse<OperationResult>>
    setTtl: (id: string, key: string, seconds: number) => Promise<ApiResponse<OperationResult>>
    rename: (id: string, key: string, newKey: string) => Promise<ApiResponse<OperationResult>>
    /** 删除 hash 的单个字段 */
    delHashField: (id: string, key: string, field: string) => Promise<ApiResponse<OperationResult>>
    /** 写入 hash 的单个字段；nextField 与 field 不同时视为重命名 */
    setHashField: (
      id: string,
      key: string,
      field: string,
      value: string,
      nextField?: string,
      keepTtlSeconds?: number,
    ) => Promise<ApiResponse<OperationResult>>
    /**
     * 读取 hash 各字段的剩余 TTL（Redis 7.4+ 的 HTTL）。
     * 服务端不支持时 data 为 null，调用方按「能力不可用」处理。
     */
    hashFieldTtls: (
      id: string,
      key: string,
      fields: string[],
    ) => Promise<ApiResponse<Record<string, number> | null>>
    /** 设置 hash 单个字段的 TTL（Redis 7.4+ 的 HEXPIRE / HPERSIST） */
    setHashFieldTtl: (
      id: string,
      key: string,
      field: string,
      seconds: number,
    ) => Promise<ApiResponse<OperationResult>>
    /** 修改 list 指定位置的元素 */
    setListElement: (
      id: string,
      key: string,
      index: number,
      value: string,
    ) => Promise<ApiResponse<OperationResult>>
    /** 删除 list 指定位置的元素 */
    delListElement: (id: string, key: string, index: number) => Promise<ApiResponse<OperationResult>>
    /** 在 list 指定位置前/后插入元素 */
    insertListElement: (
      id: string,
      key: string,
      index: number,
      value: string,
      position: 'before' | 'after',
    ) => Promise<ApiResponse<OperationResult>>
    /** 向 list 末尾追加元素（LSET 无法越界写入，追加走 RPUSH） */
    appendListElement: (id: string, key: string, value: string) => Promise<ApiResponse<OperationResult>>
    /** 修改 set 成员（SREM 旧 + SADD 新） */
    setSetMember: (
      id: string,
      key: string,
      member: string,
      next: string,
    ) => Promise<ApiResponse<OperationResult>>
    /** 删除 set 成员 */
    delSetMember: (id: string, key: string, member: string) => Promise<ApiResponse<OperationResult>>
    /** 新增 set 成员（SADD 幂等） */
    addSetMember: (id: string, key: string, member: string) => Promise<ApiResponse<OperationResult>>
    /** 修改 zset 成员（改名走 ZREM + ZADD；仅改 score 走 ZADD 更新语义） */
    setZsetMember: (
      id: string,
      key: string,
      member: string,
      nextMember: string,
      nextScore: number,
    ) => Promise<ApiResponse<OperationResult>>
    /** 删除 zset 成员 */
    delZsetMember: (id: string, key: string, member: string) => Promise<ApiResponse<OperationResult>>
    /** 新增 zset 成员（ZADD，已存在则更新 score） */
    addZsetMember: (
      id: string,
      key: string,
      member: string,
      score: number,
    ) => Promise<ApiResponse<OperationResult>>
    /** 向 stream 追加一条 entry（XADD），支持多字段 */
    xaddEntry: (
      id: string,
      key: string,
      fields: Array<[string, string]>,
    ) => Promise<ApiResponse<OperationResult>>
    /** 消费组列表（XINFO GROUPS） */
    streamGroups: (id: string, key: string) => Promise<ApiResponse<StreamGroup[]>>
    /** 组内消费者（XINFO CONSUMERS） */
    streamConsumers: (
      id: string,
      key: string,
      group: string,
    ) => Promise<ApiResponse<StreamConsumer[]>>
    /** PEL 汇总（XPENDING） */
    streamPendingSummary: (
      id: string,
      key: string,
      group: string,
    ) => Promise<ApiResponse<StreamPendingSummary>>
    /** PEL 明细分页 */
    streamPending: (
      id: string,
      key: string,
      group: string,
      options?: StreamPendingOptions,
    ) => Promise<ApiResponse<StreamPendingPage>>
    streamGroupCreate: (
      id: string,
      key: string,
      group: string,
      startId: string,
      mkstream: boolean,
    ) => Promise<ApiResponse<OperationResult>>
    streamGroupDestroy: (id: string, key: string, group: string) => Promise<ApiResponse<OperationResult>>
    streamGroupSetId: (
      id: string,
      key: string,
      group: string,
      startId: string,
    ) => Promise<ApiResponse<OperationResult>>
    streamAck: (
      id: string,
      key: string,
      group: string,
      ids: string[],
    ) => Promise<ApiResponse<StreamMutationResult>>
    streamClaim: (
      id: string,
      key: string,
      group: string,
      consumer: string,
      minIdleMs: number,
      ids: string[],
    ) => Promise<ApiResponse<StreamMutationResult>>
    streamDel: (
      id: string,
      key: string,
      ids: string[],
    ) => Promise<ApiResponse<StreamMutationResult>>
    streamTrim: (
      id: string,
      key: string,
      options: StreamTrimOptions,
    ) => Promise<ApiResponse<StreamMutationResult>>
    createKey: (
      id: string,
      key: string,
      type: RedisValueType,
      payload?: string | string[] | Record<string, string>,
      ttlSeconds?: number,
    ) => Promise<ApiResponse<OperationResult>>
    cli: (id: string, command: string) => Promise<ApiResponse<CliResult>>
  }

  /**
   * Memcached 专属能力。
   *
   * 与 redis 命名空间并列，互不引用 —— 渲染层按连接的 engine
   * 决定调哪一个。这样两个模块在类型层面就是隔开的：
   * Memcached 面板不可能"顺手"调到 redis.info。
   */
  memcached: {
    /** 全局 stats + items + settings 一趟取回 */
    overview: (id: string) => Promise<ApiResponse<MemcachedOverview>>
    /** 按 slab class 的条目分布 */
    slabs: (id: string) => Promise<ApiResponse<MemcachedSlab[]>>
    /**
     * 分页列出键。
     *
     * 主进程优先用 `lru_crawler metadump all` 取全量快照（覆盖 HOT/WARM/COLD），
     * 再按 offset/limit 切片；limit 由界面的全局「每页加载键数」传入。
     * 老服务端不支持 metadump 时回退 cachedump（仅 COLD 分段），
     * 此时 truncated 为真，界面必须如实告知用户。
     * 传入 refresh=true 或 offset=0 时重建快照，后续翻页复用同一份快照。
     */
    keys: (
      id: string,
      options?: { offset?: number; limit?: number; refresh?: boolean },
    ) => Promise<ApiResponse<MemcachedKeyList>>
    get: (id: string, key: string) => Promise<ApiResponse<MemcachedValue>>
    /** 原始字节（格式化 / Hex / 图片预览用） */
    getBinary: (
      id: string,
      key: string,
      options?: ValueBinaryOptions,
    ) => Promise<ApiResponse<ValueBinaryResult>>
    set: (
      id: string,
      key: string,
      value: string,
      options?: {
        exptime?: number
        mode?: 'set' | 'add' | 'replace'
        /** 保留原值的协议 flags（编辑已有键时传入） */
        flags?: number
        /** 目标剩余秒数（-1 = 永久）。传入时优先于 exptime，并自动处理 >30 天的绝对时间语义 */
        ttlSeconds?: number
      },
    ) => Promise<ApiResponse<OperationResult>>
    remove: (id: string, key: string) => Promise<ApiResponse<OperationResult>>
    /**
     * 重命名键。
     * Memcached 没有 RENAME 命令，主进程按「读取 → 写入新键 → 删除旧键」组合执行：
     * 保留 flags，服务端支持 meta 时同时保留剩余 TTL；目标键已存在则拒绝。
     */
    rename: (id: string, key: string, newKey: string) => Promise<ApiResponse<OperationResult>>
    /**
     * 修改键的过期时间（touch 命令）。
     * seconds < 0 表示移除过期（exptime=0，永久）；键不存在时返回 ok:false。
     */
    touch: (id: string, key: string, seconds: number) => Promise<ApiResponse<OperationResult>>
    /** 清空全部数据（flush_all），破坏性 */
    flush: (id: string) => Promise<ApiResponse<OperationResult>>
  }

  /**
   * 窗口控制（无边框窗口的自绘标题栏按钮）。
   * 浏览器预览模式下由 mock 实现为 no-op。
   */
  window: {
    minimize: () => Promise<ApiResponse<null>>
    /** 最大化 / 向下还原（按当前状态切换） */
    maxToggle: () => Promise<ApiResponse<null>>
    close: () => Promise<ApiResponse<null>>
    /** 当前窗口状态（初始值；后续变化走 onStateChange） */
    state: () => Promise<ApiResponse<{ maximized: boolean }>>
    /**
     * 订阅最大化状态变化（图标在 max / restore 间切换），返回取消订阅函数。
     * 这是唯一带回调的 api：listener 由渲染层传入，preload 桥接后注册。
     */
    onStateChange: (listener: (state: { maximized: boolean }) => void) => () => void
    /**
     * 订阅「用户点了关闭按钮」——主进程已拦下 close，等渲染层弹自绘确认框。
     * 返回取消订阅函数。
     */
    onBeforeClose: (listener: () => void) => () => void
    /** 确认框已弹出：让主进程取消兜底强制关闭 */
    closeHandled: () => void
    /** 确认退出：主进程真正销毁窗口 */
    confirmClose: () => void
  }
}

/** IPC 通道常量，主进程与预加载层共用，避免字符串写错 */
export const IPC = {
  appVersion: 'app:getVersion',
  appEnvInfo: 'app:getEnvInfo',

  updateCheck: 'update:check',
  updateOpenPage: 'update:openPage',
  updateState: 'update:state',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  /** 主 → 渲染：下载 / 安装状态推送（非 invoke 型） */
  updateStateChanged: 'update:stateChanged',

  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  settingsConfigInfo: 'settings:configInfo',

  searchHistoryGet: 'searchHistory:get',
  searchHistoryRecord: 'searchHistory:record',
  searchHistoryRemove: 'searchHistory:remove',
  searchHistoryClear: 'searchHistory:clear',

  favoritesList: 'favorites:list',
  favoritesToggle: 'favorites:toggle',
  favoritesRemove: 'favorites:remove',
  favoritesClear: 'favorites:clear',

  cliHistoryGet: 'cliHistory:get',
  cliHistoryRecord: 'cliHistory:record',
  cliHistoryClear: 'cliHistory:clear',

  logDates: 'log:dates',
  logRead: 'log:read',
  logDir: 'log:dir',
  logOpenDir: 'log:openDir',
  /** 渲染层错误落盘（fire-and-forget，主进程写 errors-yyyymmdd.log） */
  logRendererError: 'log:rendererError',

  fileSaveText: 'file:saveText',
  fileSaveBytes: 'file:saveBytes',

  connectionList: 'connection:list',
  connectionSave: 'connection:save',
  connectionRemove: 'connection:remove',
  connectionSetPinned: 'connection:setPinned',
  connectionReorder: 'connection:reorder',
  connectionExport: 'connection:export',
  connectionImportPick: 'connection:importPick',
  connectionImportApply: 'connection:importApply',
  connectionImportCancel: 'connection:importCancel',
  connectionSaveMany: 'connection:saveMany',
  connectionTest: 'connection:test',
  connectionConnect: 'connection:connect',
  connectionDisconnect: 'connection:disconnect',
  connectionStatus: 'connection:status',

  redisInfo: 'redis:info',
  redisMetrics: 'redis:metrics',
  redisVersionInfo: 'redis:versionInfo',
  redisSlowlog: 'redis:slowlog',
  redisSlowlogReset: 'redis:slowlogReset',
  redisMemoryAnalysis: 'redis:memoryAnalysis',

  pubsubSubscribe: 'pubsub:subscribe',
  pubsubUnsubscribe: 'pubsub:unsubscribe',
  pubsubPublish: 'pubsub:publish',
  pubsubStop: 'pubsub:stop',
  /** 主 → 渲染：Pub/Sub 消息推送（非 invoke 型，由 preload 直接监听） */
  pubsubMessage: 'pubsub:message',

  redisKeyspaceConfig: 'redis:keyspaceConfig',
  redisKeyspaceSetConfig: 'redis:keyspaceSetConfig',
  keyspaceSubscribe: 'keyspace:subscribe',
  keyspaceUnsubscribe: 'keyspace:unsubscribe',
  keyspaceStop: 'keyspace:stop',
  /** 主 → 渲染：键空间通知事件推送（非 invoke 型） */
  keyspaceEvent: 'keyspace:event',
  /** 主 → 渲染：全库搜索进度推送（非 invoke 型，由 preload 直接监听） */
  redisSearchProgress: 'redis:searchProgress',
  redisSearchAll: 'redis:searchAll',
  redisSearchCancel: 'redis:searchCancel',
  redisDatabases: 'redis:databases',
  redisScan: 'redis:scan',
  redisLookupKey: 'redis:lookupKey',
  redisRefreshKeys: 'redis:refreshKeys',
  redisValue: 'redis:value',
  redisValueBinary: 'redis:valueBinary',
  redisValuePage: 'redis:valuePage',
  redisSetValue: 'redis:setValue',
  redisDelete: 'redis:delete',
  redisSetTtl: 'redis:setTtl',
  redisRename: 'redis:rename',
  redisDelHashField: 'redis:delHashField',
  redisSetHashField: 'redis:setHashField',
  redisHashFieldTtls: 'redis:hashFieldTtls',
  redisSetHashFieldTtl: 'redis:setHashFieldTtl',
  redisSetListElement: 'redis:setListElement',
  redisDelListElement: 'redis:delListElement',
  redisInsertListElement: 'redis:insertListElement',
  redisAppendListElement: 'redis:appendListElement',
  redisSetSetMember: 'redis:setSetMember',
  redisDelSetMember: 'redis:delSetMember',
  redisAddSetMember: 'redis:addSetMember',
  redisSetZsetMember: 'redis:setZsetMember',
  redisDelZsetMember: 'redis:delZsetMember',
  redisAddZsetMember: 'redis:addZsetMember',
  redisXaddEntry: 'redis:xaddEntry',
  redisStreamGroups: 'redis:streamGroups',
  redisStreamConsumers: 'redis:streamConsumers',
  redisStreamPendingSummary: 'redis:streamPendingSummary',
  redisStreamPending: 'redis:streamPending',
  redisStreamGroupCreate: 'redis:streamGroupCreate',
  redisStreamGroupDestroy: 'redis:streamGroupDestroy',
  redisStreamGroupSetId: 'redis:streamGroupSetId',
  redisStreamAck: 'redis:streamAck',
  redisStreamClaim: 'redis:streamClaim',
  redisStreamDel: 'redis:streamDel',
  redisStreamTrim: 'redis:streamTrim',
  redisCreateKey: 'redis:createKey',
  redisCli: 'redis:cli',

  /*
   * Memcached 通道独立命名空间。
   * 与 redis:* 分开而不是复用 redis:* 加引擎参数：
   *   · 两者参数与返回结构完全不同（stats vs info、slab vs db）；
   *   · 复用会让 IPC 层堆积 if (engine === ...) 分支，
   *     正是要避免的耦合；
   *   · 新增引擎时只加自己的前缀，不动已有通道。
   */
  memcachedOverview: 'memcached:overview',
  memcachedSlabs: 'memcached:slabs',
  memcachedKeys: 'memcached:keys',
  memcachedGet: 'memcached:get',
  memcachedGetBinary: 'memcached:getBinary',
  memcachedSet: 'memcached:set',
  memcachedRemove: 'memcached:remove',
  memcachedRename: 'memcached:rename',
  memcachedTouch: 'memcached:touch',
  memcachedFlush: 'memcached:flush',

  windowMinimize: 'window:minimize',
  windowMaxToggle: 'window:maxToggle',
  windowClose: 'window:close',
  windowState: 'window:state',
  /** 主 → 渲染：用户点了关闭按钮，请弹自绘确认框 */
  appBeforeClose: 'app:beforeClose',
  /** 渲染 → 主：确认框已弹出，取消兜底强制关闭 */
  appCloseHandled: 'app:closeHandled',
  /** 渲染 → 主：确认退出（invoke 型，主进程 destroy 窗口） */
  appConfirmClose: 'app:confirmClose',
  /** 主 → 渲染：最大化状态变化（非 invoke 型，由 preload 直接监听） */
  windowStateChanged: 'window:stateChanged',
  /** 主 → 渲染：连接被动断开 / 重连 / 断死（非 invoke 型） */
  connectionStatusChanged: 'connection:statusChanged',
} as const

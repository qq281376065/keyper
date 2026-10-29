import type {
  ApiResponse,
  AppSettings,
  CliResult,
  ConnectionStatus,
  ConnectionState,
  DatabaseInfo,
  EnvInfo,
  ErrorReport,
  KeyValue,
  LogEntry,
  LogFileInfo,
  LogQuery,
  MemoryAnalysis,
  OperationResult,
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
  }

  connection: {
    list: () => Promise<ApiResponse<RedisConnectionConfig[]>>
    save: (config: RedisConnectionConfig) => Promise<ApiResponse<RedisConnectionConfig[]>>
    remove: (id: string) => Promise<ApiResponse<RedisConnectionConfig[]>>
    /**
     * 置顶 / 取消置顶。
     *
     * 专用通道而非复用 save：save 需要传全量配置（含密码），
     * 而 credentialError 场景下 password 已是 undefined，
     * 拿现有条目组一个全量对象再存会把密文抹掉；
     * 这里只改 pinned 一个字段，主进程在磁盘条目上原位修改，完全不碰凭据。
     */
    setPinned: (id: string, pinned: boolean) => Promise<ApiResponse<RedisConnectionConfig[]>>
    /**
     * 拖拽排序：把全量连接 id 按新的显示顺序写回磁盘数组。
     * 磁盘数组顺序即列表排序 —— 加载时渲染端做置顶优先的稳定排序，
     * 组内先后完全由这里落盘的顺序决定。
     */
    reorder: (ids: string[]) => Promise<ApiResponse<RedisConnectionConfig[]>>
    test: (config: RedisConnectionConfig) => Promise<ApiResponse<OperationResult>>
    connect: (config: RedisConnectionConfig) => Promise<ApiResponse<ConnectionState>>
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
    value: (id: string, key: string) => Promise<ApiResponse<KeyValue>>
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
    /** 向 stream 追加一条 entry（XADD，ID 由服务端 * 自动生成——单调约束手工填必错） */
    xaddEntry: (
      id: string,
      key: string,
      field: string,
      value: string,
    ) => Promise<ApiResponse<OperationResult>>
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

  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  settingsConfigInfo: 'settings:configInfo',

  searchHistoryGet: 'searchHistory:get',
  searchHistoryRecord: 'searchHistory:record',
  searchHistoryRemove: 'searchHistory:remove',
  searchHistoryClear: 'searchHistory:clear',

  logDates: 'log:dates',
  logRead: 'log:read',
  logDir: 'log:dir',
  logOpenDir: 'log:openDir',
  /** 渲染层错误落盘（fire-and-forget，主进程写 errors-yyyymmdd.log） */
  logRendererError: 'log:rendererError',

  fileSaveText: 'file:saveText',

  connectionList: 'connection:list',
  connectionSave: 'connection:save',
  connectionRemove: 'connection:remove',
  connectionSetPinned: 'connection:setPinned',
  connectionReorder: 'connection:reorder',
  connectionTest: 'connection:test',
  connectionConnect: 'connection:connect',
  connectionDisconnect: 'connection:disconnect',
  connectionStatus: 'connection:status',

  redisInfo: 'redis:info',
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
  /** 主 → 渲染：全库搜索进度推送（非 invoke 型，由 preload 直接监听） */
  redisSearchProgress: 'redis:searchProgress',
  redisSearchAll: 'redis:searchAll',
  redisSearchCancel: 'redis:searchCancel',
  redisDatabases: 'redis:databases',
  redisScan: 'redis:scan',
  redisLookupKey: 'redis:lookupKey',
  redisValue: 'redis:value',
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
  redisCreateKey: 'redis:createKey',
  redisCli: 'redis:cli',

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

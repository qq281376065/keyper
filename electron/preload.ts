import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/api'
import type { RedisDesktopApi } from '../shared/api'
import type {
  ApiResponse,
  AppSettings,
  CliResult,
  ConnectionExportOptions,
  ConnectionExportResult,
  ConnectionImportApplyOptions,
  ConnectionImportPreview,
  ConnectionImportResult,
  ConnectionStatus,
  ConnectionState,
  DatabaseInfo,
  EnvInfo,
  ErrorReport,
  KeyValue,
  KeyspaceConfig,
  KeyspaceEvent,
  LogEntry,
  LogFileInfo,
  LogQuery,
  MetricsSample,
  UpdateCheckResult,
  UpdateDownloadState,
  MemoryAnalysis,
  MemcachedKeyList,
  MemcachedOverview,
  MemcachedSlab,
  MemcachedValue,
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
  ValuePageOptions,
  ValuePageResult,
  ValueReadOptions,
  RefreshKeysOptions,
  RefreshKeysResult,
} from '../shared/types'

function invoke<T>(channel: string, ...args: unknown[]): Promise<ApiResponse<T>> {
  return ipcRenderer.invoke(channel, ...args.map(toPlain)) as Promise<ApiResponse<T>>
}

/**
 * 把参数转成「可结构化克隆」的纯数据。
 *
 * ⚠️ 这一步必须在 preload 里做，而不是在渲染层用 Proxy 包 api 对象：
 *
 * 1. Vue 3 的 reactive() 返回 Proxy，`ipcRenderer.invoke` 用结构化克隆
 *    序列化参数，Proxy 无法克隆，直接抛
 *    `An Object could not be cloned.` —— 这是断线重连 / 仅保存后连不上的根因。
 *
 * 2. 但不能用 `new Proxy(bridge, ...)` 去包 contextBridge 暴露的对象。
 *    exposeInMainWorld 暴露出的属性是**只读且不可配置**的，
 *    Proxy 的 get trap 若返回一个"包装过的副本"而不是 target 上的原值，
 *    会触发 invariant 错误：
 *      'get' on proxy: property 'xxx' is a read-only and non-configurable
 *      data property on the proxy target but the proxy did not return its
 *      actual value
 *    （正式安装后连接时报的正是这条。）
 *
 * 正确位置是这里：所有 api.* 最终都汇聚到 invoke()，
 * 在调用 ipcRenderer.invoke 之前把参数洗成纯数据，
 * 既修了 Proxy 无法克隆的问题，又完全不碰 contextBridge 暴露对象的属性语义。
 */
function toPlain<T>(value: T): T {
  if (value === null || value === undefined) return value
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    /*
     * 序列化失败（如循环引用）时返回原值，让真正的 IPC 错误在调用处暴露。
     */
    return value
  }
}

const api: RedisDesktopApi = {
  app: {
    getVersion: () => invoke<string>(IPC.appVersion),
    getEnvInfo: () => invoke<EnvInfo>(IPC.appEnvInfo),
  },

  settings: {
    get: () => invoke<AppSettings>(IPC.settingsGet),
    save: (patch) => invoke<AppSettings>(IPC.settingsSave, patch),
    configInfo: () =>
      invoke<{ dir: string; portable: boolean; reason: string | null }>(IPC.settingsConfigInfo),
  },

  searchHistory: {
    get: (connId, db) => invoke<SearchHistoryEntry[]>(IPC.searchHistoryGet, connId, db),
    record: (connId, db, term) => invoke<SearchHistoryEntry[]>(IPC.searchHistoryRecord, connId, db, term),
    remove: (connId, db, term) => invoke<SearchHistoryEntry[]>(IPC.searchHistoryRemove, connId, db, term),
    clear: (connId, db) => invoke<SearchHistoryEntry[]>(IPC.searchHistoryClear, connId, db),
  },

  update: {
    check: () => invoke<UpdateCheckResult>(IPC.updateCheck),
    openPage: (url: string) => invoke<OperationResult>(IPC.updateOpenPage, url),
    state: () => invoke<UpdateDownloadState>(IPC.updateState),
    download: (version: string) => invoke<UpdateDownloadState>(IPC.updateDownload, version),
    install: () => invoke<OperationResult>(IPC.updateInstall),
    /* 主进程推送下载进度：与 window.onStateChange 相同的桥接模式 */
    onStateChange: (listener) => {
      const raw = (_event: Electron.IpcRendererEvent, payload: UpdateDownloadState): void =>
        listener(payload)
      ipcRenderer.on(IPC.updateStateChanged, raw)
      return () => {
        ipcRenderer.removeListener(IPC.updateStateChanged, raw)
      }
    },
  },

  log: {
    dates: () => invoke<LogFileInfo[]>(IPC.logDates),
    read: (query: LogQuery) => invoke<LogEntry[]>(IPC.logRead, query),
    dir: () => invoke<string>(IPC.logDir),
    openDir: () => invoke<OperationResult>(IPC.logOpenDir),
    reportError: (report: ErrorReport) => invoke<OperationResult>(IPC.logRendererError, report),
  },

  file: {
    saveText: (options) => invoke<{ saved: boolean; path?: string }>(IPC.fileSaveText, options),
  },

  connection: {
    list: () => invoke<RedisConnectionConfig[]>(IPC.connectionList),
    save: (config) => invoke<RedisConnectionConfig[]>(IPC.connectionSave, config),
    remove: (id) => invoke<RedisConnectionConfig[]>(IPC.connectionRemove, id),
    setPinned: (id, pinned) => invoke<RedisConnectionConfig[]>(IPC.connectionSetPinned, id, pinned),
    reorder: (ids) => invoke<RedisConnectionConfig[]>(IPC.connectionReorder, ids),
    exportToFile: (options: ConnectionExportOptions) =>
      invoke<ConnectionExportResult>(IPC.connectionExport, options),
    importPick: () => invoke<ConnectionImportPreview | null>(IPC.connectionImportPick),
    importApply: (token: string, options: ConnectionImportApplyOptions) =>
      invoke<ConnectionImportResult>(IPC.connectionImportApply, token, options),
    importCancel: (token: string) => invoke<OperationResult>(IPC.connectionImportCancel, token),
    saveMany: (configs) => invoke<ConnectionImportResult>(IPC.connectionSaveMany, configs),
    test: (config) => invoke<OperationResult>(IPC.connectionTest, config),
    connect: (config) => invoke<ConnectionState>(IPC.connectionConnect, config),
    disconnect: (id) => invoke<OperationResult>(IPC.connectionDisconnect, id),
    status: (id) => invoke<boolean>(IPC.connectionStatus, id),
    /*
     * 主进程推送连接被动状态变化（断开 / 重连中 / 断死）。
     * 与 window.onStateChange 相同的桥接模式：listener 是主世界传来的
     * 函数引用，contextBridge 允许函数跨世界调用（sanitize 对函数放行）。
     */
    onStatusChange: (listener) => {
      const raw = (
        _event: Electron.IpcRendererEvent,
        payload: { id: string; status: ConnectionStatus; message?: string },
      ): void => listener(payload)
      ipcRenderer.on(IPC.connectionStatusChanged, raw)
      return () => {
        ipcRenderer.removeListener(IPC.connectionStatusChanged, raw)
      }
    },
  },

  redis: {
    info: (id) => invoke<ServerInfo>(IPC.redisInfo, id),
    versionInfo: (id) => invoke<VersionInfo>(IPC.redisVersionInfo, id),
    slowlog: (id, count) => invoke<SlowlogOverview>(IPC.redisSlowlog, id, count),
    slowlogReset: (id) => invoke<OperationResult>(IPC.redisSlowlogReset, id),
    memoryAnalysis: (id, depth) => invoke<MemoryAnalysis>(IPC.redisMemoryAnalysis, id, depth),
    metrics: (id) => invoke<MetricsSample>(IPC.redisMetrics, id),
    keyspaceConfig: (id) => invoke<KeyspaceConfig>(IPC.redisKeyspaceConfig, id),
    setKeyspaceConfig: (id, events) =>
      invoke<OperationResult>(IPC.redisKeyspaceSetConfig, id, events),
    keyspaceSubscribe: (id, patterns) => invoke<PubsubState>(IPC.keyspaceSubscribe, id, patterns),
    keyspaceUnsubscribe: (id, patterns) => invoke<PubsubState>(IPC.keyspaceUnsubscribe, id, patterns),
    keyspaceStop: (id) => invoke<OperationResult>(IPC.keyspaceStop, id),
    onKeyspaceEvent: (listener) => {
      const raw = (_event: Electron.IpcRendererEvent, payload: KeyspaceEvent): void => listener(payload)
      ipcRenderer.on(IPC.keyspaceEvent, raw)
      return () => {
        ipcRenderer.removeListener(IPC.keyspaceEvent, raw)
      }
    },
    pubsubSubscribe: (id, targets, pattern) => invoke<PubsubState>(IPC.pubsubSubscribe, id, targets, pattern),
    pubsubUnsubscribe: (id, targets, pattern) => invoke<PubsubState>(IPC.pubsubUnsubscribe, id, targets, pattern),
    pubsubPublish: (id, channel, message) => invoke<number>(IPC.pubsubPublish, id, channel, message),
    pubsubStop: (id) => invoke<OperationResult>(IPC.pubsubStop, id),
    /*
     * Pub/Sub 消息订阅：与 onStatusChange 相同的桥接模式
     * （主进程推送无 invoke 请求可挂，直接挂监听）。
     */
    onPubsubMessage: (listener) => {
      const raw = (_event: Electron.IpcRendererEvent, message: PubsubMessage): void => listener(message)
      ipcRenderer.on(IPC.pubsubMessage, raw)
      return () => {
        ipcRenderer.removeListener(IPC.pubsubMessage, raw)
      }
    },
    /*
     * 全库搜索进度订阅：与 onPubsubMessage 相同的桥接模式
     * （主进程 SCAN 循环逐批推送，无 invoke 请求可挂）。
     */
    onSearchProgress: (listener) => {
      const raw = (_event: Electron.IpcRendererEvent, progress: SearchProgress): void => listener(progress)
      ipcRenderer.on(IPC.redisSearchProgress, raw)
      return () => {
        ipcRenderer.removeListener(IPC.redisSearchProgress, raw)
      }
    },
    databases: (id) => invoke<DatabaseInfo[]>(IPC.redisDatabases, id),
    scan: (id, options?: ScanOptions) => invoke<ScanResult>(IPC.redisScan, id, options),
    lookupKey: (id, key, db) => invoke<RedisKeyItem | null>(IPC.redisLookupKey, id, key, db),
    searchAll: (id, options) => invoke<SearchAllResult>(IPC.redisSearchAll, id, options),
    searchCancel: (id) => invoke<OperationResult>(IPC.redisSearchCancel, id),
    refreshKeys: (id, options?: RefreshKeysOptions) =>
      invoke<RefreshKeysResult>(IPC.redisRefreshKeys, id, options),
    value: (id, key, options?: ValueReadOptions) => invoke<KeyValue>(IPC.redisValue, id, key, options),
    valuePage: (id, key, options: ValuePageOptions) =>
      invoke<ValuePageResult>(IPC.redisValuePage, id, key, options),
    setValue: (
      id: string,
      key: string,
      type: RedisValueType,
      payload: string | string[] | Record<string, string>,
      ttlSeconds?: number,
      isNew?: boolean,
    ) => invoke<OperationResult>(IPC.redisSetValue, id, key, type, payload, ttlSeconds, isNew),
    remove: (id, keys) => invoke<OperationResult>(IPC.redisDelete, id, keys),
    setTtl: (id, key, seconds) => invoke<OperationResult>(IPC.redisSetTtl, id, key, seconds),
    rename: (id, key, newKey) => invoke<OperationResult>(IPC.redisRename, id, key, newKey),
    delHashField: (id, key, field) => invoke<OperationResult>(IPC.redisDelHashField, id, key, field),
    setHashField: (id, key, field, value, nextField, keepTtlSeconds) =>
      invoke<OperationResult>(IPC.redisSetHashField, id, key, field, value, nextField, keepTtlSeconds),
    hashFieldTtls: (id, key, fields) =>
      invoke<Record<string, number> | null>(IPC.redisHashFieldTtls, id, key, fields),
    setHashFieldTtl: (id, key, field, seconds) =>
      invoke<OperationResult>(IPC.redisSetHashFieldTtl, id, key, field, seconds),
    setListElement: (id, key, index, value) =>
      invoke<OperationResult>(IPC.redisSetListElement, id, key, index, value),
    delListElement: (id, key, index) =>
      invoke<OperationResult>(IPC.redisDelListElement, id, key, index),
    appendListElement: (id, key, value) =>
      invoke<OperationResult>(IPC.redisAppendListElement, id, key, value),
    setSetMember: (id, key, member, next) =>
      invoke<OperationResult>(IPC.redisSetSetMember, id, key, member, next),
    delSetMember: (id, key, member) =>
      invoke<OperationResult>(IPC.redisDelSetMember, id, key, member),
    addSetMember: (id, key, member) =>
      invoke<OperationResult>(IPC.redisAddSetMember, id, key, member),
    setZsetMember: (id, key, member, nextMember, nextScore) =>
      invoke<OperationResult>(IPC.redisSetZsetMember, id, key, member, nextMember, nextScore),
    delZsetMember: (id, key, member) =>
      invoke<OperationResult>(IPC.redisDelZsetMember, id, key, member),
    addZsetMember: (id, key, member, score) =>
      invoke<OperationResult>(IPC.redisAddZsetMember, id, key, member, score),
    xaddEntry: (id, key, field, value) =>
      invoke<OperationResult>(IPC.redisXaddEntry, id, key, field, value),
    insertListElement: (id, key, index, value, position) =>
      invoke<OperationResult>(IPC.redisInsertListElement, id, key, index, value, position),
    createKey: (
      id: string,
      key: string,
      type: RedisValueType,
      payload?: string | string[] | Record<string, string>,
      ttlSeconds?: number,
    ) => invoke<OperationResult>(IPC.redisCreateKey, id, key, type, payload, ttlSeconds),
    cli: (id, command) => invoke<CliResult>(IPC.redisCli, id, command),
  },

  /*
   * Memcached 通道：与上面的 redis 并列，互不引用。
   * 渲染层按连接的 engine 选一组调用，不存在"两个引擎共用一条通道"。
   */
  memcached: {
    overview: (id) => invoke<MemcachedOverview>(IPC.memcachedOverview, id),
    slabs: (id) => invoke<MemcachedSlab[]>(IPC.memcachedSlabs, id),
    keys: (id, options) => invoke<MemcachedKeyList>(IPC.memcachedKeys, id, options),
    get: (id, key) => invoke<MemcachedValue>(IPC.memcachedGet, id, key),
    set: (id, key, value, options) =>
      invoke<OperationResult>(IPC.memcachedSet, id, key, value, options),
    remove: (id, key) => invoke<OperationResult>(IPC.memcachedRemove, id, key),
    touch: (id, key, seconds) => invoke<OperationResult>(IPC.memcachedTouch, id, key, seconds),
    rename: (id, key, newKey) =>
      invoke<OperationResult>(IPC.memcachedRename, id, key, newKey),
    flush: (id) => invoke<OperationResult>(IPC.memcachedFlush, id),
  },

  window: {
    minimize: () => invoke<null>(IPC.windowMinimize),
    maxToggle: () => invoke<null>(IPC.windowMaxToggle),
    close: () => invoke<null>(IPC.windowClose),
    state: () => invoke<{ maximized: boolean }>(IPC.windowState),
    /*
     * 订阅型接口：不走 invoke，直接挂 ipcRenderer 监听。
     * listener 是主世界传来的函数 —— contextBridge 会把它桥接成
     * 隔离世界可调用的引用；主世界侧 wrapApi 的 sanitize 对函数参数
     * 原样放行（typeof 'function' 不是 'object'，JSON 清洗不会碰它）。
     */
    onStateChange: (listener) => {
      const raw = (_event: Electron.IpcRendererEvent, payload: { maximized: boolean }): void =>
        listener(payload)
      ipcRenderer.on(IPC.windowStateChanged, raw)
      return () => {
        ipcRenderer.removeListener(IPC.windowStateChanged, raw)
      }
    },
    /* 主进程拦下关闭后通知渲染层弹自绘确认框 */
    onBeforeClose: (listener) => {
      const raw = (): void => listener()
      ipcRenderer.on(IPC.appBeforeClose, raw)
      return () => {
        ipcRenderer.removeListener(IPC.appBeforeClose, raw)
      }
    },
    /* 确认框已弹出：让主进程取消兜底强制关闭 */
    closeHandled: () => ipcRenderer.send(IPC.appCloseHandled),
    /* 用户在确认框里点了「退出」：单向下发，不关心回包 */
    confirmClose: () => ipcRenderer.send(IPC.appConfirmClose),
  },
}

contextBridge.exposeInMainWorld('redisApi', api)

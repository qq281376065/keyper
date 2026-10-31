import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import fs from 'node:fs'
import { IPC } from '../../shared/api'
import { t } from '@shared/i18n'
import type {
  CacheConnectionConfig,
  CacheEngine,
  MemcachedConnectionConfig,
  MemcachedKeyList,
  MemcachedOverview,
  MemcachedSlab,
  MemcachedValue,
} from '../../shared/types'
import { connectionManager } from '../services/connection-manager'
import { memcachedManager } from '../services/engines/memcached/manager'
import { getEngine, registerEngine } from '../services/engines/registry'
import { loadConnections, saveConnections } from '../services/connection-store'
import { appendErrorLog, appendLog, listLogFiles, logDir, openLogDir, readLogs } from '../services/log-service'
import {
  clearSearchHistory,
  getSearchHistory,
  recordSearchHistory,
  removeSearchHistory,
  pruneConnectionSearchHistory,
} from '../services/search-history-store'
import { loadSettings, saveSettings } from '../services/settings-store'
import { configInfo } from '../services/config-path'
import { CLOSE_CONFIRM, CLOSE_HANDLED, closeSignal } from '../services/close-signal'
import { checkForUpdate, openUpdatePage } from '../services/update-service'
import {
  checkForAutoUpdate,
  downloadAutoUpdate,
  getUpdateState,
  installAutoUpdate,
  isAutoUpdateEnabled,
  onUpdateState,
} from '../services/auto-update'
import type {
  ApiResponse,
  AppSettings,
  CliResult,
  ConnectionState,
  DatabaseInfo,
  EnvInfo,
  ErrorReport,
  KeyValue,
  KeyspaceConfig,
  LogEntry,
  LogFileInfo,
  LogQuery,
  MemoryAnalysis,
  MetricsSample,
  OperationResult,
  RedisConnectionConfig,
  UpdateCheckResult,
  UpdateDownloadState,
  RedisKeyItem,
  RedisValueType,
  ScanOptions,
  SearchAllOptions,
  SearchAllResult,
  SearchHistoryEntry,
  ScanResult,
  ServerInfo,
  SlowlogOverview,
  PubsubState,
  VersionInfo,
  ValuePageOptions,
  ValuePageResult,
  ValueReadOptions,
  RefreshKeysOptions,
  RefreshKeysResult,
} from '../../shared/types'

function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data }
}

function fail(error: unknown): ApiResponse<never> {
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, error: message }
}

/**
 * 业务层返回 { ok:false } 视为失败，统一转成错误通道，
 * 避免渲染进程需要区分「传输成功」和「业务成功」两层 ok 字段。
 */
function unwrap<T>(value: T): T {
  const maybe = value as unknown as { ok?: boolean; message?: string }
  if (maybe && typeof maybe === 'object' && maybe.ok === false) {
    throw new Error(maybe.message || t('connectionActions.operationFailed'))
  }
  return value
}

/**
 * 需要写入手动操作日志的通道 → 日志中的操作名。
 *
 * 设计要点：日志只在 IPC 层落盘，意味着「用户显式触发的操作」才会被记录；
 * 主进程内部的自动任务（定时刷新、内部遍历等）不经过 IPC，天然不会进入日志。
 * 读取类通道（scan / value / info）同样不记录，避免浏览行为淹没关键操作。
 *
 * 操作名保持中文原文入库（不随界面语言变化）：渲染层据此做「变更 / 删除」
 * 分级与筛选，日志文件中也是稳定可 grep 的取值；显示时由 LogPanel 用
 * t(entry.action) 翻译。详情与结果在写入时按当时语言落盘 —— 它们是历史记录，
 * 不该在语言切换后集体改写。
 */
const LOG_ACTIONS: Record<string, string> = {
  [IPC.connectionConnect]: '建立连接',
  [IPC.connectionDisconnect]: '断开连接',
  [IPC.connectionSave]: '保存配置',
  [IPC.connectionRemove]: '删除配置',
  [IPC.redisSetValue]: '写入键',
  [IPC.redisCreateKey]: '新建键',
  [IPC.redisDelete]: '删除键',
  [IPC.redisSetTtl]: '设置 TTL',
  [IPC.redisRename]: '重命名键',
  [IPC.redisDelHashField]: '删除字段',
  [IPC.redisSetHashField]: '修改字段',
  [IPC.redisSetHashFieldTtl]: '修改字段 TTL',
  [IPC.redisSetListElement]: '修改元素',
  [IPC.redisDelListElement]: '删除元素',
  [IPC.redisInsertListElement]: '插入元素',
  [IPC.redisAppendListElement]: '追加元素',
  [IPC.redisSetSetMember]: '修改成员',
  [IPC.redisDelSetMember]: '删除成员',
  [IPC.redisAddSetMember]: '新增成员',
  [IPC.redisSetZsetMember]: '修改成员',
  [IPC.redisDelZsetMember]: '删除成员',
  [IPC.redisAddZsetMember]: '新增成员',
  [IPC.redisXaddEntry]: '追加消息',
  [IPC.redisCli]: '命令',
  /* Memcached：只记录写入类操作与清空，读操作不进日志（与 Redis 一致） */
  [IPC.memcachedSet]: '写入键',
  [IPC.memcachedRemove]: '删除键',
  [IPC.memcachedTouch]: '设置 TTL',
  [IPC.memcachedRename]: '重命名键',
  [IPC.memcachedFlush]: '清空数据',
}

function connectionLabel(id: string): string {
  const config = loadConnections().find((item) => item.id === id)
  return config ? config.name : id
}

/**
 * 按连接 id 反查引擎。
 * 日志要按引擎分列，而绝大多数通道只带 id 不带完整配置 ——
 * 查一次内存中的配置列表即可（loadConnections 有缓存，不额外读盘）。
 * 找不到时回退 redis：历史日志与历史连接都是 Redis。
 */
function engineOfId(id: string): CacheEngine {
  const config = loadConnections().find((item) => item.id === id)
  return config?.engine ?? 'redis'
}

/**
 * 从各通道的参数里提取「连接名 + 操作详情」。
 * 注意：必须在 handler 执行前调用 —— 删除连接后配置已不存在，就取不到名称了。
 */
function describe(
  channel: string,
  args: unknown[],
): { connectionName: string; detail: string; engine: CacheEngine } {
  const first = args[0]

  if (typeof first === 'string') {
    const connectionName = connectionLabel(first)
    const engine = engineOfId(first)
    switch (channel) {
      case IPC.redisCli:
        return { connectionName, engine, detail: String(args[1] ?? '') }
      case IPC.memcachedSet:
        return {
          connectionName,
          engine,
          detail: `${args[1]}${args[3] && (args[3] as { exptime?: number }).exptime ? ` (expire ${(args[3] as { exptime: number }).exptime}s)` : ''}`,
        }
      case IPC.memcachedRemove:
        return { connectionName, engine, detail: String(args[1] ?? '') }
      case IPC.memcachedTouch:
        return {
          connectionName,
          engine,
          detail: `${args[1]} → ${(args[2] as number) < 0 ? t('bulkOpsPanel.notSet') : `${args[2]}s`}`,
        }
      case IPC.memcachedRename:
        return { connectionName, engine, detail: `${args[1]} → ${args[2]}` }
      case IPC.memcachedFlush:
        return { connectionName, engine, detail: 'flush_all' }
      case IPC.redisCreateKey:
        return { connectionName, engine, detail: `${args[1]} (${args[2]})` }
      case IPC.redisSetValue:
        return { connectionName, engine, detail: `${args[1]} (${args[2]})` }
      case IPC.redisDelete:
        return { connectionName, engine, detail: ((args[1] as string[]) ?? []).join(', ') }
      case IPC.redisSetTtl:
        return { connectionName, engine, detail: `${args[1]} → ${args[2]}s` }
      case IPC.redisRename:
        return { connectionName, engine, detail: `${args[1]} → ${args[2]}` }
      case IPC.redisDelHashField:
        return { connectionName, engine, detail: `${args[1]} · ${args[2]}` }
      case IPC.redisSetHashField:
        return {
          connectionName,
          engine,
          detail:
            args[4] && args[4] !== args[2]
              ? `${args[1]} · ${args[2]} → ${args[4]}`
              : `${args[1]} · ${args[2]}`,
        }
      case IPC.redisSetHashFieldTtl:
        return { connectionName, engine, detail: `${args[1]} · ${args[2]} → ${args[3]}s` }
      case IPC.redisSetListElement:
        return {
          connectionName,
          engine,
          detail: t('ipc.keyItemIndex', { key: String(args[1]), index: (args[2] as number) + 1 }),
        }
      case IPC.redisDelListElement:
        return {
          connectionName,
          engine,
          detail: t('ipc.keyItemIndex', { key: String(args[1]), index: (args[2] as number) + 1 }),
        }
      case IPC.redisInsertListElement:
        return {
          connectionName,
          engine,
          detail:
            args[4] === 'before'
              ? t('ipc.keyBeforeItemIndex', { key: String(args[1]), index: (args[2] as number) + 1 })
              : t('ipc.keyAfterItemIndex', { key: String(args[1]), index: (args[2] as number) + 1 }),
        }
      case IPC.redisAppendListElement:
        return { connectionName, engine, detail: args[1] as string }
      case IPC.redisSetSetMember:
        return { connectionName, engine, detail: `${args[1]} · ${args[2]} → ${args[3]}` }
      case IPC.redisDelSetMember:
        return { connectionName, engine, detail: `${args[1]} · ${args[2]}` }
      case IPC.redisAddSetMember:
        return { connectionName, engine, detail: `${args[1]} · ${args[2]}` }
      case IPC.redisSetZsetMember:
        return {
          connectionName,
          engine,
          detail:
            args[2] === args[3]
              ? `${args[1]} · ${args[2]} → score ${args[4]}`
              : `${args[1]} · ${args[2]} → ${args[3]}`,
        }
      case IPC.redisDelZsetMember:
        return { connectionName, engine, detail: `${args[1]} · ${args[2]}` }
      case IPC.redisAddZsetMember:
        return { connectionName, engine, detail: `${args[1]} · ${args[2]} (${args[3]})` }
      case IPC.redisXaddEntry:
        return { connectionName, engine, detail: `${args[1]} · ${args[2]} = ${String(args[3]).slice(0, 40)}` }
      default:
        return { connectionName, engine, detail: connectionName }
    }
  }

  if (first && typeof first === 'object') {
    const config = first as CacheConnectionConfig
    return {
      connectionName: config.name || config.host,
      engine: config.engine ?? 'redis',
      /* 详情按引擎给：Memcached 没有库，拼 /db 会写出不存在的信息 */
      detail:
        config.engine === 'memcached'
          ? `${config.host}:${config.port}`
          : `${config.host}:${config.port}/${(config as RedisConnectionConfig).db}`,
    }
  }

  return { connectionName: '-', engine: 'redis', detail: '' }
}

/**
 * 统一的 IPC 注册器：负责错误捕获、响应包裹与手动操作日志。
 * 参数为透传，具体类型由各 handler 内部收敛。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handle<T>(channel: string, handler: (...args: any[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    const started = Date.now()
    const action = LOG_ACTIONS[channel]
    const meta = action ? describe(channel, args) : null

    let response: ApiResponse<T>
    try {
      const result = await handler(...args)
      response = ok(unwrap(result))
    } catch (error) {
      console.error(`[ipc] ${channel} 执行失败:`, error)
      response = fail(error)
    }

    if (action && meta) {
      const data = response.ok ? (response.data as unknown as { message?: string }) : null
      appendLog({
        timestamp: Date.now(),
        engine: meta.engine,
        connectionId: typeof args[0] === 'string' ? (args[0] as string) : '',
        connectionName: meta.connectionName,
        action,
        detail: meta.detail || '-',
        ok: response.ok,
        result: response.ok ? (data?.message ?? t('ipc.succeeded')) : response.error,
        costMs: Date.now() - started,
      })
    }

    return response
  })
}

export function registerIpcHandlers(): void {
  // -------------------------------------------------------- 连接状态推送（主 → 渲染）
  /*
   * 被动断线 / 重连结果没有对应的 invoke 请求可挂，
   * 由 connectionManager 的生命周期监听触发，广播给所有窗口。
   * 用户主动操作（connect/disconnect）的返回值已携带状态，不走这条路。
   */
  connectionManager.onStatusChange((payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.connectionStatusChanged, payload)
    }
  })

  /*
   * Pub/Sub 消息推送：与连接状态推送同构 —— 订阅模式下消息
   * 没有对应的 invoke 请求可挂，只能由主进程主动广播。
   */
  connectionManager.onPubsubMessage((message) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.pubsubMessage, message)
    }
  })

  /*
   * 全库搜索进度推送：与 Pub/Sub 消息推送同构 ——
   * 主进程内的 SCAN 循环逐批发进度，渲染层据此实时显示「已找到 N 条」。
   */
  connectionManager.onSearchProgress((progress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.redisSearchProgress, progress)
    }
  })

  /* 键空间事件推送：与 Pub/Sub 同构，由独立的 keyspace 连接触发广播 */
  connectionManager.onKeyspaceEvent((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.keyspaceEvent, event)
    }
  })

  /* 更新下载进度 / 完成 / 失败：面板关掉也不丢状态，重开时先拉一次快照 */
  onUpdateState((update) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.updateStateChanged, update)
    }
  })

  // -------------------------------------------------------- 窗口控制
  /*
   * 不走通用 handle：窗口操作没有日志价值，
   * 且需要 event.sender 定位窗口（支持将来多窗口），与通用包装器签名不匹配。
   */
  ipcMain.handle(IPC.windowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
    return ok(null)
  })
  ipcMain.handle(IPC.windowMaxToggle, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.isMaximized()) win.unmaximize()
    else win?.maximize()
    return ok(null)
  })
  ipcMain.handle(IPC.windowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
    return ok(null)
  })
  /*
   * 自绘退出确认框点了「退出」。
   *
   * 这里用 on 而非 handle：退出是一个"动作"，不需要返回值。
   * 具体关闭逻辑由 main.ts 注册的监听器接管（它持有 quitConfirmed
   * 与窗口引用），本模块只负责把信号转过去，不重复维护状态。
   */
  ipcMain.on(IPC.appConfirmClose, () => {
    closeSignal.emit(CLOSE_CONFIRM)
  })
  /* 渲染层已弹出确认框：主进程取消兜底，等用户决定 */
  ipcMain.on(IPC.appCloseHandled, () => {
    closeSignal.emit(CLOSE_HANDLED)
  })
  ipcMain.handle(IPC.windowState, (event) =>
    ok({ maximized: BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false }),
  )

  // -------------------------------------------------------- 应用信息
  handle<string>(IPC.appVersion, () => app.getVersion())

  handle<EnvInfo>(IPC.appEnvInfo, () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? '-',
    chrome: process.versions.chrome ?? '-',
    node: process.versions.node ?? '-',
    v8: process.versions.v8 ?? '-',
    platform: `${process.platform} ${process.arch}`,
    arch: process.arch,
    locale: app.getLocale(),
    inElectron: true,
  }))

  // -------------------------------------------------------- 设置
  handle<AppSettings>(IPC.settingsGet, () => loadSettings())

  handle<AppSettings>(IPC.settingsSave, (patch) =>
    saveSettings((patch ?? {}) as Partial<AppSettings>),
  )

  // 配置文件位置（便携模式可能回退到 userData，界面需要如实告知）
  handle<{ dir: string; portable: boolean; reason: string | null }>(IPC.settingsConfigInfo, () =>
    configInfo(),
  )

  // -------------------------------------------------------- 键搜索历史
  // 四个通道统一返回该桶（connId@db）最新列表，前端免二次 get。
  handle<SearchHistoryEntry[]>(IPC.searchHistoryGet, (connId, db) =>
    getSearchHistory(String(connId), Number(db)),
  )

  handle<SearchHistoryEntry[]>(IPC.searchHistoryRecord, (connId, db, term) =>
    recordSearchHistory(String(connId), Number(db), String(term ?? '')),
  )

  handle<SearchHistoryEntry[]>(IPC.searchHistoryRemove, (connId, db, term) =>
    removeSearchHistory(String(connId), Number(db), String(term ?? '')),
  )

  handle<SearchHistoryEntry[]>(IPC.searchHistoryClear, (connId, db) =>
    clearSearchHistory(String(connId), Number(db)),
  )

  // -------------------------------------------------------- 操作日志
  handle<LogFileInfo[]>(IPC.logDates, () => listLogFiles())

  handle<LogEntry[]>(IPC.logRead, (query) => readLogs((query ?? {}) as LogQuery))

  handle<string>(IPC.logDir, () => logDir())

  handle<OperationResult>(IPC.logOpenDir, async () => {
    await openLogDir()
    return { ok: true, message: t('common.openedLogDirectory') }
  })

  // -------------------------------------------------------- 检查更新
  /*
   * 打包版优先走 electron-updater（能下载、能增量、能安装）；
   * 开发态或更新源不可达时回退到 Gitee tags 检查，保证"有没有新版"
   * 这个问题总有一个答案，而不是只剩一条网络错误。
   */
  handle<UpdateCheckResult>(IPC.updateCheck, async () => {
    if (!isAutoUpdateEnabled()) return checkForUpdate()

    try {
      return await checkForAutoUpdate()
    } catch (error) {
      console.error('[updater] 自动更新检查失败，回退到版本页:', error)
      const fallback = await checkForUpdate()
      return {
        ...fallback,
        notice: t('updateService.autoUpdateUnavailable'),
        canAutoUpdate: false,
      }
    }
  })

  handle<UpdateDownloadState>(IPC.updateState, () => getUpdateState())

  handle<UpdateDownloadState>(IPC.updateDownload, (version) =>
    downloadAutoUpdate(String(version ?? '')),
  )

  handle<OperationResult>(IPC.updateInstall, () => installAutoUpdate())

  handle<OperationResult>(IPC.updateOpenPage, async (url) => openUpdatePage(String(url ?? '')))

  // -------------------------------------------------------- 错误落盘
  // 渲染层错误边界的 fire-and-forget 通道：写入失败也不 reject ——
  // 落盘路径自身的异常绝不能再触发一次「错误 → 落盘 → 出错」的递归。
  handle<OperationResult>(IPC.logRendererError, (report) => {
    try {
      appendErrorLog((report ?? {}) as ErrorReport)
      return { ok: true, message: t('ipc.recorded') }
    } catch {
      return { ok: false, message: t('ipc.failedWriteErrorLog') }
    }
  })

  // -------------------------------------------------------- 文件导出
  handle<{ saved: boolean; path?: string }>(IPC.fileSaveText, async (options) => {
    const payload = (options ?? {}) as { suggestedName?: string; content?: string }
    const result = await dialog.showSaveDialog({
      title: t('ipc.exportContent'),
      defaultPath: payload.suggestedName || 'value.txt',
      filters: [
        { name: t('ipc.textFile'), extensions: ['txt', 'log'] },
        { name: 'JSON', extensions: ['json'] },
        { name: t('ipc.allFiles'), extensions: ['*'] },
      ],
    })

    if (result.canceled || !result.filePath) return { saved: false }
    fs.writeFileSync(result.filePath, payload.content ?? '', 'utf-8')
    return { saved: true, path: result.filePath }
  })

  // -------------------------------------------------------- 连接管理
  handle<CacheConnectionConfig[]>(IPC.connectionList, () => loadConnections())

  handle<CacheConnectionConfig[]>(IPC.connectionSave, (config) => {
    const target = config as RedisConnectionConfig
    const list = loadConnections()
    const index = list.findIndex((item) => item.id === target.id)
    if (index >= 0) list[index] = target
    else list.push(target)
    saveConnections(list)
    return list
  })

  handle<CacheConnectionConfig[]>(IPC.connectionRemove, (id) => {
    const list = loadConnections()
    const removedConn = list.find((item) => item.id === (id as string))
    const next = list.filter((item) => item.id !== (id as string))
    saveConnections(next)
    /*
     * 同步清理该连接的搜索历史（所有 db 的桶）：
     * 连接都没了，历史补全只会指向永远连不回去的键名，
     * 留着既无意义也让 search-history.json 无限膨胀。
     */
    const pruned = pruneConnectionSearchHistory(String(id))
    if (pruned > 0) {
      void appendLog({
        timestamp: Date.now(),
        engine: removedConn?.engine ?? 'redis',
        connectionId: String(id),
        connectionName: removedConn?.name ?? '-',
        action: t('ipc.deleteConfig'),
        detail: t('ipc.alsoClearsCountSearchHistory', { count: pruned }),
        ok: true,
        result: 'ok',
      })
    }
    return next
  })

  /*
   * 置顶：在磁盘条目上原位改一个字段，不经过渲染端重组全量对象。
   * load 出来的条目保持原样回存 —— password 密文原封不动，
   * credentialError 的连接（密码已解不开）也能安全置顶。
   * 取消置顶时写回 undefined，JSON 序列化时该键自然消失，磁盘不留 pinned: false。
   */
  handle<CacheConnectionConfig[]>(IPC.connectionSetPinned, (id, pinned) => {
    const list = loadConnections()
    const target = list.find((item) => item.id === (id as string))
    if (target) target.pinned = (pinned as boolean) || undefined
    saveConnections(list)
    return list
  })

  /*
   * 拖拽排序：磁盘数组顺序即列表排序。
   * 渲染端传全量 id（按新显示顺序），这里原位对象直接重排后落盘 ——
   * 不重构条目，password 密文等原封不动。
   * 不在 ids 里的条目（保存瞬间并发新增）保持原相对顺序追加在末尾，不丢弃。
   */
  handle<CacheConnectionConfig[]>(IPC.connectionReorder, (ids) => {
    const list = loadConnections()
    const order = new Set(ids as string[])
    const byId = new Map(list.map((item) => [item.id, item]))
    const next: CacheConnectionConfig[] = []
    for (const id of order) {
      const item = byId.get(id)
      if (item) next.push(item)
    }
    for (const item of list) if (!order.has(item.id)) next.push(item)
    saveConnections(next)
    return next
  })

  /*
   * 连接相关通道按引擎路由。
   *
   * 这一层是**唯一**知道"两种引擎各自在哪"的地方；
   * 上层的 UI 与下层的管理器互不相识，因此新增引擎时
   * 只需在 registry 里注册，不用改任何调用点。
   */
  registerEngine('redis', {
    connect: (config) => connectionManager.connect(config as RedisConnectionConfig),
    test: (config) => connectionManager.test(config as RedisConnectionConfig),
    disconnect: (id) => connectionManager.disconnect(id as string),
  })
  registerEngine('memcached', {
    connect: (config) => memcachedManager.connect(config as MemcachedConnectionConfig),
    test: (config) => memcachedManager.test(config as MemcachedConnectionConfig),
    disconnect: (id) => memcachedManager.disconnect(id as string),
  })

  handle<OperationResult>(IPC.connectionTest, (config) => {
    const typed = config as CacheConnectionConfig
    return getEngine<ConnectionState, OperationResult>(typed.engine).test(typed)
  })

  handle<ConnectionState>(IPC.connectionConnect, (config) => {
    const typed = config as CacheConnectionConfig
    return getEngine<ConnectionState, OperationResult>(typed.engine).connect(typed)
  })

  handle<OperationResult>(IPC.connectionDisconnect, (id) => {
    /*
     * 断开时按"这条连接实际属于哪个管理器"分发：
     * 只看 id 无法判断引擎（配置文件可能已被删除），
     * 因此先问两个管理器谁持有它；都不持有就视为已断开。
     */
    if (memcachedManager.owns(id as string)) return memcachedManager.disconnect(id as string)
    return connectionManager.disconnect(id as string)
  })

  handle<boolean>(IPC.connectionStatus, (id) => connectionManager.isConnected(id as string))

  // -------------------------------------------------------- 数据浏览
  handle<ServerInfo>(IPC.redisInfo, (id) => connectionManager.serverInfo(id as string))

  handle<VersionInfo>(IPC.redisVersionInfo, (id) => connectionManager.versionInfo(id as string))

  handle<SlowlogOverview>(IPC.redisSlowlog, (id, count) =>
    connectionManager.slowlog(id as string, count as number | undefined),
  )

  handle<void>(IPC.redisSlowlogReset, (id) => connectionManager.slowlogReset(id as string))

  handle<MemoryAnalysis>(IPC.redisMemoryAnalysis, (id, depth) =>
    connectionManager.memoryAnalysis(id as string, depth as number | undefined),
  )

  // -------------------------------------------------------- 监控采样 / 键空间通知
  handle<MetricsSample>(IPC.redisMetrics, (id) => connectionManager.metrics(id as string))

  handle<KeyspaceConfig>(IPC.redisKeyspaceConfig, (id) =>
    connectionManager.keyspaceConfig(id as string),
  )

  handle<OperationResult>(IPC.redisKeyspaceSetConfig, (id, events) =>
    connectionManager.setKeyspaceConfig(id as string, events as string),
  )

  handle<PubsubState>(IPC.keyspaceSubscribe, (id, patterns) =>
    connectionManager.keyspaceSubscribe(id as string, (patterns ?? []) as string[]),
  )

  handle<PubsubState>(IPC.keyspaceUnsubscribe, (id, patterns) =>
    connectionManager.keyspaceUnsubscribe(id as string, (patterns ?? []) as string[]),
  )

  handle<OperationResult>(IPC.keyspaceStop, (id) => {
    connectionManager.keyspaceStop(id as string)
    return { ok: true }
  })

  // -------------------------------------------------------- Pub/Sub
  handle<PubsubState>(IPC.pubsubSubscribe, (id, targets, pattern) =>
    connectionManager.pubsubSubscribe(id as string, (targets ?? []) as string[], pattern as boolean | undefined),
  )

  handle<PubsubState>(IPC.pubsubUnsubscribe, (id, targets, pattern) =>
    connectionManager.pubsubUnsubscribe(id as string, (targets ?? []) as string[], pattern as boolean | undefined),
  )

  handle<number>(IPC.pubsubPublish, (id, channel, message) =>
    connectionManager.pubsubPublish(id as string, channel as string, message as string),
  )

  handle<OperationResult>(IPC.pubsubStop, (id) => {
    connectionManager.pubsubStop(id as string)
    return { ok: true }
  })

  handle<DatabaseInfo[]>(IPC.redisDatabases, (id) => connectionManager.databases(id as string))

  handle<ScanResult>(IPC.redisScan, (id, options) =>
    connectionManager.scan(id as string, (options ?? {}) as ScanOptions),
  )

  handle<RedisKeyItem | null>(IPC.redisLookupKey, (id, key, db) =>
    connectionManager.lookupKey(id as string, key as string, db as number | undefined),
  )

  handle<SearchAllResult>(IPC.redisSearchAll, (id, options) =>
    connectionManager.searchAll(id as string, (options ?? {}) as SearchAllOptions),
  )

  handle<OperationResult>(IPC.redisSearchCancel, (id) =>
    connectionManager.cancelSearch(id as string),
  )

  handle<RefreshKeysResult>(IPC.redisRefreshKeys, (id, options) =>
    connectionManager.refreshKeys(id as string, (options ?? {}) as RefreshKeysOptions),
  )

  handle<KeyValue>(IPC.redisValue, async (id, key, options) => {
    /*
     * 取值耗时日志（KEYPER_DEBUG=1 时打印）。
     * 只在这一条通道上加：它是"点键 → 看到值"的必经路径，
     * 也是经 SSH 隧道时用户最能感知的一段。日志给出的是
     * 主进程侧的真实耗时，可与渲染层计时对照，区分
     * "网络/Redis 慢" 与 "界面渲染慢"。
     */
    const t0 = Date.now()
    const result = await connectionManager.getValue(
      id as string,
      key as string,
      (options ?? {}) as ValueReadOptions,
    )
    if (process.env.KEYPER_DEBUG || process.env.REDISDOCTER_DEBUG) {
      console.log(
        `[ipc] getValue ${key} 用时 ${Date.now() - t0}ms（type=${result.type}, 已加载 ${
          Array.isArray(result.value) ? `${result.value.length}/${result.length ?? '-'}` : result.length ?? '-'
        }）`,
      )
    }
    return result
  })

  handle<ValuePageResult>(IPC.redisValuePage, (id, key, options) =>
    connectionManager.valuePage(
      id as string,
      key as string,
      (options ?? {}) as ValuePageOptions,
    ),
  )

  handle<OperationResult>(IPC.redisSetValue, (id, key, type, payload, ttl, isNew) =>
    connectionManager.setValue(
      id as string,
      key as string,
      type as RedisValueType,
      payload as string | string[] | Record<string, string>,
      ttl as number | undefined,
      isNew as boolean | undefined,
    ),
  )

  handle<OperationResult>(IPC.redisDelete, (id, keys) =>
    connectionManager.deleteKeys(id as string, keys as string[]),
  )

  handle<OperationResult>(IPC.redisSetTtl, (id, key, seconds) =>
    connectionManager.setTtl(id as string, key as string, seconds as number),
  )

  handle<OperationResult>(IPC.redisRename, (id, key, newKey) =>
    connectionManager.renameKey(id as string, key as string, newKey as string),
  )

  handle<OperationResult>(IPC.redisDelHashField, (id, key, field) =>
    connectionManager.deleteHashField(id as string, key as string, field as string),
  )

  handle<OperationResult>(IPC.redisSetHashField, (id, key, field, value, nextField, keepTtl) =>
    connectionManager.setHashField(
      id as string,
      key as string,
      field as string,
      value as string,
      nextField as string | undefined,
      keepTtl as number | undefined,
    ),
  )

  handle<Record<string, number> | null>(IPC.redisHashFieldTtls, (id, key, fields) =>
    connectionManager.hashFieldTtls(id as string, key as string, (fields ?? []) as string[]),
  )

  handle<OperationResult>(IPC.redisSetHashFieldTtl, (id, key, field, seconds) =>
    connectionManager.setHashFieldTtl(id as string, key as string, field as string, seconds as number),
  )

  handle<OperationResult>(IPC.redisSetListElement, (id, key, index, value) =>
    connectionManager.setListElement(id as string, key as string, index as number, value as string),
  )

  handle<OperationResult>(IPC.redisDelListElement, (id, key, index) =>
    connectionManager.deleteListElement(id as string, key as string, index as number),
  )

  handle<OperationResult>(IPC.redisAppendListElement, (id, key, value) =>
    connectionManager.appendListElement(id as string, key as string, value as string),
  )

  handle<OperationResult>(IPC.redisSetSetMember, (id, key, member, next) =>
    connectionManager.setSetMember(id as string, key as string, member as string, next as string),
  )

  handle<OperationResult>(IPC.redisDelSetMember, (id, key, member) =>
    connectionManager.deleteSetMember(id as string, key as string, member as string),
  )

  handle<OperationResult>(IPC.redisAddSetMember, (id, key, member) =>
    connectionManager.addSetMember(id as string, key as string, member as string),
  )

  handle<OperationResult>(IPC.redisSetZsetMember, (id, key, member, nextMember, nextScore) =>
    connectionManager.setZsetMember(
      id as string,
      key as string,
      member as string,
      nextMember as string,
      nextScore as number,
    ),
  )

  handle<OperationResult>(IPC.redisDelZsetMember, (id, key, member) =>
    connectionManager.deleteZsetMember(id as string, key as string, member as string),
  )

  handle<OperationResult>(IPC.redisAddZsetMember, (id, key, member, score) =>
    connectionManager.addZsetMember(id as string, key as string, member as string, score as number),
  )

  handle<OperationResult>(IPC.redisXaddEntry, (id, key, field, value) =>
    connectionManager.xaddEntry(id as string, key as string, field as string, value as string),
  )

  handle<OperationResult>(IPC.redisInsertListElement, (id, key, index, value, position) =>
    connectionManager.insertListElement(
      id as string,
      key as string,
      index as number,
      value as string,
      position as 'before' | 'after',
    ),
  )

  handle<OperationResult>(IPC.redisCreateKey, (id, key, type, payload, ttl) =>
    connectionManager.createKey(
      id as string,
      key as string,
      type as RedisValueType,
      (payload ?? '') as string | string[] | Record<string, string>,
      ttl as number | undefined,
    ),
  )

  handle<CliResult>(IPC.redisCli, (id, command) =>
    connectionManager.command(id as string, command as string),
  )

  /* -------------------------------------------------------- Memcached 专属通道 */

  handle<MemcachedOverview>(IPC.memcachedOverview, (id) =>
    memcachedManager.overview(id as string),
  )
  handle<MemcachedSlab[]>(IPC.memcachedSlabs, (id) => memcachedManager.slabs(id as string))
  handle<MemcachedKeyList>(IPC.memcachedKeys, (id, options) =>
    memcachedManager.keys(
      id as string,
      (options ?? {}) as { offset?: number; limit?: number; refresh?: boolean },
    ),
  )
  handle<MemcachedValue>(IPC.memcachedGet, (id, key) =>
    memcachedManager.get(id as string, key as string),
  )
  handle<OperationResult>(IPC.memcachedSet, (id, key, value, options) =>
    memcachedManager.set(
      id as string,
      key as string,
      value as string,
      (options ?? {}) as {
        exptime?: number
        mode?: 'set' | 'add' | 'replace'
        flags?: number
        ttlSeconds?: number
      },
    ),
  )
  handle<OperationResult>(IPC.memcachedRemove, (id, key) =>
    memcachedManager.remove(id as string, key as string),
  )
  handle<OperationResult>(IPC.memcachedTouch, (id, key, seconds) =>
    memcachedManager.touch(id as string, key as string, seconds as number),
  )
  handle<OperationResult>(IPC.memcachedRename, (id, key, newKey) =>
    memcachedManager.rename(id as string, key as string, newKey as string),
  )
  handle<OperationResult>(IPC.memcachedFlush, (id) => memcachedManager.flush(id as string))
}

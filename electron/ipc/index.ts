import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import fs from 'node:fs'
import { IPC } from '../../shared/api'
import { connectionManager } from '../services/connection-manager'
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
import type {
  ApiResponse,
  AppSettings,
  CliResult,
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
  UpdateCheckResult,
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
    throw new Error(maybe.message || '操作失败')
  }
  return value
}

/**
 * 需要写入手动操作日志的通道 → 日志中的操作名。
 *
 * 设计要点：日志只在 IPC 层落盘，意味着「用户显式触发的操作」才会被记录；
 * 主进程内部的自动任务（定时刷新、内部遍历等）不经过 IPC，天然不会进入日志。
 * 读取类通道（scan / value / info）同样不记录，避免浏览行为淹没关键操作。
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
}

function connectionLabel(id: string): string {
  const config = loadConnections().find((item) => item.id === id)
  return config ? config.name : id
}

/**
 * 从各通道的参数里提取「连接名 + 操作详情」。
 * 注意：必须在 handler 执行前调用 —— 删除连接后配置已不存在，就取不到名称了。
 */
function describe(channel: string, args: unknown[]): { connectionName: string; detail: string } {
  const first = args[0]

  if (typeof first === 'string') {
    const connectionName = connectionLabel(first)
    switch (channel) {
      case IPC.redisCli:
        return { connectionName, detail: String(args[1] ?? '') }
      case IPC.redisCreateKey:
        return { connectionName, detail: `${args[1]} (${args[2]})` }
      case IPC.redisSetValue:
        return { connectionName, detail: `${args[1]} (${args[2]})` }
      case IPC.redisDelete:
        return { connectionName, detail: ((args[1] as string[]) ?? []).join(', ') }
      case IPC.redisSetTtl:
        return { connectionName, detail: `${args[1]} → ${args[2]}s` }
      case IPC.redisRename:
        return { connectionName, detail: `${args[1]} → ${args[2]}` }
      case IPC.redisDelHashField:
        return { connectionName, detail: `${args[1]} · ${args[2]}` }
      case IPC.redisSetHashField:
        return {
          connectionName,
          detail:
            args[4] && args[4] !== args[2]
              ? `${args[1]} · ${args[2]} → ${args[4]}`
              : `${args[1]} · ${args[2]}`,
        }
      case IPC.redisSetHashFieldTtl:
        return { connectionName, detail: `${args[1]} · ${args[2]} → ${args[3]}s` }
      case IPC.redisSetListElement:
        return { connectionName, detail: `${args[1]} · 第 ${(args[2] as number) + 1} 项` }
      case IPC.redisDelListElement:
        return { connectionName, detail: `${args[1]} · 第 ${(args[2] as number) + 1} 项` }
      case IPC.redisInsertListElement:
        return {
          connectionName,
          detail: `${args[1]} · 第 ${(args[2] as number) + 1} 项${args[4] === 'before' ? '前' : '后'}`,
        }
      case IPC.redisAppendListElement:
        return { connectionName, detail: args[1] as string }
      case IPC.redisSetSetMember:
        return { connectionName, detail: `${args[1]} · ${args[2]} → ${args[3]}` }
      case IPC.redisDelSetMember:
        return { connectionName, detail: `${args[1]} · ${args[2]}` }
      case IPC.redisAddSetMember:
        return { connectionName, detail: `${args[1]} · ${args[2]}` }
      case IPC.redisSetZsetMember:
        return {
          connectionName,
          detail:
            args[2] === args[3]
              ? `${args[1]} · ${args[2]} → score ${args[4]}`
              : `${args[1]} · ${args[2]} → ${args[3]}`,
        }
      case IPC.redisDelZsetMember:
        return { connectionName, detail: `${args[1]} · ${args[2]}` }
      case IPC.redisAddZsetMember:
        return { connectionName, detail: `${args[1]} · ${args[2]} (${args[3]})` }
      case IPC.redisXaddEntry:
        return { connectionName, detail: `${args[1]} · ${args[2]} = ${String(args[3]).slice(0, 40)}` }
      default:
        return { connectionName, detail: connectionName }
    }
  }

  if (first && typeof first === 'object') {
    const config = first as RedisConnectionConfig
    return {
      connectionName: config.name || config.host,
      detail: `${config.host}:${config.port}/${config.db}`,
    }
  }

  return { connectionName: '-', detail: '' }
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
        connectionId: typeof args[0] === 'string' ? (args[0] as string) : '',
        connectionName: meta.connectionName,
        action,
        detail: meta.detail || '-',
        ok: response.ok,
        result: response.ok ? (data?.message ?? '成功') : response.error,
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
    return { ok: true, message: '已打开日志目录' }
  })

  // -------------------------------------------------------- 检查更新
  handle<UpdateCheckResult>(IPC.updateCheck, () => checkForUpdate())

  handle<OperationResult>(IPC.updateOpenPage, async (url) => openUpdatePage(String(url ?? '')))

  // -------------------------------------------------------- 错误落盘
  // 渲染层错误边界的 fire-and-forget 通道：写入失败也不 reject ——
  // 落盘路径自身的异常绝不能再触发一次「错误 → 落盘 → 出错」的递归。
  handle<OperationResult>(IPC.logRendererError, (report) => {
    try {
      appendErrorLog((report ?? {}) as ErrorReport)
      return { ok: true, message: '已记录' }
    } catch {
      return { ok: false, message: '错误日志写入失败' }
    }
  })

  // -------------------------------------------------------- 文件导出
  handle<{ saved: boolean; path?: string }>(IPC.fileSaveText, async (options) => {
    const payload = (options ?? {}) as { suggestedName?: string; content?: string }
    const result = await dialog.showSaveDialog({
      title: '导出内容',
      defaultPath: payload.suggestedName || 'value.txt',
      filters: [
        { name: '文本文件', extensions: ['txt', 'log'] },
        { name: 'JSON', extensions: ['json'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    })

    if (result.canceled || !result.filePath) return { saved: false }
    fs.writeFileSync(result.filePath, payload.content ?? '', 'utf-8')
    return { saved: true, path: result.filePath }
  })

  // -------------------------------------------------------- 连接管理
  handle<RedisConnectionConfig[]>(IPC.connectionList, () => loadConnections())

  handle<RedisConnectionConfig[]>(IPC.connectionSave, (config) => {
    const target = config as RedisConnectionConfig
    const list = loadConnections()
    const index = list.findIndex((item) => item.id === target.id)
    if (index >= 0) list[index] = target
    else list.push(target)
    saveConnections(list)
    return list
  })

  handle<RedisConnectionConfig[]>(IPC.connectionRemove, (id) => {
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
        connectionId: String(id),
        connectionName: removedConn?.name ?? '-',
        action: '删除配置',
        detail: `同步清理 ${pruned} 条搜索历史`,
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
  handle<RedisConnectionConfig[]>(IPC.connectionSetPinned, (id, pinned) => {
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
  handle<RedisConnectionConfig[]>(IPC.connectionReorder, (ids) => {
    const list = loadConnections()
    const order = new Set(ids as string[])
    const byId = new Map(list.map((item) => [item.id, item]))
    const next: RedisConnectionConfig[] = []
    for (const id of order) {
      const item = byId.get(id)
      if (item) next.push(item)
    }
    for (const item of list) if (!order.has(item.id)) next.push(item)
    saveConnections(next)
    return next
  })

  handle<OperationResult>(IPC.connectionTest, (config) =>
    connectionManager.test(config as RedisConnectionConfig),
  )

  handle<ConnectionState>(IPC.connectionConnect, (config) =>
    connectionManager.connect(config as RedisConnectionConfig),
  )

  handle<OperationResult>(IPC.connectionDisconnect, (id) => connectionManager.disconnect(id as string))

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

  handle<KeyValue>(IPC.redisValue, async (id, key) => {
    /*
     * 取值耗时日志（REDISDOCTER_DEBUG=1 时打印）。
     * 只在这一条通道上加：它是"点键 → 看到值"的必经路径，
     * 也是经 SSH 隧道时用户最能感知的一段。日志给出的是
     * 主进程侧的真实耗时，可与渲染层计时对照，区分
     * "网络/Redis 慢" 与 "界面渲染慢"。
     */
    const t0 = Date.now()
    const result = await connectionManager.getValue(id as string, key as string)
    if (process.env.REDISDOCTER_DEBUG) {
      console.log(`[ipc] getValue ${key} 用时 ${Date.now() - t0}ms（type=${result.type}）`)
    }
    return result
  })

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
}

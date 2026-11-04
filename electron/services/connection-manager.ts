import { randomUUID } from 'node:crypto'
import { gunzipSync, inflateSync } from 'node:zlib'
import Redis from 'ioredis'
import { tunnelManager, openTunnel, closeTunnel, type Tunnel } from './ssh-tunnel'
import {
  VALUE_BINARY_MAX_BYTES,
  VALUE_DECODE_MAX_BYTES,
  VALUE_DECODE_MAX_BYTES_CAP,
} from '../../shared/limits'
import type {
  CliResult,
  ConnectionStatus,
  ConnectionState,
  DatabaseInfo,
  KeyValue,
  KeyspaceConfig,
  KeyspaceEvent,
  MemoryAnalysis,
  MemoryBucket,
  MetricsSample,
  OperationResult,
  RedisConnectionConfig,
  RedisKeyItem,
  RedisValueType,
  ScanOptions,
  ScanResult,
  SearchAllOptions,
  SearchAllResult,
  SearchProgress,
  ServerInfo,
  SlowlogEntry,
  SlowlogOverview,
  PubsubMessage,
  PubsubState,
  VersionInfo,
  VersionInfoGroup,
  ValuePageOptions,
  ValuePageResult,
  ValueReadOptions,
  ValueBinaryOptions,
  ValueBinaryResult,
  RefreshKeysOptions,
  RefreshKeysResult,
} from '../../shared/types'
import { memoryPrefixOf, MEMORY_BUCKET_LIMIT } from '../../shared/keyspace'
import { t } from '@shared/i18n'

/** 详情视图中单次返回的元素上限，避免大 key 把 UI 拖死 */
const VALUE_PAGE_SIZE = 500
/** 分页上限：过大失去分页意义，过小会让用户频繁点击「加载更多」 */
const VALUE_PAGE_MAX = 20000
/** 键列表增量刷新的扫描批大小（与 scan 的全库搜索批一致） */
const REFRESH_SCAN_COUNT = 5000
/** 键列表增量刷新一次最多描述多少键，防止异常调用把主进程压满 */
const REFRESH_KEY_MAX = 20000

/** 请求分页大小时统一钳制，避免 0 / NaN / 过大值传到 Redis */
function clampValuePageLimit(requested?: number): number {
  const value = requested == null || !Number.isFinite(requested) ? VALUE_PAGE_SIZE : Math.floor(requested)
  return Math.min(Math.max(value, 1), VALUE_PAGE_MAX)
}

/** HSCAN / SSCAN 一页的通用结果：cursor 为 null 表示已到末尾 */
interface ScannedPage<T> {
  value: T
  cursor: string | null
}

/**
 * 逐批 HSCAN 直到攒够 limit 或游标归零。
 *
 * 不裁剪最后一批：SCAN 的游标已经越过整批，裁剪会让被裁掉的字段
 * 在后续分页中永久丢失。页大小因此是「约等于 limit」的软上限。
 * 同一批次内的重复字段（SCAN 在 rehash 时可能返回）用对象自身去重。
 */
async function readHashPage(
  client: Redis,
  key: string,
  startCursor: string,
  limit: number,
): Promise<ScannedPage<Record<string, string>>> {
  const out: Record<string, string> = {}
  let cursor = startCursor || '0'
  let collected = 0
  do {
    const [next, pairs] = await client.hscan(key, cursor, 'COUNT', Math.max(limit - collected, 1))
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      if (pairs[i] in out) continue
      out[pairs[i]] = pairs[i + 1]
      collected++
    }
    cursor = next
  } while (cursor !== '0' && collected < limit)
  return { value: out, cursor: cursor === '0' ? null : cursor }
}

/** 逐批 SSCAN 直到攒够 limit 或游标归零；批内去重，同上不裁剪 */
async function readSetPage(
  client: Redis,
  key: string,
  startCursor: string,
  limit: number,
): Promise<ScannedPage<string[]>> {
  const out = new Set<string>()
  let cursor = startCursor || '0'
  do {
    const [next, members] = await client.sscan(key, cursor, 'COUNT', Math.max(limit - out.size, 1))
    for (const member of members) out.add(member)
    cursor = next
  } while (cursor !== '0' && out.size < limit)
  return { value: [...out], cursor: cursor === '0' ? null : cursor }
}

/** ZRANGE WITHSCORES 的扁平数组 → `member :: score` 行 */
function flattenZsetRows(rows: string[]): string[] {
  const pairs: string[] = []
  for (let i = 0; i + 1 < rows.length; i += 2) pairs.push(`${rows[i]} :: ${rows[i + 1]}`)
  return pairs
}

/** XRANGE 条目 → `entryId :: {fields}` 行（与旧实现保持同一格式） */
function flattenStreamEntries(entries: ReadonlyArray<[string, string[]]>): string[] {
  return entries.map(([entryId, fields]) => `${entryId} :: ${JSON.stringify(fields)}`)
}

/** 实际连接端点：直连时为配置地址，走隧道时为本机回环端口 */
interface Endpoint {
  host: string
  port: number
}

interface ManagedClient {
  config: RedisConnectionConfig
  client: Redis
  /**
   * 连接当前所在的库（运行时状态）。
   *
   * ⚠️ 不能用 client.options.db 判断当前库：它只记录**创建时**的配置，
   * SELECT 之后不会回写。曾经据此判断「是否需要切库」，导致
   * db0 → db1 → db0 时误判「已在 db0」而跳过 SELECT，
   * 连接实际停在 db1，键列表返回空（重大 bug）。
   * ioredis 重连时会按内部记录自动恢复 SELECT 过的库，与此字段一致。
   */
  db: number
  /**
   * 用户主动断开标志：close/end 事件推送前检查，
   * 主动断开不产生「被动断线」推送（界面已自行置 disconnected）。
   */
  manualClose: boolean
  /** 心跳探活定时器（attachStatusWatch 创建，disconnect 清理） */
  probeTimer?: NodeJS.Timeout
  /** 连续心跳失败次数：达到 2 次（约 30s）判定半开死链 */
  probeMisses: number
}

/** Pub/Sub 专用连接：独立于主连接池，只承载订阅与消息推送 */
interface PubsubClient {
  client: Redis
  /** 精确频道订阅集合（SUBSCRIBE） */
  channels: Set<string>
  /** 模式订阅集合（PSUBSCRIBE） */
  patterns: Set<string>
}

/**
 * 键空间通知专用连接。
 *
 * 不复用 PubsubClient：PubsubCard 在关闭面板时会 pubsubStop 整条连接，
 * 键空间监听是概览页签的常驻功能，共用会让两边互相拆台。
 */
interface KeyspaceClient {
  client: Redis
  /** 已 PSUBSCRIBE 的模式集合 */
  patterns: Set<string>
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 字节数转人类可读字符串。
 *
 * 仅用于 INFO 里没有 *_human 字段时的兜底（老版本 Redis），
 * 因此按 MB / GB 两档即可，不必做得像通用工具那样完备。
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}G`
}

/** 把 ioredis 的返回值格式化成 CLI 可读文本 */
function formatReply(reply: unknown): string {
  if (reply === null || reply === undefined) return '(nil)'
  if (Buffer.isBuffer(reply)) return reply.toString('utf-8')
  if (Array.isArray(reply)) {
    return reply.map((item, index) => `${index + 1}) ${formatReply(item)}`).join('\n')
  }
  if (typeof reply === 'object') return JSON.stringify(reply)
  return String(reply)
}

/** 解析用户输入的 Redis 命令，支持单/双引号包裹的参数 */
export function parseCommandLine(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (const char of input.trim()) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char as '"' | "'"
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started || current.length) {
        args.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
  }
  if (started || current.length) args.push(current)
  return args
}

/**
 * 握手期错误探针。
 *
 * ioredis 的一个坑：认证失败（WRONGPASS / NOAUTH）时服务端直接断开，
 * connect() 的 promise 被 "Connection is closed." reject —— 真正的原因
 * 只在 error 事件里，且没有监听器时仅打一条 Unhandled error 日志。
 * 界面与用户看到的都是 "Connection is closed."，会误判为网络/SSH 问题
 * （实际场景：SSH 隧道完全正常，是 Redis 密码错了）。
 *
 * 返回取值函数：catch 里配合 pickFailureReason 优先展示具体错误。
 */
function attachHandshakeProbe(client: Redis): () => Error | null {
  let first: Error | null = null
  client.on('error', (error) => {
    first ??= error
  })
  return () => first
}

/** connect 失败原因择优：连接被关（表象）且有更早的具体错误时，用后者 */
function pickFailureReason(closeError: unknown, first: Error | null): unknown {
  return first && toMessage(closeError).includes('Connection is closed') ? first : closeError
}

/*
 * 已知错误 → 提示文案（原文保留在括号里）。
 *
 * 面向的受众是「用过图形客户端的运维 / 开发」，不是 Redis 专家：
 * WRONGPASS / ECONNREFUSED 这类码能定位 90% 的连接失败，
 * 英文原文反而把用户的注意力引向「SSH？网络？」的猜测。
 * 末尾保留原始报错，专家仍可溯源。
 *
 * 文案用惰性函数持有：语言可能在运行期切换，不能把翻译结果缓存在模块常量里。
 */
const ERROR_ZH: ReadonlyArray<readonly [RegExp, () => string]> = [
  [/WRONGPASS/, () => t('connectionManager.redisAuthenticationFailed')],
  [/NOAUTH/, () => t('connectionManager.redisRequiresAuthentication')],
  [/ECONNREFUSED/, () => t('connectionManager.cannotConnect')],
  [/ETIMEDOUT|connect timeout/i, () => t('connectionManager.connectionTimedOut')],
  [/ENOTFOUND/, () => t('connectionManager.dnsLookupFailed')],
  [/EHOSTUNREACH/, () => t('connectionManager.networkUnreachable')],
  [/ECONNRESET/, () => t('connectionManager.connectionReset')],
  [/LOADING/, () => t('connectionManager.redisLoadingDataDiskTry')],
  [/READONLY/, () => t('connectionManager.readOnlyReplica')],
  [/OOM command not allowed/i, () => t('connectionManager.memoryLimitReached')],
  [/All configured authentication methods failed/, () => t('connectionManager.sshAuthenticationFailed')],
  [/Connection is closed/, () => t('connectionManager.connectionChannelClosed')],
]

/** 失败原因 → 用户可读消息：命中映射表则本地化并附原文 */
function friendlyMessage(error: unknown): string {
  const raw = toMessage(error)
  for (const [pattern, message] of ERROR_ZH) {
    if (pattern.test(raw)) return t('connectionManager.messageWithRaw', { message: message(), raw })
  }
  return raw
}

/** 连接状态推送载荷（主 → 渲染） */
export interface ConnectionStatusPayload {
  id: string
  status: ConnectionStatus
  message?: string
}

/**
 * Redis 连接与命令管理器（主进程单例）。
 * 所有真实网络访问都集中在这一层，IPC 仅做参数转发。
 */
class ConnectionManager {
  private pool = new Map<string, ManagedClient>()

  /** 状态推送订阅者（ipc 层注册，转发到渲染层） */
  private statusListeners = new Set<(payload: ConnectionStatusPayload) => void>()

  /*
   * Pub/Sub 专用连接池。
   *
   * ⚠️ 必须独立于 pool：SUBSCRIBE 会让连接进入订阅模式，
   * 之后该连接只能收推送、不能再执行任何普通命令 ——
   * 复用主连接意味着浏览 / CLI / 概览全部当场报废。
   */
  private pubsubClients = new Map<string, PubsubClient>()

  /** Pub/Sub 消息订阅者（ipc 层注册，转发到渲染层） */
  private pubsubListeners = new Set<(message: PubsubMessage) => void>()

  /** 键空间通知专用连接池（与 Pub/Sub 分开，理由见 KeyspaceClient 注释） */
  private keyspaceClients = new Map<string, KeyspaceClient>()

  /** 键空间事件订阅者（ipc 层注册，转发到渲染层） */
  private keyspaceListeners = new Set<(event: KeyspaceEvent) => void>()

  /*
   * 全库搜索取消令牌（按连接隔离）。
   * searchAll 启动时递增并记住本轮令牌；cancelSearch / 新一轮搜索再递增。
   * 扫描循环每批发作对比，不一致即停 —— 停止按钮与"新搜索覆盖旧搜索"共用这套机制。
   */
  private searchTokens = new Map<string, number>()

  /** 全库搜索进度订阅者（ipc 层注册，转发到渲染层） */
  private searchProgressListeners = new Set<(progress: SearchProgress) => void>()

  /** 订阅全库搜索进度（ipc 层注册后转发到渲染层），返回取消订阅函数 */
  onSearchProgress(listener: (progress: SearchProgress) => void): () => void {
    this.searchProgressListeners.add(listener)
    return () => this.searchProgressListeners.delete(listener)
  }

  private emitSearchProgress(progress: SearchProgress): void {
    for (const listener of this.searchProgressListeners) listener(progress)
  }

  /**
   * 订阅连接被动状态变化（断开 / 重连中 / 断死）。
   * 返回取消订阅函数。渲染层的连接列表状态点据此实时变色，
   * 不再依赖用户主动操作才发现连接已断。
   */
  onStatusChange(listener: (payload: ConnectionStatusPayload) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private emitStatus(id: string, status: ConnectionStatus, message?: string): void {
    const payload: ConnectionStatusPayload = { id, status, message }
    console.log(`[connection-manager] 状态推送 [${id}] ${status}${message ? ` · ${message}` : ''}`)
    for (const listener of this.statusListeners) listener(payload)
  }

  /**
   * 给已建立的连接挂生命周期监听。
   *
   * ioredis 断线后默认自动重连（retryStrategy 有限次），事件序列：
   *   close → （reconnecting 若干次）→ ready（成功）/ end（放弃）
   * 映射到界面状态：
   *   close → 'connecting'（黄：重连中）
   *   ready → 'connected'（绿；首次 ready 与重连成功都触发，幂等无害）
   *   end   → 'error'（红：重试耗尽，彻底断了）
   * manualClose 标志区分「用户主动断开」：那种情况界面本来就置
   * disconnected，不需要推送，否则会把刚设置的 idle 状态覆盖回去。
   */
  private attachStatusWatch(managed: ManagedClient): void {
    const { client } = managed
    client.on('close', () => {
      if (managed.manualClose) return
      this.emitStatus(managed.config.id, 'connecting', t('connectionManager.connectionInterrupted'))
    })
    client.on('ready', () => {
      if (managed.manualClose) return
      managed.probeMisses = 0
      this.emitStatus(managed.config.id, 'connected')
    })
    client.on('end', () => {
      if (managed.manualClose) return
      this.emitStatus(managed.config.id, 'error', t('connectionManager.connectionLostAutomatic'))
    })

    /*
     * 应用层心跳：解决 TCP 半开假活。
     *
     * 拔网线 / VPN 掉线 / 系统睡眠恢复后，TCP 栈可能长时间感知不到
     * 对端已死（Windows 默认 TCP keepalive 2 小时），ioredis 不触发
     * close，状态点一直绿着，用户点任何操作才暴露超时。
     *
     * 15s PING 一次（3s 超时竞速），连续 2 次失败（约 30s）判定死链：
     * 推送 error 状态并主动 disconnect —— 让 ioredis 走标准重连
     * 流程（close → connecting → 重试），恢复后自动回到 connected。
     * 只在 status=ready 时探：重连过程中 ping 必然失败，不算数。
     */
    managed.probeMisses = 0
    managed.probeTimer = setInterval(() => {
      if (managed.manualClose || client.status !== 'ready') return
      Promise.race([
        client.ping().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
      ]).then((alive) => {
        if (managed.manualClose) return
        if (alive) {
          managed.probeMisses = 0
          return
        }
        managed.probeMisses += 1
        if (managed.probeMisses >= 2) {
          this.emitStatus(managed.config.id, 'error', t('connectionManager.noResponseConnection'))
          managed.probeMisses = 0
          client.disconnect()
        }
      })
    }, 15_000)
  }

  /** 停止心跳探活（断开/销毁时调用，防定时器泄漏） */
  private stopProbe(managed: ManagedClient): void {
    if (managed.probeTimer) {
      clearInterval(managed.probeTimer)
      managed.probeTimer = undefined
    }
  }

  // ---------------------------------------------------------------- 连接生命周期

  private buildClient(config: RedisConnectionConfig, endpoint?: Endpoint): Redis {
    const target = endpoint ?? { host: config.host, port: config.port }
    return new Redis({
      host: target.host,
      port: target.port,
      username: config.username || undefined,
      password: config.password || undefined,
      db: config.db ?? 0,
      tls: config.tls ? {} : undefined,
      lazyConnect: true,
      connectTimeout: 8000,
      commandTimeout: 15000,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 300, 1500)),
    })
  }

  /**
   * 解析实际要连的地址。
   *
   * 直连时就是配置里的 host:port；启用 SSH 时先建隧道，
   * 再让 ioredis 连本地回环端口 —— 上层其余逻辑完全不感知 SSH。
   *
   * 隧道建立失败会抛出带原因的异常（登录失败 / 密钥格式错误等），
   * 由调用方转成用户可读的错误信息。
   */
  private async resolveEndpoint(config: RedisConnectionConfig): Promise<Endpoint> {
    if (!config.sshEnabled || !config.ssh) {
      return { host: config.host, port: config.port }
    }
    return tunnelManager.ensure(config)
  }

  /**
   * 探活：不改动连接池与共享隧道，仅做一次临时握手。
   *
   * ⚠️ test 绝不能走 tunnelManager（共享隧道）：
   *   曾用 ensure 实现 —— 它会先拆掉这条连接**正在承载流量**的隧道
   *   （对已连接的配置点「测试连接」，主界面当场断流报
   *   "Connection is closed."）；测试结束时 finally 的 close 还会
   *   拆掉并发 connect 刚建好的隧道。
   * 这里改为一次性独立隧道：开自己的、测完关自己的，与 connect 完全隔离。
   */
  async test(config: RedisConnectionConfig): Promise<OperationResult> {
    let standalone: Tunnel | undefined
    let endpoint: Endpoint
    try {
      if (config.sshEnabled && config.ssh) {
        standalone = await openTunnel(config)
        endpoint = { host: '127.0.0.1', port: standalone.localPort }
      } else {
        endpoint = { host: config.host, port: config.port }
      }
    } catch (error) {
      console.error(`[connection-manager] test(隧道建立) 失败 [${config.name}]:`, error)
      return { ok: false, message: friendlyMessage(error) }
    }

    const client = this.buildClient(config, endpoint)
    const firstHandshakeError = attachHandshakeProbe(client)
    try {
      await client.connect()
      /* 与 connect() 同构：ping + info 合并为一次往返（见 connect 处说明）*/
      const started = Date.now()
      const [[pingErr], [, info]] = (await client
        .pipeline()
        .ping()
        .info('server')
        .exec()) as unknown as [[Error | null, string], [Error | null, string]]
      if (pingErr) throw pingErr
      const latency = Date.now() - started
      const version = /redis_version:([^\r\n]+)/.exec(info)?.[1]?.trim()
      return {
        ok: true,
        message: version
          ? t('connectionManager.connectedRedisVersionLatency', { version, latency })
          : t('connectionManager.connectedLatencyMs', { latency }),
      }
    } catch (error) {
      const reason = pickFailureReason(error, firstHandshakeError())
      console.error(`[connection-manager] test(握手) 失败 [${config.name}]:`, reason)
      return { ok: false, message: friendlyMessage(reason) }
    } finally {
      client.disconnect()
      // 只销毁 test 自己的一次性隧道，不碰共享隧道
      closeTunnel(standalone)
    }
  }

  async connect(config: RedisConnectionConfig): Promise<ConnectionState> {
    await this.disconnect(config.id)

    /*
     * identity 里的 host/port 保留**用户配置的值**（Redis 的真实地址），
     * 而不是隧道本机端口 —— 界面状态栏、版本弹窗展示的都该是
     * "我在连哪台 Redis"，而不是一个随机的内部端口。
     */
    /*
     * identity：连接成功后要回给渲染层的"我是谁"。
     *
     * 显式带 engine —— 渲染层靠它决定把这条状态放进 Redis 还是 Memcached
     * 的分支，缺了就会被当成 Redis，出现"Memcached 连上后显示 db0"。
     * 其余字段按 Redis 语义给出：本管理器只负责 Redis，
     * Memcached 走独立的 memcached-manager（见 engine-registry）。
     */
    const identity = {
      id: config.id,
      name: config.name,
      engine: 'redis' as const,
      host: config.host,
      port: config.port,
      username: config.username,
      db: config.db,
      tls: config.tls,
      sshEnabled: config.sshEnabled && !!config.ssh,
      sshHost: config.sshEnabled && config.ssh ? config.ssh.host : undefined,
      // 置顶跟连接无关，但返回值要完整：渲染端会拿它整条覆盖列表条目，
      // 漏了的话"连接成功"就等于"取消置顶"。
      pinned: config.pinned,
    }

    let endpoint: Endpoint
    try {
      endpoint = await this.resolveEndpoint(config)
    } catch (error) {
      // SSH 隧道失败的完整堆栈只在这里可见（--debug 时镜像进 debug.log）
      console.error(`[connection-manager] connect(隧道建立) 失败 [${config.name}]:`, error)
      return { ...identity, status: 'error', message: friendlyMessage(error) }
    }

    const client = this.buildClient(config, endpoint)
    const firstHandshakeError = attachHandshakeProbe(client)

    try {
      await client.connect()
      /*
       * ping 与 info 合成一次往返。
       *
       * 原来 connect → ping → info 是三次串行往返：ping 只为测延迟，
       * info 只为拿版本；两条互不依赖，串行纯属白等。
       * 改用 pipeline 后整个握手从「3 RTT」降到「2 RTT」
       * （connect 本身不可省，它是协议协商）。
       *
       * 延迟仍用 ping 的往返值，只是这次它和 info 一起发出：
       * 计时起点在 pipeline 之前，得到的是"两条命令一起往返"的时间，
       * 比单独 ping 略大但语义仍是"本机到 Redis 的往返"。
       */
      const started = Date.now()
      const [[pingErr], [, info]] = (await client
        .pipeline()
        .ping()
        .info()
        .exec()) as unknown as [[Error | null, string], [Error | null, string]]
      if (pingErr) throw pingErr
      const latency = Date.now() - started
      const managed: ManagedClient = {
        config,
        client,
        db: config.db ?? 0,
        manualClose: false,
        probeMisses: 0,
      }
      this.pool.set(config.id, managed)
      // 挂被动状态监听：断线 / 重连结果实时推给渲染层
      this.attachStatusWatch(managed)
      return {
        ...identity,
        status: 'connected',
        latency,
        version: /redis_version:([^\r\n]+)/.exec(info)?.[1]?.trim(),
        mode: /redis_mode:([^\r\n]+)/.exec(info)?.[1]?.trim(),
      }
    } catch (error) {
      client.disconnect()
      // 连接失败时隧道已无存在意义，及时回收，避免跳板机上堆积空闲会话
      tunnelManager.close(config.id)
      const reason = pickFailureReason(error, firstHandshakeError())
      console.error(`[connection-manager] connect(握手) 失败 [${config.name}]:`, reason)
      return { ...identity, status: 'error', message: friendlyMessage(reason) }
    }
  }

  async disconnect(id: string): Promise<OperationResult> {
    const managed = this.pool.get(id)
    // Pub/Sub 专用连接随主连接一起断，避免残留只收不推的幽灵连接
    this.pubsubStop(id)
    this.keyspaceStop(id)
    // 作废在途全库搜索的令牌：断开后扫描循环下一批即停（不留幽灵扫描）
    this.searchTokens.set(id, (this.searchTokens.get(id) ?? 0) + 1)
    // 隧道无论是否有活跃客户端都要关：可能是 connect 失败后残留
    tunnelManager.close(id)
    if (!managed) return { ok: true }
    // 主动断开：抑制 close/end 事件的被动断线推送
    managed.manualClose = true
    this.stopProbe(managed)
    try {
      await managed.client.quit()
    } catch {
      managed.client.disconnect()
    }
    this.pool.delete(id)
    return { ok: true }
  }

  disconnectAll(): void {
    for (const [, managed] of this.pool) {
      managed.manualClose = true
      this.stopProbe(managed)
      try {
        managed.client.disconnect()
      } catch {
        /* ignore */
      }
    }
    this.pool.clear()
    // 全部连接断开：在途全库搜索一并作废（令牌清空后循环内对比必不一致）
    this.searchTokens.clear()
    for (const id of [...this.pubsubClients.keys()]) {
      this.pubsubStop(id)
    }
    for (const id of [...this.keyspaceClients.keys()]) {
      this.keyspaceStop(id)
    }
    tunnelManager.closeAll()
  }

  isConnected(id: string): boolean {
    const managed = this.pool.get(id)
    return !!managed && managed.client.status === 'ready'
  }

  private mustGet(id: string): Redis {
    const managed = this.pool.get(id)
    if (!managed) throw new Error(t('connectionManager.connectionClosedConnectFirst'))
    return managed.client
  }

  // ---------------------------------------------------------------- 服务端信息

  async serverInfo(id: string): Promise<ServerInfo> {
    const client = this.mustGet(id)
    const [info, dbsize] = await Promise.all([client.info(), client.dbsize()])
    const read = (field: string): string =>
      new RegExp(`${field}:([^\\r\\n]+)`).exec(info)?.[1]?.trim() ?? ''

    const hits = Number(read('keyspace_hits')) || 0
    const misses = Number(read('keyspace_misses')) || 0
    const total = hits + misses

    return {
      version: read('redis_version'),
      mode: read('redis_mode') || 'standalone',
      os: read('os'),
      processId: Number(read('process_id')) || 0,
      uptimeInDays: Number(read('uptime_in_days')) || 0,
      connectedClients: Number(read('connected_clients')) || 0,
      usedMemoryHuman: read('used_memory_human'),
      /*
       * Lua 内存字段在不同版本里命名有别：
       * 7.0+ 用 used_memory_lua_human，早期版本只有字节数 used_memory_lua。
       * 优先取人类可读值，回退时把字节数换算成 MB，避免面板出现空值。
       */
      usedMemoryLua: read('used_memory_lua_human') || formatBytes(Number(read('used_memory_lua')) || 0),
      totalKeys: dbsize,
      hitRate: total > 0 ? Math.round((hits / total) * 1000) / 10 : 0,
      opsPerSec: Number(read('instantaneous_ops_per_sec')) || 0,
    }
  }

  /**
   * 监控页签的一次采样。
   *
   * 与 serverInfo 分开而不是复用：监控曲线 2s 一次，只需要数值字段；
   * 用 pipeline 把 INFO + DBSIZE 合并成一次往返，经 SSH 隧道时省一半 RTT。
   * 命中率同时回传累计 hits/misses 的原始值，渲染层可按区间增量重算瞬时命中率。
   */
  async metrics(id: string): Promise<MetricsSample> {
    const client = this.mustGet(id)
    const [[infoErr, info], [, dbsize]] = (await client
      .pipeline()
      .info()
      .dbsize()
      .exec()) as unknown as [[Error | null, string], [Error | null, number]]
    if (infoErr) throw infoErr
    const raw = info ?? ''
    const read = (field: string): string =>
      new RegExp(`${field}:([^\\r\\n]+)`).exec(raw)?.[1]?.trim() ?? ''
    const num = (field: string): number => Number(read(field)) || 0

    const hits = num('keyspace_hits')
    const misses = num('keyspace_misses')
    const total = hits + misses

    return {
      at: Date.now(),
      usedMemory: num('used_memory'),
      usedMemoryPeak: num('used_memory_peak'),
      maxMemory: num('maxmemory'),
      opsPerSec: num('instantaneous_ops_per_sec'),
      connectedClients: num('connected_clients'),
      blockedClients: num('blocked_clients'),
      totalKeys: Number(dbsize) || 0,
      hitRate: total > 0 ? Math.round((hits / total) * 1000) / 10 : 0,
      keyspaceHits: hits,
      keyspaceMisses: misses,
      evictedKeys: num('evicted_keys'),
      expiredKeys: num('expired_keys'),
      totalCommands: num('total_commands_processed'),
      netInputBytes: num('total_net_input_bytes'),
      netOutputBytes: num('total_net_output_bytes'),
    }
  }

  /**
   * 版本信息：从 INFO 各段落里挑选对连接与兼容性判断有价值的字段。
   *
   * 以「分组 + 键值对」返回而非固定结构，原因有两个：
   * 1) 不同版本 / 部署模式（standalone、cluster、sentinel）暴露的 INFO 字段并不一致；
   * 2) 界面需要按 Server / Clients / Memory 等段落分组展示，固定结构会难以扩展。
   * 同时保留 raw 原始 INFO 输出，供排查冷门字段时直接查看。
   */
  async versionInfo(id: string): Promise<VersionInfo> {
    const client = this.mustGet(id)
    const info = await client.info()

    // 解析 INFO 的段落结构：# Section 后跟若干 key:value
    const sections = new Map<string, Record<string, string>>()
    let currentSection = ''
    for (const line of info.split(/\r?\n/)) {
      if (line.startsWith('#')) {
        currentSection = line.replace(/^#\s*/, '').trim()
        if (!sections.has(currentSection)) sections.set(currentSection, {})
        continue
      }
      const index = line.indexOf(':')
      if (index <= 0 || !currentSection) continue
      sections.get(currentSection)![line.slice(0, index)] = line.slice(index + 1).trim()
    }

    /** 关注的字段：顺序即界面展示顺序 */
    const PICKS: Array<{ section: string; keys: string[] }> = [
      { section: 'Server', keys: ['redis_version', 'redis_git_sha1', 'redis_git_dirty', 'redis_build_id', 'redis_mode', 'os', 'arch_bits', 'process_id', 'run_id', 'tcp_port', 'server_time_usec', 'uptime_in_seconds', 'uptime_in_days', 'executable', 'config_file'] },
      { section: 'Clients', keys: ['connected_clients', 'cluster_connections', 'maxclients', 'client_recent_max_input_buffer', 'client_recent_max_output_buffer', 'blocked_clients'] },
      { section: 'Memory', keys: ['used_memory', 'used_memory_human', 'used_memory_rss', 'used_memory_peak_human', 'used_memory_lua', 'maxmemory', 'maxmemory_human', 'maxmemory_policy', 'mem_fragmentation_ratio', 'mem_allocator'] },
      { section: 'Persistence', keys: ['loading', 'rdb_changes_since_last_save', 'rdb_bgsave_in_progress', 'rdb_last_save_time', 'rdb_last_bgsave_status', 'aof_enabled', 'aof_rewrite_in_progress', 'aof_last_bgrewrite_status', 'aof_last_write_status'] },
      { section: 'Stats', keys: ['total_connections_received', 'total_commands_processed', 'instantaneous_ops_per_sec', 'total_net_input_bytes', 'total_net_output_bytes', 'keyspace_hits', 'keyspace_misses', 'expired_keys', 'evicted_keys', 'latest_fork_usec'] },
      { section: 'Replication', keys: ['role', 'connected_slaves', 'master_host', 'master_port', 'master_link_status', 'master_last_io_seconds_ago', 'slave_read_only', 'repl_backlog_active'] },
      { section: 'CPU', keys: ['used_cpu_sys', 'used_cpu_user', 'used_cpu_sys_children', 'used_cpu_user_children'] },
      { section: 'Cluster', keys: ['cluster_enabled'] },
      { section: 'Keyspace', keys: [] },
    ]

    const groups: VersionInfoGroup[] = []

    for (const { section, keys } of PICKS) {
      const source = sections.get(section)
      if (!source) continue

      // Keyspace 段没有固定键名（形如 db0），整段透出
      const picked = section === 'Keyspace'
        ? Object.keys(source).map((key) => ({ key, value: source[key] }))
        : keys.filter((key) => key in source).map((key) => ({ key, value: source[key] }))

      if (picked.length) groups.push({ section, entries: picked })
    }

    const server = sections.get('Server') ?? {}

    return {
      version: server.redis_version ?? '',
      mode: server.redis_mode || 'standalone',
      groups,
      raw: info,
    }
  }

  /**
   * 慢查询日志：LEN 与 GET 并行一次取回。
   *
   * GET 返回的每条是位置数组（不同版本长度不一）：
   *   [0] id  [1] 时间戳(秒)  [2] 耗时(微秒)  [3] 命令+参数
   *   [4] 客户端地址  [5] 客户端连接名（4.0+ 才有，缺省按空串处理）
   * 因此按下标解析并全部做兜底，而不是解构 —— 服务端少给一列也不崩。
   */
  async slowlog(id: string, count = 10): Promise<SlowlogOverview> {
    const client = this.mustGet(id)
    const [len, raw] = await Promise.all([
      client.slowlog('LEN'),
      client.slowlog('GET', String(count)),
    ])

    const list = Array.isArray(raw) ? raw : []
    const entries: SlowlogEntry[] = list.map((item) => {
      const row = Array.isArray(item) ? item : []
      const command = Array.isArray(row[3])
        ? row[3].map((part) => (part === null || part === undefined ? '' : String(part)))
        : []
      return {
        id: Number(row[0]) || 0,
        timestamp: Number(row[1]) || 0,
        duration: Number(row[2]) || 0,
        command,
        client: String(row[4] ?? ''),
        clientName: String(row[5] ?? ''),
      }
    })

    return { len: Number(len) || 0, entries }
  }

  /** 清空慢查询日志（SLOWLOG RESET）。清掉的是服务端日志，不可恢复。 */
  async slowlogReset(id: string): Promise<void> {
    const client = this.mustGet(id)
    await client.slowlog('RESET')
  }

  // ---------------------------------------------------------------- 键内存分析

  /**
   * 键内存分析扫描上限：逐键 MEMORY USAGE 是浏览路径上最重的读操作
   * （每 100 键一次网络往返 × 全库），百万键级实例全扫会分钟级起步。
   * 超过上限就截断收尾 —— SCAN 顺序本身无序，截断等价于均匀抽样，
   * 对「哪些前缀占大头」这类分布问题的结论影响很小。
   */
  private static readonly MEMORY_SCAN_LIMIT = 10_000

  /**
   * 键内存分析：SCAN 遍历当前库 + MEMORY USAGE 逐键探测，按前缀聚合。
   *
   * - 聚合口径与 mock 共用 shared/keyspace 的 memoryPrefixOf（同一规则两处实现必漂移）；
   * - MEMORY USAGE 用默认采样（集合类只统计采样元素，返回的是近似值）；
   * - 键在扫描间隙被删除时返回 null，按 0 字节计 —— 个别键消失不应让整次分析失败。
   */
  async memoryAnalysis(id: string, depth = 1): Promise<MemoryAnalysis> {
    const managed = this.pool.get(id)
    if (!managed) throw new Error(t('connectionManager.connectionClosedConnectFirst'))
    const client = managed.client

    const level = Math.min(Math.max(Math.floor(depth) || 1, 1), 4)
    const limit = ConnectionManager.MEMORY_SCAN_LIMIT
    const buckets = new Map<string, MemoryBucket>()
    let cursor = '0'
    let scanned = 0
    let truncated = false
    let totalBytes = 0

    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', '*', 'COUNT', 2000)
      cursor = next

      /* 剩余额度不足整批时截断：标记后只统计放得下的部分 */
      const room = limit - scanned
      const batch = room < keys.length ? keys.slice(0, room) : keys
      if (batch.length < keys.length) truncated = true

      for (let i = 0; i < batch.length; i += 100) {
        const slice = batch.slice(i, i + 100)
        const pipeline = client.pipeline()
        for (const key of slice) pipeline.memory('USAGE', key)
        const replies = await pipeline.exec()
        slice.forEach((key, j) => {
          const reply = replies?.[j]
          /* pipeline 回复是 [err, result]：键已删除时 result 为 null，按 0 计 */
          const bytes = reply?.[0] ? 0 : Math.max(0, Number(reply?.[1]) || 0)
          const prefix = memoryPrefixOf(key, level)
          const bucket = buckets.get(prefix) ?? { prefix, keys: 0, bytes: 0 }
          bucket.keys += 1
          bucket.bytes += bytes
          buckets.set(prefix, bucket)
          scanned += 1
          totalBytes += bytes
        })
      }

      if (truncated) break
    } while (cursor !== '0')

    /*
     * 桶数量上限：内存分析找的是大头，前 200 个前缀已覆盖实际排查；
     * 无界返回会让千前缀实例的 IPC payload 与表格渲染失重。
     */
    const sorted = [...buckets.values()].sort((a, b) => b.bytes - a.bytes || a.prefix.localeCompare(b.prefix))
    const bucketsTruncated = sorted.length > MEMORY_BUCKET_LIMIT
    return {
      depth: level,
      scanned,
      truncated,
      bucketsTruncated,
      totalBytes,
      buckets: bucketsTruncated ? sorted.slice(0, MEMORY_BUCKET_LIMIT) : sorted,
    }
  }

  // ---------------------------------------------------------------- Pub/Sub

  /** 订阅 Pub/Sub 消息推送（ipc 层注册后转发到渲染层） */
  onPubsubMessage(listener: (message: PubsubMessage) => void): () => void {
    this.pubsubListeners.add(listener)
    return () => this.pubsubListeners.delete(listener)
  }

  private emitPubsub(message: PubsubMessage): void {
    for (const listener of this.pubsubListeners) listener(message)
  }

  /**
   * 取该连接的 Pub/Sub 专用连接（无则创建）。
   *
   * 端点解析走 resolveEndpoint —— SSH 连接的共享隧道被复用，
   * 不会为订阅再开一条跳板机会话。
   * message / pmessage 两个事件在此统一转成推送载荷。
   */
  private async ensurePubsubClient(id: string): Promise<PubsubClient> {
    const existing = this.pubsubClients.get(id)
    if (existing) return existing

    const managed = this.pool.get(id)
    if (!managed) throw new Error(t('connectionManager.connectionClosed'))

    const endpoint = await this.resolveEndpoint(managed.config)
    const client = this.buildClient(managed.config, endpoint)
    client.on('message', (channel, message) => {
      this.emitPubsub({ connectionId: id, kind: 'message', channel, pattern: '', payload: message, timestamp: Date.now() })
    })
    client.on('pmessage', (pattern, channel, message) => {
      this.emitPubsub({ connectionId: id, kind: 'pmessage', channel, pattern, payload: message, timestamp: Date.now() })
    })
    await client.connect()

    const entry: PubsubClient = { client, channels: new Set(), patterns: new Set() }
    this.pubsubClients.set(id, entry)
    return entry
  }

  private pubsubStateOf(entry: PubsubClient): PubsubState {
    return { channels: [...entry.channels], patterns: [...entry.patterns] }
  }

  /** 订阅频道或模式；已订阅的目标幂等跳过（重复 SUBSCRIBE 会报错） */
  async pubsubSubscribe(id: string, targets: string[], pattern = false): Promise<PubsubState> {
    const entry = await this.ensurePubsubClient(id)
    const bucket = pattern ? entry.patterns : entry.channels
    for (const target of targets) {
      const name = target.trim()
      if (!name || bucket.has(name)) continue
      if (pattern) await entry.client.psubscribe(name)
      else await entry.client.subscribe(name)
      bucket.add(name)
    }
    return this.pubsubStateOf(entry)
  }

  /** 退订；目标不在订阅集合里时跳过（UNSUBSCRIBE 未订阅项虽不报错，但没必要发） */
  async pubsubUnsubscribe(id: string, targets: string[], pattern = false): Promise<PubsubState> {
    const entry = this.pubsubClients.get(id)
    if (!entry) return { channels: [], patterns: [] }
    const bucket = pattern ? entry.patterns : entry.channels
    for (const target of targets) {
      const name = target.trim()
      if (!name || !bucket.has(name)) continue
      if (pattern) await entry.client.punsubscribe(name)
      else await entry.client.unsubscribe(name)
      bucket.delete(name)
    }
    return this.pubsubStateOf(entry)
  }

  /** 发布消息：走主连接（PUBLISH 是普通命令，不需要订阅连接） */
  async pubsubPublish(id: string, channel: string, message: string): Promise<number> {
    const client = this.mustGet(id)
    const receivers = await client.publish(channel, message)
    return Number(receivers) || 0
  }

  /** 断开 Pub/Sub 专用连接。订阅模式的连接不能用 quit（发不出普通命令），直接强断。 */
  pubsubStop(id: string): void {
    const entry = this.pubsubClients.get(id)
    if (!entry) return
    this.pubsubClients.delete(id)
    try {
      entry.client.disconnect()
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- 键空间通知

  /** 订阅键空间事件（ipc 层注册后转发到渲染层） */
  onKeyspaceEvent(listener: (event: KeyspaceEvent) => void): () => void {
    this.keyspaceListeners.add(listener)
    return () => this.keyspaceListeners.delete(listener)
  }

  private emitKeyspaceEvent(event: KeyspaceEvent): void {
    for (const listener of this.keyspaceListeners) listener(event)
  }

  private async ensureKeyspaceClient(id: string): Promise<KeyspaceClient> {
    const existing = this.keyspaceClients.get(id)
    if (existing) return existing

    const managed = this.pool.get(id)
    if (!managed) throw new Error(t('connectionManager.connectionClosed'))

    const endpoint = await this.resolveEndpoint(managed.config)
    const client = this.buildClient(managed.config, endpoint)
    client.on('pmessage', (_pattern, channel, message) => {
      /*
       * 只订 __keyevent@*__:* 就够了：两种通知的载荷互为镜像
       * （keyevent 的频道带事件名、payload 是键名；keyspace 相反）。
       * 两者都订会让一次操作推两条重复事件。
       */
      const match = /^__(keyevent|keyspace)@(\d+)__:(.+)$/.exec(channel)
      if (!match) return
      const isKeyevent = match[1] === 'keyevent'
      this.emitKeyspaceEvent({
        connectionId: id,
        db: Number(match[2]) || 0,
        event: isKeyevent ? match[3] : message,
        key: isKeyevent ? message : match[3],
        channel,
        timestamp: Date.now(),
      })
    })
    await client.connect()

    const entry: KeyspaceClient = { client, patterns: new Set() }
    this.keyspaceClients.set(id, entry)
    return entry
  }

  /** 读取 notify-keyspace-events 当前配置（托管实例可能禁用 CONFIG，会抛错） */
  async keyspaceConfig(id: string): Promise<KeyspaceConfig> {
    const client = this.mustGet(id)
    const result = (await client.config('GET', 'notify-keyspace-events')) as string[] | null
    return { events: Array.isArray(result) ? (result[1] ?? '') : '' }
  }

  async setKeyspaceConfig(id: string, events: string): Promise<OperationResult> {
    const client = this.mustGet(id)
    await client.config('SET', 'notify-keyspace-events', events)
    return { ok: true }
  }

  /** 模式订阅键空间频道；已订阅项幂等跳过 */
  async keyspaceSubscribe(id: string, patterns: string[]): Promise<PubsubState> {
    const entry = await this.ensureKeyspaceClient(id)
    for (const target of patterns) {
      const name = target.trim()
      if (!name || entry.patterns.has(name)) continue
      await entry.client.psubscribe(name)
      entry.patterns.add(name)
    }
    return { channels: [], patterns: [...entry.patterns] }
  }

  async keyspaceUnsubscribe(id: string, patterns: string[]): Promise<PubsubState> {
    const entry = this.keyspaceClients.get(id)
    if (!entry) return { channels: [], patterns: [] }
    for (const target of patterns) {
      const name = target.trim()
      if (!name || !entry.patterns.has(name)) continue
      await entry.client.punsubscribe(name)
      entry.patterns.delete(name)
    }
    return { channels: [], patterns: [...entry.patterns] }
  }

  /** 断开键空间连接：订阅模式下同样只能强断 */
  keyspaceStop(id: string): void {
    const entry = this.keyspaceClients.get(id)
    if (!entry) return
    this.keyspaceClients.delete(id)
    try {
      entry.client.disconnect()
    } catch {
      /* ignore */
    }
  }

  async databases(id: string): Promise<DatabaseInfo[]> {
    const client = this.mustGet(id)
    /*
     * 两次往返并行。
     *
     * config GET databases 与 INFO keyspace 互不依赖（前者给库总数、
     * 后者给每库键数），串行等于白等一个 RTT。经 SSH 隧道时单程
     * 阈值可达 50–150ms，省下的就是用户能直接感知的等待。
     * 用 pipeline 而不是 multi：两者都能把多条命令合并成一次写/读，
     * 但 multi 会额外包一层 MULTI/EXEC 事务语义，对只读命令没有意义。
     */
    const [[configErr, config], [, info]] = (await client
      .pipeline()
      .config('GET', 'databases')
      .info('keyspace')
      .exec()) as unknown as [[Error | null, unknown], [Error | null, string]]
    if (configErr) throw configErr

    const count = Number(Array.isArray(config) ? config[1] : 16) || 16
    const result: DatabaseInfo[] = []
    for (let db = 0; db < count; db++) {
      const matched = new RegExp(`^db${db}:keys=(\\d+)`, 'm').exec(info)
      result.push({ db, keys: matched ? Number(matched[1]) : 0 })
    }
    return result
  }

  // ---------------------------------------------------------------- Key 浏览

  private async describeKeys(client: Redis, keys: string[]): Promise<RedisKeyItem[]> {
    if (!keys.length) return []
    const pipeline = client.pipeline()
    for (const key of keys) {
      pipeline.type(key)
      pipeline.ttl(key)
    }
    const replies = await pipeline.exec()
    return keys.map((key, index) => {
      const typeReply = replies?.[index * 2]
      const ttlReply = replies?.[index * 2 + 1]
      return {
        key,
        type: (typeReply?.[0] ? 'none' : typeReply?.[1]) as RedisValueType,
        ttl: typeReply?.[0] ? -2 : Number(ttlReply?.[1] ?? -2),
      }
    })
  }

  async scan(id: string, options: ScanOptions = {}): Promise<ScanResult> {
    const managed = this.pool.get(id)
    if (!managed) throw new Error(t('connectionManager.connectionClosedConnectFirst'))
    const client = managed.client

    const db = options.db ?? managed.db
    /*
     * 切库判断用自维护的 managed.db（SELECT 后同步更新），
     * 绝不能用 client.options.db —— 那是创建时的静态配置。
     */
    if (db !== managed.db) {
      await client.select(db)
      managed.db = db
    }

    const cursor = options.cursor && options.cursor !== '' ? options.cursor : '0'
    const match = options.match?.trim() ? options.match.trim() : '*'
    /*
     * 上限 5000：全库搜索每批传 5000（大部分批不匹配，大批量把往返次数降到 1/5）；
     * 普通分页浏览仍走 settings.pageSize（几百量级），不受影响。
     */
    const count = Math.min(Math.max(options.count ?? 200, 10), 5000)

    const [nextCursor, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', count)
    return { cursor: nextCursor, keys: await this.describeKeys(client, keys), db }
  }

  /** 单键元信息查询（TYPE/TTL 一次 pipeline 往返）：精确搜索短路用，键不存在返回 null */
  async lookupKey(id: string, key: string, db?: number): Promise<RedisKeyItem | null> {
    const managed = this.pool.get(id)
    if (!managed) throw new Error(t('connectionManager.connectionClosedConnectFirst'))
    const client = managed.client

    const target = db ?? managed.db
    /*
     * 切库判断同 scan：用自维护的 managed.db，
     * client.options.db 是创建时的静态配置，不可读。
     */
    if (target !== managed.db) {
      await client.select(target)
      managed.db = target
    }

    const pipeline = client.pipeline()
    pipeline.type(key)
    pipeline.ttl(key)
    const replies = await pipeline.exec()
    const typeReply = replies?.[0]
    const ttlReply = replies?.[1]
    const type = (typeReply?.[0] ? 'none' : typeReply?.[1]) as RedisValueType
    if (type === 'none') return null
    return { key, type, ttl: ttlReply?.[0] ? -2 : Number(ttlReply?.[1] ?? -2) }
  }

  /**
   * 全库搜索：SCAN 循环整体下沉到主进程，渲染层一次调用拿全量结果。
   *
   * 与逐页 scan 的本质差异（性能优化的两根支柱）：
   *   1. 砍逐批 TYPE/TTL —— 旧实现在渲染层逐批调 scan IPC，主进程每批都对
   *      匹配键做 TYPE/TTL pipeline（批数 × 一次往返）；这里循环内只取键名，
   *      结束后对最终结果集（≤ limit，通常远小于全库）一次批量元信息。
   *   2. 砍逐批 IPC —— 循环留在主进程内，省掉批数次的 invoke 往返。
   *
   * 取消语义：cancelSearch / 新一轮 searchAll 会递增令牌，循环每批对比令牌，
   * 不一致即停并返回已找到的部分（cancelled=true）—— 渲染层的「停止保留
   * 已找到结果」靠它实现。 capped 只在因达上限退出（游标未归零）时为 true。
   */
  async searchAll(id: string, options: SearchAllOptions = {}): Promise<SearchAllResult> {
    const managed = this.pool.get(id)
    if (!managed) throw new Error(t('connectionManager.connectionClosedConnectFirst'))
    const client = managed.client

    const db = options.db ?? managed.db
    // 切库判断用自维护的 managed.db（与 scan 同一陷阱：options.db 是静态配置）
    if (db !== managed.db) {
      await client.select(db)
      managed.db = db
    }

    const match = options.match?.trim() ? options.match.trim() : '*'
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 1000)

    // 本轮令牌：启动即递增 —— 同连接并发发起的第二轮搜索自动作废第一轮
    const token = (this.searchTokens.get(id) ?? 0) + 1
    this.searchTokens.set(id, token)

    /*
     * do-while：初始 cursor='0' 也要发首批（历史 bug —— while 写法
     * 让循环一次都不进，全库搜索永远假报"0 条已扫完"）。
     */
    let cursor = '0'
    let cancelled = false
    const seen = new Set<string>()
    const keys: string[] = []
    do {
      // 每批之间检查令牌：停止按钮 / 新一轮搜索 / 断开清理都会使其失效
      if (this.searchTokens.get(id) !== token) {
        cancelled = true
        break
      }
      const [next, names] = await client.scan(cursor, 'MATCH', match, 'COUNT', 5000)
      // SCAN 在键增删时可能重复返回同一键，去重后计入
      for (const key of names) {
        if (seen.has(key)) continue
        seen.add(key)
        if (keys.length < limit) keys.push(key)
      }
      cursor = next
      this.emitSearchProgress({ connectionId: id, found: keys.length })
    } while (cursor !== '0' && keys.length < limit)

    const capped = cursor !== '0' && !cancelled
    return { keys: await this.describeKeys(client, keys), capped, cancelled }
  }

  /** 取消该连接的在途全库搜索：递增令牌让扫描循环在下一批停下 */
  async cancelSearch(id: string): Promise<OperationResult> {
    this.searchTokens.set(id, (this.searchTokens.get(id) ?? 0) + 1)
    return { ok: true }
  }

  /**
   * string 值的原始字节。
   *
   * 普通 GET 返回的是 UTF-8 解码后的字符串，gzip / 图片等二进制会丢失字节，
   * 因此格式化能力必须按需走 getBuffer。字节与解压结果都做上限截断，
   * 避免大值把 IPC 和渲染进程拖死。
   */
  async valueBinary(
    id: string,
    key: string,
    options: ValueBinaryOptions = {},
  ): Promise<ValueBinaryResult> {
    const client = this.mustGet(id)
    const buffer = await client.getBuffer(key)
    if (!buffer) return { base64: '', bytes: 0, truncated: false }

    const bytes = buffer.length
    const kept =
      bytes > VALUE_BINARY_MAX_BYTES ? buffer.subarray(0, VALUE_BINARY_MAX_BYTES) : buffer
    const result: ValueBinaryResult = {
      base64: kept.toString('base64'),
      bytes,
      truncated: kept.length < bytes,
    }

    if (options.decode) {
      const requested = options.maxOutputBytes ?? VALUE_DECODE_MAX_BYTES
      const maxOutputBytes = Math.min(
        Math.max(requested, 64 * 1024),
        VALUE_DECODE_MAX_BYTES_CAP,
      )
      try {
        const decoded =
          options.decode === 'gzip'
            ? gunzipSync(kept, { maxOutputLength: maxOutputBytes })
            : inflateSync(kept, { maxOutputLength: maxOutputBytes })
        result.decodedText = decoded.toString('utf-8')
        result.decodedBytes = decoded.length
      } catch (error) {
        result.decodeError = toMessage(error)
      }
    }

    return result
  }

  async getValue(id: string, key: string, options: ValueReadOptions = {}): Promise<KeyValue> {
    const client = this.mustGet(id)
    const limit = clampValuePageLimit(options.limit)
    /*
     * type / ttl / encoding 合并成一次往返。
     *
     * 原来 type 单独一次、ttl+object 再并行一次 —— 属于「串行两跳」，
     * 经 SSH 隧道时固定多花 1 个 RTT（实测 50–150ms）。
     * 这三条互不依赖，用 pipeline 合并后整次取值少一跳。
     * 后面「按类型取数据」那一跳无法省略（必须先知道类型）。
     *
     * object ENCODING 在部分类型 / 版本上不支持，单项失败不应中断取值：
     * ioredis 的 pipeline 会把失败项解成 [err, null]，这里再统一兜底。
     */
    const meta = await client
      .pipeline()
      .type(key)
      .ttl(key)
      .object('ENCODING', key)
      .exec()
      .catch(() => null)
    const [[, rawType], [, ttl], [, rawEncoding]] = (meta ?? [
      [null, 'none'],
      [null, -2],
      [null, undefined],
    ]) as [[Error | null, string], [Error | null, number], [Error | null, unknown]]
    const type = (rawType ?? 'none') as RedisValueType
    const encoding = typeof rawEncoding === 'string' ? rawEncoding : undefined
    const base = { key, type, ttl, encoding }

    /*
     * 集合类只取第一页：length 仍是服务端真实总数，
     * value 只是已加载部分，nextCursor 非空时界面显示「加载更多」。
     * string 无法分页（GET 本身就是整值），保持一次读完。
     */
    switch (type) {
      case 'string': {
        const value = await client.get(key)
        return { ...base, length: value?.length ?? 0, value, nextCursor: null }
      }
      case 'hash': {
        const [page, total] = await Promise.all([
          readHashPage(client, key, '0', limit),
          client.hlen(key),
        ])
        return { ...base, length: total, value: page.value, nextCursor: page.cursor }
      }
      case 'list': {
        const [list, total] = await Promise.all([
          client.lrange(key, 0, limit - 1),
          client.llen(key),
        ])
        return {
          ...base,
          length: total,
          value: list,
          nextCursor: total > list.length ? String(list.length) : null,
        }
      }
      case 'set': {
        const [page, total] = await Promise.all([
          readSetPage(client, key, '0', limit),
          client.scard(key),
        ])
        return { ...base, length: total, value: page.value, nextCursor: page.cursor }
      }
      case 'zset': {
        const [rows, total] = await Promise.all([
          client.zrange(key, 0, limit - 1, 'WITHSCORES'),
          client.zcard(key),
        ])
        const pairs = flattenZsetRows(rows)
        return {
          ...base,
          length: total,
          value: pairs,
          nextCursor: total > pairs.length ? String(pairs.length) : null,
        }
      }
      case 'stream': {
        // 多取一条用于判断「还有更多」，避免额外的 XLEN 之外再发往返
        const [entries, total] = await Promise.all([
          client.xrange(key, '-', '+', 'COUNT', limit + 1),
          client.xlen(key),
        ])
        const hasMore = entries.length > limit
        const kept = hasMore ? entries.slice(0, limit) : entries
        return {
          ...base,
          length: total,
          value: flattenStreamEntries(kept),
          nextCursor: hasMore ? kept[kept.length - 1]?.[0] ?? null : null,
        }
      }
      default:
        return { ...base, value: null, nextCursor: null }
    }
  }

  /**
   * 读取大 key 的后续一页。
   *
   * 游标格式按类型区分：
   *   hash / set —— SCAN 游标（跨页可能重复，调用方负责去重）；
   *   list / zset —— 下一个偏移量（分页期间增删会让偏移漂移，属可接受的弱一致）；
   *   stream —— 上一页最后一条条目 ID（含边界重读一条后丢弃，兼容不支持
   *               排他区间的旧版本，不依赖 Redis 6.2 的 `(` 语法）。
   */
  async valuePage(id: string, key: string, options: ValuePageOptions): Promise<ValuePageResult> {
    const client = this.mustGet(id)
    const limit = clampValuePageLimit(options.limit)
    const cursor = options.cursor ?? ''
    const type = options.type

    switch (type) {
      case 'hash': {
        const [page, total] = await Promise.all([
          readHashPage(client, key, cursor || '0', limit),
          client.hlen(key),
        ])
        return { key, type, length: total, value: page.value, nextCursor: page.cursor }
      }
      case 'set': {
        const [page, total] = await Promise.all([
          readSetPage(client, key, cursor || '0', limit),
          client.scard(key),
        ])
        return { key, type, length: total, value: page.value, nextCursor: page.cursor }
      }
      case 'list': {
        const offset = Math.max(Number(cursor) || 0, 0)
        const [items, total] = await Promise.all([
          client.lrange(key, offset, offset + limit - 1),
          client.llen(key),
        ])
        const end = offset + items.length
        return {
          key,
          type,
          length: total,
          value: items,
          nextCursor: items.length > 0 && end < total ? String(end) : null,
        }
      }
      case 'zset': {
        const offset = Math.max(Number(cursor) || 0, 0)
        const [rows, total] = await Promise.all([
          client.zrange(key, offset, offset + limit - 1, 'WITHSCORES'),
          client.zcard(key),
        ])
        const pairs = flattenZsetRows(rows)
        const end = offset + pairs.length
        return {
          key,
          type,
          length: total,
          value: pairs,
          nextCursor: pairs.length > 0 && end < total ? String(end) : null,
        }
      }
      case 'stream': {
        /*
         * 多取两条：一条可能是上一页末尾重复读到的游标条目，
         * 另一条用于判断是否还有下一页。
         */
        const entries = await client.xrange(key, cursor || '-', '+', 'COUNT', limit + 2)
        const after = cursor && entries[0]?.[0] === cursor ? entries.slice(1) : entries
        const hasMore = after.length > limit
        const kept = hasMore ? after.slice(0, limit) : after
        const value = flattenStreamEntries(kept)
        const nextCursor = hasMore ? kept[kept.length - 1]?.[0] ?? null : null
        if (!value.length && !nextCursor) {
          return { key, type, length: 0, value, nextCursor: null }
        }
        return {
          key,
          type,
          length: await client.xlen(key),
          value,
          nextCursor,
        }
      }
      case 'string': {
        const value = await client.get(key)
        return { key, type, length: value?.length ?? 0, value, nextCursor: null }
      }
      default:
        return { key, type, value: null, nextCursor: null }
    }
  }

  /**
   * 键列表增量刷新：从游标 0 重扫当前模式，一次返回新元信息。
   *
   * 与 scan 的区别不是命令，而是**交互语义**：
   *   · scan 是分页尾巴，渲染层每翻一页一次 IPC；
   *   · refreshKeys 是「原地刷新」，主进程一次扫够用户已加载的键数，
   *     渲染层用结果整体替换列表，不闪骨架屏、不丢滚动位置。
   *
   * limit 是「至少收集多少键」：达到后停止，但最后一批完整返回 ——
   * 若截断批次，SCAN 游标已经越过被丢弃的键，这些键在后续分页里
   * 永远不会出现。返回值里的 cursor 供渲染层继续「加载更多」。
   */
  async refreshKeys(id: string, options: RefreshKeysOptions = {}): Promise<RefreshKeysResult> {
    const managed = this.pool.get(id)
    if (!managed) throw new Error(t('connectionManager.connectionClosedConnectFirst'))
    const client = managed.client

    const db = options.db ?? managed.db
    // 切库判断同 scan：用自维护的 managed.db，client.options.db 是创建时的静态配置
    if (db !== managed.db) {
      await client.select(db)
      managed.db = db
    }

    const match = options.match?.trim() ? options.match.trim() : '*'
    const limit = options.limit && options.limit > 0
      ? Math.min(Math.floor(options.limit), REFRESH_KEY_MAX)
      : 0

    let cursor = '0'
    const seen = new Set<string>()
    const names: string[] = []
    do {
      const [next, batch] = await client.scan(cursor, 'MATCH', match, 'COUNT', REFRESH_SCAN_COUNT)
      // SCAN 在键增删时可能重复返回同一键，去重后计入
      for (const name of batch) {
        if (seen.has(name)) continue
        seen.add(name)
        names.push(name)
      }
      cursor = next
      if (limit && names.length >= limit) break
    } while (cursor !== '0')

    return { keys: await this.describeKeys(client, names), cursor, db }
  }

  /**
   * 覆盖写入。
   * 语义：编辑类页面保存的是「整键快照」，因此先清理旧数据再写入，
   * 避免类型切换时触发 WRONGTYPE，也避免集合类残留元素。
   */
  async setValue(
    id: string,
    key: string,
    type: RedisValueType,
    payload: string | string[] | Record<string, string>,
    ttlSeconds?: number,
    isNew = false,
  ): Promise<OperationResult> {
    const client = this.mustGet(id)

    if (!isNew) {
      const currentType = await client.type(key)
      if (currentType !== 'none' && currentType !== type) await client.del(key)
    }

    switch (type) {
      case 'string': {
        /*
         * 未显式指定 TTL 时用 KEEPTTL：裸 SET 会清掉键的剩余存活时间，
         * 行内编辑一个带 TTL 的 string 键会把它悄悄变成永久键。
         * 指定了 ttlSeconds 则用普通 SET，由下方统一的 expire 覆盖。
         */
        const text = String(payload)
        if (ttlSeconds) await client.set(key, text)
        else await client.set(key, text, 'KEEPTTL')
        break
      }

      case 'hash': {
        await client.del(key)
        const flat = payload as Record<string, string>
        const entries = Object.entries(flat).flat()
        if (entries.length) await client.hset(key, entries)
        break
      }

      case 'list': {
        await client.del(key)
        const items = payload as string[]
        if (items.length) await client.rpush(key, ...items)
        break
      }

      case 'set': {
        await client.del(key)
        const members = payload as string[]
        if (members.length) await client.sadd(key, ...members)
        break
      }

      case 'zset': {
        await client.del(key)
        // 约定格式：每行 "member :: score"
        const pairs: (string | number)[] = []
        for (const row of payload as string[]) {
          const [member, score] = row.split('::').map((part) => part.trim())
          if (!member) continue
          pairs.push(Number(score) || 0, member)
        }
        if (pairs.length) await client.zadd(key, ...(pairs as [number, string]))
        break
      }

      case 'stream': {
        await client.del(key)
        /*
         * 约定格式：每行 "field :: value"。
         *
         * 用 `*` 作为消息 ID 让 Redis 自动生成 —— 手工指定 ID 需要满足
         * "必须大于上一条"的单调约束，让用户去填既容易出错也没有意义。
         * 一行里没有 :: 的，整行当作 field、value 留空，
         * 这样"只要一个占位消息"的场景可以直接敲一个词。
         */
        for (const row of payload as string[]) {
          const index = row.indexOf('::')
          const field = (index >= 0 ? row.slice(0, index) : row).trim()
          const value = index >= 0 ? row.slice(index + 2).trim() : ''
          if (!field) continue
          await client.xadd(key, '*', field, value)
        }
        break
      }

      default:
        return { ok: false, message: t('connectionManager.writingTypeNotSupportedYet', { type }) }
    }

    if (ttlSeconds && ttlSeconds > 0) await client.expire(key, ttlSeconds)
    return { ok: true, message: t('common.saved') }
  }

  async deleteKeys(id: string, keys: string[]): Promise<OperationResult> {
    if (!keys.length) return { ok: true, message: t('connectionManager.noKeysSelected') }
    const client = this.mustGet(id)
    const removed = await client.del(...keys)
    return { ok: true, message: t('session.deletedCountKeys', { count: removed }) }
  }

  /**
   * 删除 hash 的单个字段。
   * 注意 Redis 语义：最后一个字段被删掉后，该键本身也会消失。
   */
  async deleteHashField(id: string, key: string, field: string): Promise<OperationResult> {
    const client = this.mustGet(id)
    const removed = await client.hdel(key, field)
    if (!removed) return { ok: false, message: t('connectionManager.fieldNotExist', { field }) }

    const left = await client.hlen(key)
    return {
      ok: true,
      message: left
        ? t('connectionManager.fieldDeleted', { field })
        : t('connectionManager.fieldDeletedKeyRemoved', { field }),
    }
  }

  /**
   * 跨版本兼容的原始命令调用。
   * 使用 call 而非类型化方法：HEXPIRE / HTTL / HPERSIST 等 7.4+ 命令
   * 在 ioredis 的类型定义里未必存在，且低版本服务端会直接返回错误，
   * 需要由调用方捕获并降级。
   */
  private async raw(client: Redis, ...args: (string | number)[]): Promise<unknown> {
    return (client.call as unknown as (...a: (string | number)[]) => Promise<unknown>)(...args)
  }

  /**
   * 读取 hash 各字段的剩余 TTL（Redis 7.4+ 的 HTTL）。
   *
   * 返回 map：字段名 → 剩余秒数。
   * -1 表示该字段无过期时间（永久），-2 表示字段或键不存在。
   * 服务端不支持该命令时返回 null，由界面按「能力不可用」处理。
   */
  async hashFieldTtls(id: string, key: string, fields: string[]): Promise<Record<string, number> | null> {
    if (!fields.length) return {}
    const client = this.mustGet(id)
    try {
      const reply = await this.raw(client, 'HTTL', key, 'FIELDS', fields.length, ...fields)
      if (!Array.isArray(reply)) return null

      const result: Record<string, number> = {}
      fields.forEach((field, index) => {
        result[field] = Number(reply[index] ?? -2)
      })
      return result
    } catch {
      // 低版本服务端：unknown command
      return null
    }
  }

  /**
   * 设置 hash 单个字段的 TTL（Redis 7.4+ 的 HEXPIRE）。
   * seconds <= 0 时改用 HPERSIST 清除过期时间，恢复为永久字段。
   */
  async setHashFieldTtl(
    id: string,
    key: string,
    field: string,
    seconds: number,
  ): Promise<OperationResult> {
    const client = this.mustGet(id)

    if (!(await client.exists(key))) return { ok: false, message: t('connectionManager.keyNoLongerExists', { key }) }

    try {
      if (seconds <= 0) {
        const cleared = await this.raw(client, 'HPERSIST', key, 'FIELDS', 1, field)
        const code = Array.isArray(cleared) ? Number(cleared[0]) : Number(cleared)
        if (code === -2) return { ok: false, message: t('connectionManager.fieldNotExist', { field }) }
        if (code === -1) return { ok: true, message: t('connectionManager.fieldAlreadyNoExpiration', { field }) }
        return { ok: true, message: t('connectionManager.clearedExpirationField', { field }) }
      }

      const reply = await this.raw(client, 'HEXPIRE', key, seconds, 'FIELDS', 1, field)
      const code = Array.isArray(reply) ? Number(reply[0]) : Number(reply)

      // 返回值语义见 Redis 官方文档：-2 不存在 / 2 已过期被删除 / 1 设置成功
      if (code === -2) return { ok: false, message: t('connectionManager.fieldNotExist', { field }) }
      if (code === 2) return { ok: true, message: t('connectionManager.fieldExpiredRemoved', { field }) }
      return { ok: true, message: t('connectionManager.ttlForFieldSetSeconds', { field, seconds }) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/unknown command/i.test(message)) {
        return { ok: false, message: t('connectionManager.currentServerNotSupportField') }
      }
      return { ok: false, message }
    }
  }

  /**
   * 修改 zset 成员。
   *
   * 分两种情形：
   * - 仅改 score：ZADD 对已存在的 member 是更新语义，直接写即可；
   * - 改 member 名：等价于 ZREM 旧 + ZADD 新（带新 score），
   *   用 pipeline 保证同往返，避免中间态。
   * score 必须是合法数字 —— Redis 返回的错误信息不友好，这里先校验。
   */
  async setZsetMember(
    id: string,
    key: string,
    member: string,
    nextMember: string,
    nextScore: number,
  ): Promise<OperationResult> {
    const client = this.mustGet(id)
    const target = nextMember.trim()
    if (!target) return { ok: false, message: t('common.memberContentCannotEmpty') }
    if (!Number.isFinite(nextScore)) return { ok: false, message: t('common.scoreNumber') }
    if (!(await client.exists(key))) return { ok: false, message: t('connectionManager.keyNoLongerExists', { key }) }

    const renamed = target !== member

    if (!renamed) {
      await client.zadd(key, nextScore, target)
      return { ok: true, message: t('connectionManager.updatedScoreMember', { member: target, score: nextScore }) }
    }

    // 改名：旧成员可能与他人重名冲突，如实提示
    const existed = await client.zscore(key, target)
    const pipeline = client.pipeline()
    pipeline.zrem(key, member)
    pipeline.zadd(key, nextScore, target)
    await pipeline.exec()

    const total = await client.zcard(key)
    return {
      ok: true,
      message:
        existed !== null
          ? total
            ? t('connectionManager.memberRemovedScoreUpdated', {
                member,
                target,
                score: nextScore,
              })
            : t('connectionManager.memberRemovedScoreKeyRemoved', {
                member,
                target,
                score: nextScore,
              })
          : total
            ? t('connectionManager.memberRenamedWithScore', { member, target, score: nextScore })
            : t('connectionManager.memberRenamedScoreKeyRemoved', {
                member,
                target,
                score: nextScore,
              }),
    }
  }

  /** 删除 zset 成员 */
  async deleteZsetMember(id: string, key: string, member: string): Promise<OperationResult> {
    const client = this.mustGet(id)
    const removed = await client.zrem(key, member)
    if (!removed) return { ok: false, message: t('connectionManager.memberNotExist', { member }) }

    const left = await client.zcard(key)
    return {
      ok: true,
      message: left
        ? t('connectionManager.memberDeleted', { member })
        : t('connectionManager.memberDeletedKeyRemoved', { member }),
    }
  }

  /** 新增 zset 成员（ZADD 幂等：已存在则更新 score） */
  async addZsetMember(
    id: string,
    key: string,
    member: string,
    score: number,
  ): Promise<OperationResult> {
    const client = this.mustGet(id)
    const target = member.trim()
    if (!target) return { ok: false, message: t('common.memberContentCannotEmpty') }
    if (!Number.isFinite(score)) return { ok: false, message: t('common.scoreNumber') }

    const exists = await client.exists(key)
    const existingScore = await client.zscore(key, target)
    await client.zadd(key, score, target)
    const total = await client.zcard(key)

    if (existingScore !== null) {
      return { ok: true, message: t('connectionManager.memberAlreadyExistsScore', { member: target, score }) }
    }
    return {
      ok: true,
      message: exists
        ? t('connectionManager.addedMember', { member: target, count: total })
        : t('connectionManager.sortedSetCreatedAdded', { count: total }),
    }
  }

  /**
   * 向 stream 追加一条 entry（XADD，2026-10 补齐与 hash/list/set/zset 对称的新增入口）。
   *
   * ID 用 `*` 让服务端自动生成 —— 手工指定必须满足「大于上一条」的
   * 单调约束，让用户填既容易出错也没有意义（与 createKey 的 stream
   * 分支同一约定）。返回生成后的 ID 便于用户在 redis-cli 对账。
   */
  async xaddEntry(id: string, key: string, field: string, value: string): Promise<OperationResult> {
    const client = this.mustGet(id)
    const target = field.trim()
    if (!target) return { ok: false, message: t('connectionManager.fieldNameCannotEmpty') }

    const exists = await client.exists(key)
    const entryId = await client.xadd(key, '*', target, value)
    return {
      ok: true,
      message: exists
        ? t('connectionManager.appendedMessageId', { id: String(entryId) })
        : t('connectionManager.streamCreatedMessageId', { id: String(entryId) }),
    }
  }

  /**
   * 修改 set 成员。
   *
   * set 成员本身即标识，因此"修改"等价于 SREM 旧成员 + SADD 新成员。
   * 用 pipeline 保证两步在同一往返内完成，避免中间态被其他客户端读到。
   * 若新成员已存在，SADD 不会重复添加 —— 此时相当于删除了旧成员，
   * 返回值如实说明这一点，避免用户以为"改没生效"。
   */
  async setSetMember(
    id: string,
    key: string,
    member: string,
    next: string,
  ): Promise<OperationResult> {
    const client = this.mustGet(id)
    const target = next.trim()
    if (!target) return { ok: false, message: t('common.memberContentCannotEmpty') }
    if (!(await client.exists(key))) return { ok: false, message: t('connectionManager.keyNoLongerExists', { key }) }

    if (target === member) {
      return { ok: true, message: t('connectionManager.contentUnchanged') }
    }

    const existed = await client.sismember(key, target)
    const pipeline = client.pipeline()
    pipeline.srem(key, member)
    pipeline.sadd(key, target)
    await pipeline.exec()

    const left = await client.scard(key)
    return {
      ok: true,
      message: existed
        ? left
          ? t('connectionManager.memberDeletedTargetExisted', { member, target })
          : t('connectionManager.memberDeletedTargetKeyRemoved', { member, target })
        : left
          ? t('connectionManager.memberRenamed', { member, target })
          : t('connectionManager.memberRenamedKeyRemoved', { member, target }),
    }
  }

  /** 删除 set 成员 */
  async deleteSetMember(id: string, key: string, member: string): Promise<OperationResult> {
    const client = this.mustGet(id)
    const removed = await client.srem(key, member)
    if (!removed) return { ok: false, message: t('connectionManager.memberNotExist', { member }) }

    const left = await client.scard(key)
    return {
      ok: true,
      message: left
        ? t('connectionManager.memberDeleted', { member })
        : t('connectionManager.memberDeletedKeyRemoved', { member }),
    }
  }

  /** 新增 set 成员（SADD 幂等：已存在时不会重复添加） */
  async addSetMember(id: string, key: string, member: string): Promise<OperationResult> {
    const client = this.mustGet(id)
    const target = member.trim()
    if (!target) return { ok: false, message: t('common.memberContentCannotEmpty') }

    const exists = await client.exists(key)
    const added = await client.sadd(key, target)
    const total = await client.scard(key)

    if (!added) return { ok: true, message: t('connectionManager.memberAlreadyExistsNotAdded', { member: target }) }
    return {
      ok: true,
      message: exists
        ? t('connectionManager.addedMember', { member: target, count: total })
        : t('connectionManager.setCreatedAdded', { count: total }),
    }
  }

  /**
   * 删除 list 指定位置的元素。
   *
   * 用哨兵值 + LREM 而非 LSET(空) 来删除：
   * LSET 只能改值不能删元素，若置为空串会在列表里留下一个空元素。
   * LREM count=1 从头部起删除第一个匹配项，配合唯一哨兵可精确定位。
   */
  async deleteListElement(id: string, key: string, index: number): Promise<OperationResult> {
    const client = this.mustGet(id)
    const length = await client.llen(key)
    if (index < 0 || index >= length) {
      return { ok: false, message: t('connectionManager.listPositionMissingLength') }
    }

    const current = await client.lindex(key, index)
    if (current === null) return { ok: false, message: t('connectionManager.listPositionMissing') }

    // 先用哨兵替换目标位置，再用 LREM 精确删除，避免误删同值的其他元素
    const token = `__RDM_DEL_${Date.now()}_${Math.random().toString(36).slice(2)}__`
    await client.lset(key, index, token)
    await client.lrem(key, 1, token)

    const left = await client.llen(key)
    return {
      ok: true,
      message: left
        ? t('connectionManager.listItemDeleted', { index: index + 1 })
        : t('connectionManager.listItemDeletedKeyRemoved', { index: index + 1 }),
    }
  }

  /**
   * 修改 list 指定位置的元素值。
   * 越界判断一次，避免 LSET 直接抛错给前端。
   */
  async setListElement(
    id: string,
    key: string,
    index: number,
    value: string,
  ): Promise<OperationResult> {
    const client = this.mustGet(id)
    const length = await client.llen(key)
    if (index < 0 || index >= length) {
      return { ok: false, message: t('connectionManager.listPositionMissingLength') }
    }

    await client.lset(key, index, value)
    return { ok: true, message: t('connectionManager.updatedItemIndex', { index: index + 1 }) }
  }

  /**
   * 向 list 末尾追加元素。
   * LSET 无法越界写入，追加必须走 RPUSH，因此单独提供该方法。
   */
  async appendListElement(id: string, key: string, value: string): Promise<OperationResult> {
    const client = this.mustGet(id)
    const exists = await client.exists(key)
    await client.rpush(key, value)
    const length = await client.llen(key)
    return {
      ok: true,
      message: exists
        ? t('connectionManager.appendedEnd', { count: length })
        : t('connectionManager.listCreatedAppended', { count: length }),
    }
  }

  /**
   * 在指定位置插入元素。
   * position 为 before / after —— 复用 Redis 原生的 LINSERT 语义，
   * 避免用 LSET 拼接造成的多次往返与竞态。
   */
  async insertListElement(
    id: string,
    key: string,
    index: number,
    value: string,
    position: 'before' | 'after',
  ): Promise<OperationResult> {
    const client = this.mustGet(id)
    const pivot = await client.lindex(key, index)
    if (pivot === null) return { ok: false, message: t('connectionManager.referencePositionNoLonger') }

    // LINSERT 以「值」为基准，遇到重复值会插错位置，因此同样用哨兵替换法
    const token = `__RDM_PIVOT_${Date.now()}_${Math.random().toString(36).slice(2)}__`
    await client.lset(key, index, token)
    // ioredis 为 LINSERT 提供了两个字面量重载，联合类型无法同时满足；
    // 走 call 通道绕开重载签名，语义与直接调用一致
    await this.raw(client, 'LINSERT', key, position === 'before' ? 'BEFORE' : 'AFTER', token, value)
    // 把哨兵还原为原值
    await client.lset(key, index, pivot)

    return {
      ok: true,
      message:
        position === 'before'
          ? t('connectionManager.insertedBeforeItemIndex', { index: index + 1 })
          : t('connectionManager.insertedAfterItemIndex', { index: index + 1 }),
    }
  }

  /**
   * 写入 hash 的单个字段。
   * field 与 field 不一致时视为重命名：先删旧字段再写新字段；
   * 目标字段已存在则直接覆盖，与 Redis HSET 语义一致。
   *
   * 注意：HSET 会清除该字段既有的 TTL（Redis 对"替换值"的定义），
   * 因此当调用方传入 keepTtlSeconds 时，这里在写入后重新设置一次过期时间。
   */
  async setHashField(
    id: string,
    key: string,
    field: string,
    value: string,
    nextField?: string,
    keepTtlSeconds?: number,
  ): Promise<OperationResult> {
    const client = this.mustGet(id)
    const target = (nextField ?? field).trim()

    if (!target) return { ok: false, message: t('connectionManager.fieldNameCannotEmpty') }
    if (!(await client.exists(key))) return { ok: false, message: t('connectionManager.keyNoLongerExists', { key }) }

    await client.hset(key, target, value)

    // 值被替换后字段 TTL 会被清除，按需恢复
    if (keepTtlSeconds && keepTtlSeconds > 0) {
      try {
        await this.raw(client, 'HEXPIRE', key, keepTtlSeconds, 'FIELDS', 1, target)
      } catch {
        /* 服务端不支持字段 TTL：忽略，主流程已成功 */
      }
    }

    if (target !== field) {
      await client.hdel(key, field)
      return { ok: true, message: t('connectionManager.renamedName', { name: target }) }
    }
    return { ok: true, message: t('connectionManager.updatedField', { field: target }) }
  }

  async renameKey(id: string, key: string, newKey: string): Promise<OperationResult> {
    const client = this.mustGet(id)
    /*
     * 目标键已存在时直接拒绝，而不是让 Redis 原生 RENAME 静默覆盖它。
     * 覆盖会把一个无辜的键连同数据一起删掉，用户在界面上看不到任何预告 ——
     * 单键重命名与批量重命名共用这里，批量场景下一次误覆盖可能波及上千个键。
     * 需要覆盖时用户可以先删目标键，路径明确且不可误触。
     */
    const exists = await client.exists(newKey)
    if (exists) {
      throw new Error(t('connectionManager.targetKeyAlreadyExists', { key: newKey }))
    }
    await client.rename(key, newKey)
    return { ok: true, message: t('common.renamed') }
  }

  async setTtl(id: string, key: string, seconds: number): Promise<OperationResult> {
    const client = this.mustGet(id)
    if (seconds <= 0) {
      await client.persist(key)
      return { ok: true, message: t('connectionManager.setNoExpiration') }
    }
    await client.expire(key, seconds)
    return { ok: true, message: t('connectionManager.ttlSetSecondsS', { seconds }) }
  }

  /**
   * 新建键：先做存在性检查，再复用 setValue 的写入逻辑。
   * 注意 Redis 的容器类型在无元素时不产生实体，因此容器类型必须携带首个元素。
   */
  async createKey(
    id: string,
    key: string,
    type: RedisValueType,
    payload: string | string[] | Record<string, string> = '',
    ttlSeconds?: number,
  ): Promise<OperationResult> {
    const client = this.mustGet(id)
    const name = key.trim()

    if (!name) return { ok: false, message: t('connectionManager.keyNameCannotEmpty') }
    if (await client.exists(name)) return { ok: false, message: t('connectionManager.keyAlreadyExists', { key: name }) }

    if (type !== 'string') {
      const isEmpty =
        type === 'hash'
          ? Object.keys(payload as Record<string, string>).length === 0
          : (payload as string[]).length === 0
      if (isEmpty) return { ok: false, message: t('connectionManager.typeNeedsLeastOneElement', { type }) }
    }

    const result = await this.setValue(id, name, type, payload, ttlSeconds, true)
    return result.ok ? { ok: true, message: t('connectionManager.createdKey', { key: name }) } : result
  }

  // ---------------------------------------------------------------- CLI

  async command(id: string, raw: string): Promise<CliResult> {
    const args = parseCommandLine(raw)
    if (!args.length) return { output: '', costMs: 0 }

    /*
     * 需要整个 managed 而不只是 client：
     * SELECT / SWAPDB 会改变连接所在库，自维护的 managed.db 必须同步，
     * 否则后续 scan 的「是否需要 SELECT」判断会错位 ——
     * CLI 敲 select 2 后，界面切库判断仍以为连接在 db0，键列表全部对不上。
     */
    const managed = this.pool.get(id)
    if (!managed) throw new Error(t('connectionManager.connectionClosedConnectFirst'))
    const client = managed.client

    const started = Date.now()
    try {
      const reply = await (client.call as unknown as (...a: string[]) => Promise<unknown>)(...args)

      const cmd = args[0].toUpperCase()
      let nextDb: number | undefined
      if (cmd === 'SELECT') {
        const target = Number(args[1])
        if (Number.isInteger(target) && target >= 0) nextDb = target
      } else if (cmd === 'SWAPDB') {
        const [a, b] = [Number(args[1]), Number(args[2])]
        if (managed.db === a && Number.isInteger(b)) nextDb = b
        else if (managed.db === b && Number.isInteger(a)) nextDb = a
      }
      if (nextDb !== undefined && nextDb !== managed.db) managed.db = nextDb

      return {
        output: formatReply(reply),
        costMs: Date.now() - started,
        ...(nextDb !== undefined ? { db: managed.db } : {}),
      }
    } catch (error) {
      return { output: '', error: toMessage(error), costMs: Date.now() - started }
    }
  }

  /** 生成连接 ID（新建连接时使用） */
  static newId(): string {
    return randomUUID()
  }
}

export const connectionManager = new ConnectionManager()

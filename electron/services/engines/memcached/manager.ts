import { t } from '@shared/i18n'
import type {
  ConnectionStatus,
  MemcachedConnectionConfig,
  MemcachedConnectionState,
  OperationResult,
} from '../../../../shared/types'
import { closeTunnel, openTunnel, tunnelManager, type Tunnel } from '../../ssh-tunnel'
import { MemcachedError, type MemcachedClient } from './client'
import { MemcachedPool } from './pool'

/**
 * Memcached 模块的连接管理器。
 *
 * 为什么与 Redis 的管理器完全分开（而不是抽一个公共基类再各自实现）：
 *   两者除了"有 host/port、能连能断"之外几乎没有共同点 ——
 *   Redis 有库切换、SSH 隧道、Pub/Sub 独立连接、集群拓扑；
 *   Memcached 有 slab、命中率、cachedump，没有库也没有认证。
 *   强行共用基类会得到一个塞满 if (engine === ...) 的上帝类，
 *   而这正是"两个模块互相影响"的根源。分开之后：
 *     · 各自的 pool 是独立字段，不存在串用；
 *     · 任一模块的改动不会触及另一模块的代码路径；
 *     · 新增第三个引擎只需要再写一个 manager，不用改这里。
 */

export interface MemcachedStatusPayload {
  id: string
  status: ConnectionStatus
  message?: string
}

interface MemcachedKeySnapshot {
  items: Array<{ key: string; bytes: number; expiresAt: number; slab: number }>
  source: 'metadump' | 'cachedump'
  truncated: boolean
  deniedSlabs: number[]
  /** 快照建立时间：翻页期间复用，超过有效期后重建 */
  at: number
}

interface ManagedMemcached {
  config: MemcachedConnectionConfig
  pool: MemcachedPool
  /** 连接建立时的版本，避免每次读面板都再发一次 version */
  version?: string
  /** 服务端是否支持 meta get（1.6+）。探测一次后缓存，避免每次读取都先失败一次 */
  metaTtl?: boolean
  /** 键枚举快照：metadump 一次取全量，分页只切片，写入/删除后失效 */
  keySnapshot?: MemcachedKeySnapshot
}

/** Memcached 把超过 30 天的 exptime 当作绝对时间戳解释 */
const ABSOLUTE_EXPTIME_THRESHOLD = 60 * 60 * 24 * 30

/** 键快照有效期：翻页复用同一份结果；超过后重新枚举 */
const KEY_SNAPSHOT_TTL_MS = 60_000

/** 剩余 TTL（秒，-1 永久）→ 协议 exptime */
function exptimeFromTtl(ttl: number): number {
  if (!Number.isFinite(ttl) || ttl < 0) return 0
  /* 0 表示即将过期；按永久写入会把键"复活"，退化为 1 秒更接近原语义 */
  if (ttl === 0) return 1
  return ttl > ABSOLUTE_EXPTIME_THRESHOLD ? Math.floor(Date.now() / 1000) + ttl : ttl
}

/** Memcached 的错误文案：把协议错误翻译成用户能理解的话 */
function friendlyMessage(error: unknown): string {
  if (error instanceof MemcachedError) {
    switch (error.code) {
      case 'CONNECT_TIMEOUT':
        return t('memcached.connectionTimedOut')
      case 'COMMAND_TIMEOUT':
        return t('memcached.commandTimeoutUnresponsive')
      case 'SOCKET_CLOSED':
        return t('memcached.disconnected')
      case 'SERVER_ERROR':
        return t('memcached.serverError', { message: error.message })
      default:
        return error.message
    }
  }
  return error instanceof Error ? error.message : t('memcached.unknownError')
}

class MemcachedManager {
  /** 连接池，按连接 id 隔离 —— 与 Redis 的 pool 是两个不同的 Map 实例 */
  private pool = new Map<string, ManagedMemcached>()

  private statusListeners = new Set<(payload: MemcachedStatusPayload) => void>()

  onStatusChange(listener: (payload: MemcachedStatusPayload) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private emitStatus(id: string, status: ConnectionStatus, message?: string): void {
    for (const listener of this.statusListeners) listener({ id, status, message })
  }

  /** 记录"这条连接属于 Memcached"，供 IPC 层判断路由 */
  owns(id: string): boolean {
    return this.pool.has(id)
  }

  /**
   * 解析实际要连的地址。
   *
   * 直连时就是配置里的 host:port；启用 SSH 时先建隧道，
   * 再让连接池连本地回环端口 —— 池与上层逻辑完全不感知 SSH。
   * 与 Redis 共用 tunnelManager：隧道按连接 id 隔离，两种引擎互不干扰。
   */
  private async resolveEndpoint(config: MemcachedConnectionConfig): Promise<{ host: string; port: number }> {
    if (!config.sshEnabled || !config.ssh) {
      return { host: config.host, port: config.port }
    }
    return tunnelManager.ensure(config)
  }

  /**
   * 测试连通性，不建立持久连接。
   * 用一条临时连接跑 version + stats，拿得到就说明协议通。
   *
   * SSH 场景必须用一次性独立隧道（与 Redis 的 test 同例）：
   * 走 tunnelManager 会拆掉该连接正在承载流量的共享隧道。
   */
  async test(config: MemcachedConnectionConfig): Promise<OperationResult> {
    let standalone: Tunnel | undefined
    let endpoint: { host: string; port: number }
    try {
      if (config.sshEnabled && config.ssh) {
        standalone = await openTunnel(config)
        endpoint = { host: '127.0.0.1', port: standalone.localPort }
      } else {
        endpoint = { host: config.host, port: config.port }
      }
    } catch (error) {
      return { ok: false, message: friendlyMessage(error) }
    }

    const pool = new MemcachedPool({
      host: endpoint.host,
      port: endpoint.port,
      poolSize: 1,
      connectTimeoutMs: 5000,
    })
    const started = Date.now()
    try {
      await pool.connect()
      const version = await pool.run((client) => client.version())
      const latency = Date.now() - started
      return {
        ok: true,
        message: standalone
          ? t('memcached.connected', { version, latency })
          : t('memcached.connectedMemcachedVersionLatencyMs', { version, latency }),
      }
    } catch (error) {
      return { ok: false, message: friendlyMessage(error) }
    } finally {
      pool.disconnect()
      // 只销毁 test 自己的一次性隧道，不碰共享隧道
      closeTunnel(standalone)
    }
  }

  /** 建立连接。返回的状态对象只包含 Memcached 该有的字段。 */
  async connect(config: MemcachedConnectionConfig): Promise<MemcachedConnectionState> {
    /* 重复连接先清掉旧的，避免同一 id 上挂着两套池与两条隧道 */
    this.disconnect(config.id)

    /*
     * identity 里的 host/port 保留**用户配置的值**（实例的真实地址），
     * 而不是隧道本机端口 —— 列表、状态栏展示的都该是"我在连哪台"。
     */
    const identity = {
      id: config.id,
      name: config.name,
      engine: 'memcached' as const,
      host: config.host,
      port: config.port,
      poolSize: config.poolSize ?? 4,
      sshEnabled: !!(config.sshEnabled && config.ssh),
      sshHost: config.sshEnabled && config.ssh ? config.ssh.host : undefined,
      pinned: config.pinned,
    }

    let endpoint: { host: string; port: number }
    try {
      endpoint = await this.resolveEndpoint(config)
    } catch (error) {
      this.emitStatus(config.id, 'error', friendlyMessage(error))
      return { ...identity, status: 'error', message: friendlyMessage(error) }
    }

    const pool = new MemcachedPool({
      host: endpoint.host,
      port: endpoint.port,
      poolSize: config.poolSize ?? 4,
      connectTimeoutMs: 5000,
    })

    const started = Date.now()
    try {
      await pool.connect()
      const version = await pool.run((client) => client.version())
      const latency = Date.now() - started
      this.pool.set(config.id, { config, pool, version })
      this.emitStatus(config.id, 'connected')
      return { ...identity, status: 'connected', latency, version }
    } catch (error) {
      pool.disconnect()
      /* 握手失败时隧道已经没有价值，立即释放，避免残留跳板机会话 */
      tunnelManager.close(config.id)
      const message = friendlyMessage(error)
      this.emitStatus(config.id, 'error', message)
      return { ...identity, status: 'error', message }
    }
  }

  disconnect(id: string): OperationResult {
    const managed = this.pool.get(id)
    /* 池不在也要收隧道：连接失败重试、只建了隧道没握手成功等路径都可能留下它 */
    tunnelManager.close(id)
    if (!managed) return { ok: true }
    managed.pool.disconnect()
    this.pool.delete(id)
    this.emitStatus(id, 'disconnected')
    return { ok: true }
  }

  disconnectAll(): void {
    for (const [id, managed] of this.pool) {
      managed.pool.disconnect()
      tunnelManager.close(id)
    }
    this.pool.clear()
  }

  isConnected(id: string): boolean {
    return this.pool.has(id)
  }

  /** 取池，未连接时抛错 —— 每个读写接口都要先过这一关 */
  private require(id: string): ManagedMemcached {
    const managed = this.pool.get(id)
    if (!managed) throw new Error(t('memcached.notConnectedMemcachedInstance'))
    return managed
  }

  /* ------------------------------------------------------------------ 统计 */

  /**
   * 全局 stats + items + settings 一次性取回。
   *
   * 三个命令合并成一趟，是因为面板要同时展示"命中率/内存/条目数/连接数"
   * 与"各 slab 分布"；分三次往返会让首屏慢一截，而它们互不依赖。
   * 其中 settings 失败不影响主流程（部分托管服务禁了它）。
   */
  async overview(id: string): Promise<{
    stats: Record<string, string>
    items: Record<string, string>
    settings: Record<string, string>
    version: string
  }> {
    const managed = this.require(id)
    return managed.pool.run(async (client) => {
      const stats = await client.stats()
      const items = await client.stats('items')
      let settings: Record<string, string> = {}
      try {
        settings = await client.stats('settings')
      } catch {
        /* settings 不可读不算失败：面板用它展示"最大内存"等可选项 */
      }
      return { stats, items, settings, version: stats.version ?? managed.version ?? '' }
    })
  }

  /**
   * 按 slab class 列出条目。
   *
   * `stats items` 给的是 `items:<slab>:number` 这类键，
   * 这里聚合成 [{ slab, count }]，供界面决定要 dump 哪些 slab。
   */
  async slabs(id: string): Promise<Array<{ slab: number; count: number; age: number; evicted: number }>> {
    const managed = this.require(id)
    const raw = await managed.pool.run((client) => client.stats('items'))
    const bySlab = new Map<number, { slab: number; count: number; age: number; evicted: number }>()

    for (const [key, value] of Object.entries(raw)) {
      /* 形如 items:3:number / items:3:age / items:3:evicted */
      const match = /^items:(\d+):(.+)$/.exec(key)
      if (!match) continue
      const slab = Number(match[1])
      const field = match[2]!
      const entry = bySlab.get(slab) ?? { slab, count: 0, age: 0, evicted: 0 }
      if (field === 'number') entry.count = Number(value) || 0
      else if (field === 'age') entry.age = Number(value) || 0
      else if (field === 'evicted') entry.evicted = Number(value) || 0
      bySlab.set(slab, entry)
    }

    return [...bySlab.values()].filter((item) => item.count > 0).sort((a, b) => a.slab - b.slab)
  }

  /**
   * 分页列出键。
   *
   * 枚举顺序：
   *   1. `lru_crawler metadump all` —— 覆盖 HOT/WARM/COLD 全部 LRU 分段，
   *      解决 cachedump 漏掉刚写入/常访问键的问题；
   *   2. 旧服务端不支持时回退逐 slab cachedump，并标记 truncated。
   *
   * 一次枚举的结果缓存为快照，翻页只做切片 ——
   * 否则每点一次「加载更多」都要重新全量爬取，大实例上会明显卡顿。
   * 写入/删除/重命名/清空时让快照失效，下一次读取即重建。
   */
  async keys(
    id: string,
    options: { offset?: number; limit?: number; refresh?: boolean } = {},
  ): Promise<{
    items: Array<{ key: string; bytes: number; expiresAt: number; slab: number }>
    total: number
    hasMore: boolean
    nextOffset: number
    source: 'metadump' | 'cachedump'
    truncated: boolean
    deniedSlabs: number[]
  }> {
    const managed = this.require(id)
    const limit = Math.max(1, Math.min(options.limit ?? 200, 5000))
    const offset = Math.max(0, options.offset ?? 0)

    const snapshot = managed.keySnapshot
    if (options.refresh || !snapshot || Date.now() - snapshot.at > KEY_SNAPSHOT_TTL_MS) {
      managed.keySnapshot = await this.buildKeySnapshot(managed)
    }

    const current = managed.keySnapshot!
    const items = current.items.slice(offset, offset + limit)
    const nextOffset = offset + items.length
    const hasMore = nextOffset < current.items.length

    return {
      items,
      total: current.items.length,
      hasMore,
      nextOffset: hasMore ? nextOffset : 0,
      source: current.source,
      truncated: current.truncated,
      deniedSlabs: current.deniedSlabs,
    }
  }

  /** 枚举一份键快照：优先 metadump，旧服务端回退 cachedump */
  private async buildKeySnapshot(managed: ManagedMemcached): Promise<MemcachedKeySnapshot> {
    try {
      const items = await managed.pool.run((client) => client.metadump())
      /* 固定顺序：翻页按 offset 切片，顺序必须稳定 */
      items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      return { items, source: 'metadump', truncated: false, deniedSlabs: [], at: Date.now() }
    } catch (error) {
      /*
       * 只有"服务端不认识/禁用这条命令"才回退；
       * 超时、断线属于真实故障，直接报错比悄悄给一份残缺列表更诚实。
       */
      if (
        !(error instanceof MemcachedError) ||
        (error.code !== 'PROTOCOL_ERROR' && error.code !== 'SERVER_ERROR')
      ) {
        throw error
      }
    }

    const fallback = await this.cachedumpAll(managed, 500, 16)
    fallback.items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return {
      items: fallback.items,
      source: 'cachedump',
      /* cachedump 只覆盖 COLD 分段，本身就意味着结果可能不完整 */
      truncated: true,
      deniedSlabs: fallback.deniedSlabs,
      at: Date.now(),
    }
  }

  /** 回退路径：逐 slab cachedump（带每 slab 上限），部分 slab 被禁用时记录而不整体失败 */
  private async cachedumpAll(
    managed: ManagedMemcached,
    perSlab: number,
    maxSlabs: number,
  ): Promise<{
    items: Array<{ key: string; bytes: number; expiresAt: number; slab: number }>
    deniedSlabs: number[]
  }> {
    const slabList = await this.slabs(managed.config.id)
    const targets = slabList.slice(0, maxSlabs)

    const items: Array<{ key: string; bytes: number; expiresAt: number; slab: number }> = []
    const deniedSlabs: number[] = []

    for (const slab of targets) {
      try {
        const dumped = await managed.pool.run((client) => client.cachedump(slab.slab, perSlab))
        /* 客户端也按上限截断：部分实现/代理会忽略 limit 参数 */
        for (const entry of dumped.slice(0, perSlab)) items.push({ ...entry, slab: slab.slab })
      } catch {
        deniedSlabs.push(slab.slab)
      }
    }

    return { items, deniedSlabs }
  }

  /** 数据变动后让键快照失效，避免刷新时读到旧的枚举结果 */
  private invalidateKeys(managed: ManagedMemcached): void {
    managed.keySnapshot = undefined
  }

  /**
   * 读取键值，并在服务端支持 meta 时顺带取回剩余 TTL。
   * meta 不被支持（老版本/代理）时回退普通 get，只保留值本身。
   */
  private async readOn(
    client: MemcachedClient,
    managed: ManagedMemcached,
    key: string,
  ): Promise<{ data: Buffer; flags: number; ttl?: number } | null> {
    if (managed.metaTtl !== false) {
      try {
        const meta = await client.metaGet(key)
        managed.metaTtl = true
        if (!meta) return null
        return {
          data: meta.data,
          flags: meta.flags,
          ttl: meta.ttl >= -1 ? meta.ttl : undefined,
        }
      } catch (error) {
        if (
          !(error instanceof MemcachedError) ||
          (error.code !== 'PROTOCOL_ERROR' && error.code !== 'SERVER_ERROR')
        ) {
          throw error
        }
        managed.metaTtl = false
      }
    }

    const value = await client.get(key)
    if (!value) return null
    return { data: value.data, flags: value.flags }
  }

  /** 读取单个键的值 */
  async get(
    id: string,
    key: string,
  ): Promise<{ found: boolean; data: string; bytes: number; flags: number; ttl?: number }> {
    const managed = this.require(id)
    const value = await managed.pool.run((client) => this.readOn(client, managed, key))
    if (!value) return { found: false, data: '', bytes: 0, flags: 0 }
    return {
      found: true,
      /* 二进制安全：按 UTF-8 尽力解码，非法字节用替换符，避免界面显示乱码方框 */
      data: value.data.toString('utf8'),
      bytes: value.data.length,
      flags: value.flags,
      ttl: value.ttl,
    }
  }

  /** 写入 / 更新一个键 */
  async set(
    id: string,
    key: string,
    value: string,
    options: {
      exptime?: number
      mode?: 'set' | 'add' | 'replace'
      flags?: number
      ttlSeconds?: number
    } = {},
  ): Promise<OperationResult> {
    const managed = this.require(id)
    const exptime =
      options.ttlSeconds !== undefined ? exptimeFromTtl(options.ttlSeconds) : options.exptime ?? 0
    const stored = await managed.pool.run((client) =>
      client.store(options.mode ?? 'set', key, Buffer.from(value, 'utf8'), {
        flags: options.flags ?? 0,
        exptime,
      }),
    )
    if (!stored) {
      return {
        ok: false,
        message:
          options.mode === 'add'
            ? t('memcached.keyAlreadyExistsNothingWritten')
            : options.mode === 'replace'
              ? t('memcached.keyNotExistNothingWritten')
              : t('memcached.serverNotConfirmWrite'),
      }
    }
    this.invalidateKeys(managed)
    return { ok: true, message: t('common.saved') }
  }

  /**
   * 重命名键。
   *
   * Memcached 没有 RENAME 命令，这里用「读取 → 写入新键 → 删除旧键」组合实现：
   *   · 用 add 写入新键，目标已存在时拒绝，绝不静默覆盖（与 Redis 模块同语义）；
   *   · 保留原 flags；
   *   · 服务端支持 meta 时保留剩余 TTL，否则如实告知新键将变为永久；
   *   · 删除旧键失败时回滚新键，避免出现两份数据。
   *
   * 组合操作不是原子的：并发写入同名键仍可能产生竞态，
   * 但 add 保证了最坏情况是"重命名失败"，不会覆盖已有数据。
   */
  async rename(id: string, key: string, newKey: string): Promise<OperationResult> {
    const managed = this.require(id)
    const target = newKey.trim()
    if (!target) throw new Error(t('memcached.newKeyNameCannotEmpty'))
    if (/[\s\u0000-\u001f]/.test(target)) {
      throw new Error(t('memcachedKeyDialog.keyNamesCannotContainSpaces'))
    }
    if (target === key) return { ok: true, message: t('memcached.keyNameUnchanged') }

    return managed.pool.run(async (client) => {
      if (await client.get(target)) {
        throw new Error(t('connectionManager.targetKeyAlreadyExists', { key: target }))
      }

      const source = await this.readOn(client, managed, key)
      if (!source) throw new Error(t('memcachedKeyBrowser.keyExpiredDeleted'))

      const stored = await client.store('add', target, source.data, {
        flags: source.flags,
        exptime: source.ttl !== undefined ? exptimeFromTtl(source.ttl) : 0,
      })
      if (!stored) throw new Error(t('memcached.failedWriteTargetKeyAlready', { key: target }))

      const deleted = await client.delete(key)
      if (!deleted) {
        /* 旧键在读取后被删除：撤销新键，避免留下"幽灵副本" */
        await client.delete(target)
        throw new Error(t('memcached.oldKeyNoLongerExists'))
      }

      this.invalidateKeys(managed)
      return {
        ok: true,
        message:
          source.ttl !== undefined
            ? t('common.renamed')
            : t('memcached.renamed'),
      }
    })
  }

  async remove(id: string, key: string): Promise<OperationResult> {
    const managed = this.require(id)
    const deleted = await managed.pool.run((client) => client.delete(key))
    if (deleted) this.invalidateKeys(managed)
    return deleted
      ? { ok: true, message: t('common.deleted') }
      : { ok: false, message: t('type.keyNotExist') }
  }

  /** 清空全部数据 —— 破坏性操作，调用方必须先确认 */
  async flush(id: string): Promise<OperationResult> {
    const managed = this.require(id)
    await managed.pool.run((client) => client.flushAll())
    this.invalidateKeys(managed)
    return { ok: true, message: t('memcached.allDataCleared') }
  }
}

/** 单例：与 Redis 的 connectionManager 并列存在，互不引用 */
export const memcachedManager = new MemcachedManager()

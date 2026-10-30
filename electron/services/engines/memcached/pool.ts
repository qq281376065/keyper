import { MemcachedClient, MemcachedError, type MemcachedClientOptions } from './client'

/**
 * Memcached 连接池。
 *
 * 为什么需要池：Memcached 服务端是单线程处理命令的，
 * 一条 TCP 连接上的请求是串行往返的 —— 高延迟网络下，
 * 单连接的吞吐会被 RTT 卡死。开多条连接才能并行压满服务端。
 *
 * 分配策略：轮询（round-robin）。
 * 不用"选最闲的"——那需要维护每条连接的待处理计数，
 * 而 Memcached 命令本身极轻（微秒级），轮询已经足够均匀，代码也简单。
 *
 * 故障处理：
 *   · 某条连接发出 SOCKET_CLOSED / TIMEOUT，就把它从可用列表摘掉并重建；
 *   · 重建失败不抛给调用方（那条连接暂时不可用而已），
 *     只有全部连接都不可用时才报错 —— 单点抖动不该让整个面板报错。
 */
export class MemcachedPool {
  private clients: MemcachedClient[] = []
  private cursor = 0
  private closed = false

  constructor(private readonly options: MemcachedClientOptions & { poolSize?: number }) {}

  get size(): number {
    return this.clients.length
  }

  /** 建立全部连接。任一成功即视为池可用；全部失败才抛错。 */
  async connect(): Promise<void> {
    this.closed = false
    const target = Math.max(1, Math.min(32, this.options.poolSize ?? 4))
    this.clients = []

    const results = await Promise.allSettled(
      Array.from({ length: target }, () => {
        const client = new MemcachedClient(this.options)
        this.clients.push(client)
        return client.connect()
      }),
    )

    const firstError = results.find((item): item is PromiseRejectedResult => item.status === 'rejected')
    if (results.every((item) => item.status === 'rejected')) {
      this.clients = []
      const reason = firstError?.reason
      throw reason instanceof Error ? reason : new MemcachedError('SOCKET_CLOSED', '无法建立任何连接')
    }
  }

  /** 关闭全部连接（幂等） */
  disconnect(): void {
    this.closed = true
    for (const client of this.clients) client.disconnect()
    this.clients = []
  }

  /**
   * 取一条可用连接。
   * 已断开的连接会尝试重连一次 —— 服务端重启后不必等用户手动重连。
   */
  private async acquire(): Promise<MemcachedClient> {
    if (this.closed || !this.clients.length) {
      throw new MemcachedError('SOCKET_CLOSED', '连接池未建立')
    }
    const total = this.clients.length
    for (let i = 0; i < total; i++) {
      const client = this.clients[(this.cursor + i) % total]!
      if (client.connected) {
        this.cursor = (this.cursor + i + 1) % total
        return client
      }
      /* 断开的连接就地重连；失败就试下一条 */
      try {
        await client.connect()
        this.cursor = (this.cursor + i + 1) % total
        return client
      } catch {
        /* 继续试下一条 */
      }
    }
    throw new MemcachedError('SOCKET_CLOSED', '所有连接均不可用')
  }

  /**
   * 在池上执行一个操作。
   *
   * 失败重试一次：网络抖动或服务端重启会让某条连接瞬断，
   * 换一条连接重发通常就成功了。只重试一次 —— 再失败说明是服务端问题，
   * 继续重试只会让界面卡更久。
   */
  async run<T>(task: (client: MemcachedClient) => Promise<T>): Promise<T> {
    const client = await this.acquire()
    try {
      return await task(client)
    } catch (error) {
      const transient =
        error instanceof MemcachedError &&
        (error.code === 'SOCKET_CLOSED' || error.code === 'COMMAND_TIMEOUT')
      if (!transient || this.closed) throw error
      const retryClient = await this.acquire()
      return task(retryClient)
    }
  }
}

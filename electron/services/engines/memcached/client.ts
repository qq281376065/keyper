import net from 'node:net'
import { EventEmitter } from 'node:events'
import { t } from '@shared/i18n'

/**
 * Memcached 文本协议客户端（最小实现）。
 *
 * 为什么自己写而不引三方库：
 *   1. 依赖越少，打包链路越稳 —— 本项目 electron-builder 已设 npmRebuild: false，
 *      引入带原生模块的包会直接翻车；memjs 虽是纯 JS，但它自带的
 *      连接池/重试策略与我们的"每连接独立池 + 可观测状态"模型对不上，
 *      套在外面反而更难控制生命周期。
 *   2. 需要的能力很窄：get / set / add / replace / delete / incr / stats /
 *      lru_crawler metadump / flush_all / version / quit。
 *      文本协议足够，SASL 与二进制协议用不到。
 *   3. 需要把"每个命令的原始错误"透出给界面（例如 SERVER_ERROR out of memory），
 *      自己解析才能保住这些细节。
 *
 * 协议要点（文本协议，行以 \r\n 结尾）：
 *   存储类：`set <key> <flags> <exptime> <bytes> [noreply]\r\n<data>\r\n`
 *          响应 `STORED` / `NOT_STORED` / `EXISTS` / `NOT_FOUND` / 错误行
 *   读取类：`get <key>\r\n` → 一行 `VALUE <key> <flags> <bytes>\r\n<data>\r\n` 或 `END`
 *   删除类：`delete <key>\r\n` → `DELETED` / `NOT_FOUND`
 *   统计类：`stats\r\n` → 多行 `STAT <k> <v>\r\n`，以 `END` 结束
 *
 * 设计约束：
 *   · 一个 socket 同时只跑一条命令（用串行队列），不用 pipelining ——
 *     实现简单，且 memcached 单线程处理，pipeline 收益有限；
 *   · 超时、断线、协议错都归一成 MemcachedError，带 code 供上层区分；
 *   · 二进制安全的 value：按 Buffer 收发，不假设 UTF-8。
 */

export type MemcachedErrorCode =
  | 'CONNECT_TIMEOUT'
  | 'COMMAND_TIMEOUT'
  | 'SOCKET_CLOSED'
  | 'PROTOCOL_ERROR'
  | 'SERVER_ERROR'
  | 'NOT_FOUND'

export class MemcachedError extends Error {
  readonly code: MemcachedErrorCode

  constructor(code: MemcachedErrorCode, message: string) {
    super(message)
    this.name = 'MemcachedError'
    this.code = code
  }
}

export interface MemcachedValue {
  key: string
  flags: number
  /** 原始字节，不假设编码 —— 界面侧自行决定怎么呈现 */
  data: Buffer
}

/** meta get 的结果：在普通值之外带上剩余 TTL（-1 永久） */
export interface MemcachedMetaValue {
  data: Buffer
  flags: number
  ttl: number
}

export interface MemcachedClientOptions {
  host: string
  port: number
  /** 建连超时，默认 5s */
  connectTimeoutMs?: number
  /** 单条命令超时，默认 3s。cachedump 之类慢命令由调用方单独放宽 */
  commandTimeoutMs?: number
}

const CRLF = '\r\n'

/** 把 stats 的 `STAT k v` 多行结果解析成对象 */
function parseStats(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of lines) {
    if (!line.startsWith('STAT ')) continue
    const rest = line.slice(5)
    const space = rest.indexOf(' ')
    if (space < 0) continue
    out[rest.slice(0, space)] = rest.slice(space + 1)
  }
  return out
}

/**
 * 单个 Memcached 连接。
 *
 * 生命周期由 MemcachedPool 管理，外部不要直接 new 多个 ——
 * 池负责均衡与故障转移，裸用会绕过这些保障。
 */
export class MemcachedClient extends EventEmitter {
  private socket: net.Socket | null = null
  private buffer = Buffer.alloc(0)
  /** 当前在等响应的命令；同一时刻只有一个（串行队列） */
  private pending: {
    resolve: (value: Buffer) => void
    reject: (error: Error) => void
    /** 判断"响应已收齐"的规则 */
    until: (buffer: Buffer) => number
    timer: NodeJS.Timeout
  } | null = null
  private queue: Array<() => void> = []
  private closed = false

  constructor(private readonly options: MemcachedClientOptions) {
    super()
  }

  get connected(): boolean {
    return !!this.socket && !this.closed
  }

  /** 建立连接。重复调用是幂等的。 */
  async connect(): Promise<void> {
    if (this.connected) return
    this.closed = false

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.options.host, port: this.options.port })
      const timeout = setTimeout(() => {
        socket.destroy()
        reject(
          new MemcachedError(
            'CONNECT_TIMEOUT',
            t('memcached.timedOutConnectingHost', { host: this.options.host, port: this.options.port }),
          ),
        )
      }, this.options.connectTimeoutMs ?? 5000)

      socket.once('connect', () => {
        clearTimeout(timeout)
        socket.setNoDelay(true)
        this.socket = socket
        this.buffer = Buffer.alloc(0)
        resolve()
      })

      socket.once('error', (error) => {
        clearTimeout(timeout)
        reject(new MemcachedError('SOCKET_CLOSED', error.message))
      })

      socket.on('data', (chunk) => this.onData(chunk))

      socket.on('close', () => {
        this.closed = true
        this.failPending(new MemcachedError('SOCKET_CLOSED', t('memcached.connectionClosed')))
        this.emit('close')
      })
    })
  }

  /** 主动断开。不抛错 —— 关闭永远应该成功。 */
  disconnect(): void {
    this.closed = true
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    this.failPending(new MemcachedError('SOCKET_CLOSED', t('memcached.connectionClosedLocally')))
  }

  private failPending(error: Error): void {
    const pending = this.pending
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending = null
    pending.reject(error)
    // 队列里排队的命令直接失败，避免调用方永久挂起
    const queued = this.queue.splice(0)
    for (const start of queued) start()
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const pending = this.pending
    if (!pending) return

    let end: number
    try {
      end = pending.until(this.buffer)
    } catch (error) {
      clearTimeout(pending.timer)
      this.pending = null
      pending.reject(error instanceof Error ? error : new MemcachedError('PROTOCOL_ERROR', t('memcached.parseFailed')))
      this.drainQueue()
      return
    }
    if (end < 0) return

    const payload = this.buffer.subarray(0, end)
    this.buffer = this.buffer.subarray(end)
    clearTimeout(pending.timer)
    this.pending = null
    pending.resolve(payload)
    this.drainQueue()
  }

  private drainQueue(): void {
    /* 队列里的每个 task 自己会去抢 pending 槽位，这里只是唤醒一个 */
    const next = this.queue.shift()
    if (next) next()
  }

  /**
   * 执行一条命令，返回完整响应字节（含末尾 CRLF）。
   *
   * until：告诉解析器"缓冲里到第几个字节算收齐了"（返回长度），
   * 返回 -1 表示还没收齐。每类命令的结束条件不同，
   * 全部放在这一层处理，调用方只关心结果。
   */
  private exec(
    command: Buffer,
    until: (buffer: Buffer) => number,
    timeoutMs?: number,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const run = (): void => {
        if (!this.socket || this.closed) {
          reject(new MemcachedError('SOCKET_CLOSED', t('memcached.notConnected')))
          return
        }
        const limit = timeoutMs ?? this.options.commandTimeoutMs ?? 3000
        const timer = setTimeout(() => {
          this.pending = null
          /*
           * 超时后不能只丢引用 —— 这条连接上的响应流已经错位了，
           * 后续命令会读到上一条的尾巴。直接断开，由池负责重连。
           */
          this.disconnect()
          reject(new MemcachedError('COMMAND_TIMEOUT', t('memcached.commandTimeout', { ms: limit })))
        }, limit)

        this.pending = { resolve, reject, until, timer }
        this.socket.write(command)
      }

      if (this.pending) this.queue.push(run)
      else run()
    })
  }

  /** 找到第一个完整行（含 CRLF），返回该行的结束偏移 */
  private static lineEnd(buffer: Buffer, from = 0): number {
    const idx = buffer.indexOf(CRLF, from, 'latin1')
    return idx < 0 ? -1 : idx + CRLF.length
  }

  /** 直到遇到单独的 `END\r\n` 行为止（stats 与 get 都用它收尾） */
  private static untilEnd(buffer: Buffer): number {
    const marker = Buffer.from(`${CRLF}END${CRLF}`, 'latin1')
    // 响应可能以 END 开头（没有任何 VALUE 行）
    if (buffer.subarray(0, 5).toString('latin1') === `END${CRLF}`) return 5
    const idx = buffer.indexOf(marker, 0, 'latin1')
    return idx < 0 ? -1 : idx + marker.length
  }

  /** 单行响应（STORED / DELETED / OK / 错误） */
  private static untilLine(buffer: Buffer): number {
    return MemcachedClient.lineEnd(buffer)
  }

  /**
   * 直到遇到 `END` 收尾 —— 容忍 metadump 的行尾差异。
   *
   * 真实 memcached 的 `lru_crawler metadump all` 每条记录以 `\n` 结尾，
   * 最后才是一个 `END\r\n`（实测 1.6.21 就是这样）；普通 stats 则是 `\r\n`。
   * 若沿用只认 `\r\nEND\r\n` 的 untilEnd，metadump 会一直等到超时。
   */
  private static untilEndLoose(buffer: Buffer): number {
    if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === `END${CRLF}`) return 5
    if (buffer.length >= 4 && buffer.subarray(0, 4).toString('latin1') === `END\n`) return 4

    let end = -1
    for (const marker of [Buffer.from(`\nEND${CRLF}`, 'latin1'), Buffer.from(`\nEND\n`, 'latin1')]) {
      const idx = buffer.indexOf(marker)
      if (idx < 0) continue
      const candidate = idx + marker.length
      if (end < 0 || candidate < end) end = candidate
    }
    return end
  }

  /** 把单行响应转成字符串并检查是否为错误行 */
  private readLine(buffer: Buffer): string {
    const text = buffer.toString('utf8').replace(/\r\n$/, '')
    if (text.startsWith('ERROR')) {
      throw new MemcachedError('PROTOCOL_ERROR', t('memcached.serverNotRecognizeCommand'))
    }
    if (text.startsWith('CLIENT_ERROR')) {
      throw new MemcachedError('PROTOCOL_ERROR', text.slice('CLIENT_ERROR '.length) || text)
    }
    if (text.startsWith('SERVER_ERROR')) {
      throw new MemcachedError('SERVER_ERROR', text.slice('SERVER_ERROR '.length) || text)
    }
    return text
  }

  /** `version` —— 同时用作健康检查与握手 */
  async version(): Promise<string> {
    const raw = await this.exec(Buffer.from(`version${CRLF}`, 'latin1'), MemcachedClient.untilLine)
    const text = this.readLine(raw)
    return text.startsWith('VERSION ') ? text.slice(8) : text
  }

  /**
   * 读取一个键。
   *
   * 响应形态：
   *   `VALUE <key> <flags> <bytes>\r\n<data>\r\nEND\r\n`   命中
   *   `END\r\n`                                            未命中
   */
  async get(key: string): Promise<MemcachedValue | null> {
    const raw = await this.exec(
      Buffer.from(`get ${key}${CRLF}`, 'utf8'),
      MemcachedClient.untilEnd,
    )
    const text = raw.toString('latin1')
    if (text.startsWith(`END${CRLF}`)) return null

    /* 头行：VALUE <key> <flags> <bytes> */
    const headerEnd = text.indexOf(CRLF)
    if (headerEnd < 0) throw new MemcachedError('PROTOCOL_ERROR', t('memcached.incompleteValueLine'))
    const header = text.slice(0, headerEnd)
    if (!header.startsWith('VALUE ')) {
      this.readLine(raw)
      throw new MemcachedError(
        'PROTOCOL_ERROR',
        t('memcached.unrecognizedResponse', { preview: header.slice(0, 40) }),
      )
    }
    const parts = header.split(' ')
    const flags = Number(parts[2] ?? 0) || 0
    const bytes = Number(parts[3] ?? 0) || 0

    /* data 紧跟在头行之后，长度精确为 bytes（避免把 \r\n 算进值里） */
    const dataStart = headerEnd + CRLF.length
    return { key, flags, data: raw.subarray(dataStart, dataStart + bytes) }
  }

  /**
   * 读取键值并顺带取回剩余 TTL（meta get，Memcached 1.6+）。
   *
   * 协议：`mg <key> v f t\r\n`
   *   命中：`VA <size> f<flags> t<ttl>\r\n<data>\r\n`
   *   未命中：`EN\r\n`
   * 老版本/代理会直接回 ERROR —— 由上层捕获后回退普通 get。
   */
  async metaGet(key: string): Promise<MemcachedMetaValue | null> {
    const raw = await this.exec(
      Buffer.from(`mg ${key} v f t${CRLF}`, 'utf8'),
      (buffer) => {
        const head = buffer.subarray(0, Math.min(buffer.length, 24)).toString('latin1')
        if (head.startsWith('ERROR') || head.startsWith('CLIENT_ERROR') || head.startsWith('SERVER_ERROR')) {
          return MemcachedClient.lineEnd(buffer)
        }
        if (head.startsWith(`EN${CRLF}`) || head.startsWith(`NF${CRLF}`)) return 4
        const headerEnd = MemcachedClient.lineEnd(buffer)
        if (headerEnd < 0) return -1
        const header = buffer.subarray(0, headerEnd - CRLF.length).toString('latin1')
        if (!header.startsWith('VA ')) return headerEnd
        const size = Number(header.split(' ')[1] ?? 0) || 0
        return headerEnd + size + CRLF.length
      },
    )

    const text = raw.toString('latin1')
    if (text.startsWith(`EN${CRLF}`) || text.startsWith(`NF${CRLF}`)) return null

    const headerEnd = text.indexOf(CRLF)
    if (headerEnd < 0) throw new MemcachedError('PROTOCOL_ERROR', t('memcached.incompleteVaLine'))
    const header = text.slice(0, headerEnd)
    if (!header.startsWith('VA ')) {
      this.readLine(raw)
      throw new MemcachedError(
        'PROTOCOL_ERROR',
        t('memcached.unrecognizedMetaResponse', { preview: header.slice(0, 40) }),
      )
    }

    const parts = header.split(' ')
    const bytes = Number(parts[1] ?? 0) || 0
    let flags = 0
    let ttl = -2
    for (const token of parts.slice(2)) {
      if (token.startsWith('f')) flags = Number(token.slice(1)) || 0
      else if (token.startsWith('t')) {
        const parsed = Number(token.slice(1))
        if (Number.isFinite(parsed)) ttl = parsed
      }
    }

    const dataStart = headerEnd + CRLF.length
    return { data: raw.subarray(dataStart, dataStart + bytes), flags, ttl }
  }

  /**
   * 写入一个键。
   *
   * mode：
   *   set     无条件覆盖
   *   add     仅当键不存在时写入
   *   replace 仅当键已存在时写入
   * exptime：0 表示永不过期；>0 为秒；>30 天的值按绝对时间戳解释（协议规定）
   */
  async store(
    mode: 'set' | 'add' | 'replace',
    key: string,
    value: Buffer,
    options: { flags?: number; exptime?: number } = {},
  ): Promise<boolean> {
    const flags = options.flags ?? 0
    const exptime = options.exptime ?? 0
    const head = Buffer.from(`${mode} ${key} ${flags} ${exptime} ${value.length}${CRLF}`, 'utf8')
    const command = Buffer.concat([head, value, Buffer.from(CRLF, 'latin1')])
    const raw = await this.exec(command, MemcachedClient.untilLine)
    const text = this.readLine(raw)
    return text === 'STORED'
  }

  /** 删除；键不存在返回 false（不是错误） */
  async delete(key: string): Promise<boolean> {
    const raw = await this.exec(Buffer.from(`delete ${key}${CRLF}`, 'utf8'), MemcachedClient.untilLine)
    const text = this.readLine(raw)
    return text === 'DELETED'
  }

  /** 更新过期时间；键不存在返回 false */
  async touch(key: string, exptime: number): Promise<boolean> {
    const raw = await this.exec(
      Buffer.from(`touch ${key} ${exptime}${CRLF}`, 'utf8'),
      MemcachedClient.untilLine,
    )
    return this.readLine(raw) === 'TOUCHED'
  }

  /** 自增 / 自减。键不存在时抛 NOT_FOUND —— 与协议一致，由上层决定是否提示 */
  async incr(key: string, delta: number, mode: 'incr' | 'decr' = 'incr'): Promise<number> {
    const raw = await this.exec(
      Buffer.from(`${mode} ${key} ${delta}${CRLF}`, 'utf8'),
      MemcachedClient.untilLine,
    )
    const text = this.readLine(raw)
    if (text === 'NOT_FOUND') throw new MemcachedError('NOT_FOUND', t('memcached.keyNotExist', { key }))
    const value = Number(text)
    if (!Number.isFinite(value)) {
      throw new MemcachedError('PROTOCOL_ERROR', t('memcached.unexpectedNumericResponse', { response: text }))
    }
    return value
  }

  /** 清空全部数据（flush_all） */
  async flushAll(delaySeconds = 0): Promise<void> {
    const command = delaySeconds > 0 ? `flush_all ${delaySeconds}${CRLF}` : `flush_all${CRLF}`
    const raw = await this.exec(Buffer.from(command, 'latin1'), MemcachedClient.untilLine)
    this.readLine(raw)
  }

  /**
   * 读取统计。
   * 不带参数 → 全局 stats；带参数 → stats items / stats settings / stats slabs。
   */
  async stats(arg?: string, timeoutMs?: number): Promise<Record<string, string>> {
    const command = arg ? `stats ${arg}${CRLF}` : `stats${CRLF}`
    const raw = await this.exec(Buffer.from(command, 'utf8'), MemcachedClient.untilEnd, timeoutMs)
    const lines = raw
      .toString('utf8')
      .split(CRLF)
      .filter((line) => line.length > 0 && line !== 'END')
    return parseStats(lines)
  }

  /**
   * `lru_crawler metadump all` —— 枚举实例中的**全部**缓存项。
   *
   * 为什么必须用它而不是 cachedump：
   *   cachedump 只遍历 COLD 分段，刚写入或最近访问过的键留在 HOT/WARM 段里，
   *   结果就是"库里明明有这个键，键栏里却没有"（真实案例：group:yufei:2030）。
   *   metadump 走完整条 LRU 链，三个分段都能覆盖，也不受 slab 上限影响。
   *
   * 代价与限制：
   *   · 大实例上输出行数多、耗时长，因此单独放宽超时；
   *   · 1.4.31 以下或禁用 lru_crawler 的服务端会回 ERROR / CLIENT_ERROR，
   *     由上层回退 cachedump 并如实提示；
   *   · 爬取期间并发写入的键仍可能漏掉，但不会再整段丢失。
   *
   * 行格式：
   *   `key=<urlencoded> exp=<绝对时间戳|-1> la=<n> cas=<n> fetch=<yes|no> cls=<n> size=<n>`
   *   `END`
   * 返回：`[{ key, bytes, expiresAt, slab }]`，expiresAt 为 0 表示永不过期。
   */
  async metadump(
    timeoutMs = 20000,
  ): Promise<Array<{ key: string; bytes: number; expiresAt: number; slab: number }>> {
    const raw = await this.exec(
      Buffer.from(`lru_crawler metadump all${CRLF}`, 'latin1'),
      (buffer) => {
        /*
         * 与 cachedump 同理：被禁用 / 版本不支持 / 已有爬取任务在跑时，
         * 服务端可能只回一行错误（ERROR / CLIENT_ERROR / SERVER_ERROR / BUSY），
         * 不跟 END。若仍等 END 会一直挂到超时。
         */
        const head = buffer.subarray(0, Math.min(buffer.length, 32)).toString('latin1')
        if (
          head.startsWith('ERROR') ||
          head.startsWith('CLIENT_ERROR') ||
          head.startsWith('SERVER_ERROR') ||
          head.startsWith('BUSY')
        ) {
          return MemcachedClient.lineEnd(buffer)
        }
        return MemcachedClient.untilEndLoose(buffer)
      },
      timeoutMs,
    )

    const text = raw.toString('utf8')
    /* metadump 每行以 \n 结尾（见 untilEndLoose），不能只按 \r\n 切分 */
    const lines = text.split(/\r?\n/)
    const firstLine = lines[0] ?? ''
    if (/^(ERROR|CLIENT_ERROR|SERVER_ERROR|BUSY)/.test(firstLine)) {
      /*
       * 统一抛 SERVER_ERROR：上层据此判断"服务端不支持 metadump"并回退，
       * 而不是把原始协议行直接甩给用户。
       */
      throw new MemcachedError(
        'SERVER_ERROR',
        firstLine.replace(/^(CLIENT_ERROR|SERVER_ERROR|ERROR)\s*/, '') || firstLine,
      )
    }

    const out: Array<{ key: string; bytes: number; expiresAt: number; slab: number }> = []
    for (const line of lines) {
      /* 每行以 key= 开头；END 行自然被跳过 */
      if (!line.startsWith('key=')) continue
      let key = ''
      let bytes = 0
      let expiresAt = 0
      let slab = 0
      for (const token of line.split(' ')) {
        const eq = token.indexOf('=')
        if (eq <= 0) continue
        const name = token.slice(0, eq)
        const value = token.slice(eq + 1)
        if (name === 'key') {
          /* metadump 对键名做 URL 编码（冒号会变成 %3A），必须还原后才能命中 */
          try {
            key = decodeURIComponent(value)
          } catch {
            key = value
          }
        } else if (name === 'exp') {
          /* exp 是绝对 Unix 时间戳；-1 表示永不过期 */
          const exp = Number(value)
          expiresAt = Number.isFinite(exp) && exp > 0 ? exp : 0
        } else if (name === 'size') {
          bytes = Number(value) || 0
        } else if (name === 'cls') {
          slab = Number(value) || 0
        }
      }
      if (key) out.push({ key, bytes, expiresAt, slab })
    }
    return out
  }

  /**
   * `stats cachedump <slab> <limit>` —— 列出某个 slab class 里的键。
   *
   * ⚠️ 这是调试命令，不是稳定 API，而且**只遍历 COLD 分段**：
   *   刚写入 / 最近访问的键在 HOT/WARM 段，cachedump 看不到 ——
   *   它只作为 metadump 不可用时的回退，且上层必须标注"结果可能不完整"。
   * 其他限制：
   *   · 部分发行版/托管服务会禁用（返回 CLIENT_ERROR）；
   *   · 大实例上可能很慢，因此 limit 必须给（0 表示不限，绝对不要用 0）；
   *   · 结果不一定完整（内部哈希遍历，且并发写入会导致遗漏）。
   *
   * 返回：`[{ key, bytes, expiresAt }]`，expiresAt 为 0 表示永不过期。
   */
  async cachedump(
    slab: number,
    limit = 500,
  ): Promise<Array<{ key: string; bytes: number; expiresAt: number }>> {
    const raw = await this.exec(
      Buffer.from(`stats cachedump ${slab} ${limit}${CRLF}`, 'utf8'),
      /*
       * 结束条件比普通 stats 宽松：缓存条目为空、被禁用、或参数非法时，
       * 服务端可能只回一行 CLIENT_ERROR / ERROR，**不跟 END**。
       * 若仍按 untilEnd 等 END，这条命令会一直挂到超时 ——
       * 实测就是这么卡住的（被禁用的实例上，面板转圈 15 秒才报错）。
       * 因此这里三种收尾都算完整：END 行、单行错误、任意完整行。
       */
      (buffer) => {
        const head = buffer.subarray(0, Math.min(buffer.length, 24)).toString('latin1')
        if (head.startsWith('CLIENT_ERROR') || head.startsWith('ERROR')) {
          return MemcachedClient.lineEnd(buffer)
        }
        /* 头行是 SERVER_ERROR 也一样（个别版本会这样回） */
        if (head.startsWith('SERVER_ERROR')) return MemcachedClient.lineEnd(buffer)
        return MemcachedClient.untilEnd(buffer)
      },
      /* 单独放宽超时：cachedump 在条目多的 slab 上明显比普通命令慢 */
      15000,
    )
    const text = raw.toString('utf8')
    /* 被禁用时会先回一行 CLIENT_ERROR / ERROR */
    const firstLine = text.split(CRLF)[0] ?? ''
    if (firstLine.startsWith('CLIENT_ERROR') || firstLine.startsWith('ERROR')) {
      throw new MemcachedError('SERVER_ERROR', firstLine.replace(/^(CLIENT_ERROR|ERROR)\s*/, '') || firstLine)
    }

    /*
     * 行格式：`ITEM <key> [<bytes> b; <expiresAt> s]`
     * 方括号在旧版本里可能缺失，因此按"尽力解析"处理：
     * 拿不到字节数就记 0，不因此丢弃整条记录。
     */
    const out: Array<{ key: string; bytes: number; expiresAt: number }> = []
    for (const line of text.split(CRLF)) {
      if (!line.startsWith('ITEM ')) continue
      const match = /^ITEM (\S+)(?:\s+\[(\d+) b; (\d+) s\])?/.exec(line)
      if (!match) continue
      out.push({
        key: match[1]!,
        bytes: Number(match[2] ?? 0) || 0,
        expiresAt: Number(match[3] ?? 0) || 0,
      })
    }
    return out
  }
}

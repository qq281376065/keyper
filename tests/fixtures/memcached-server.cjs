/**
 * 极简 Memcached 文本协议服务端 —— 仅用于本地集成测试。
 *
 * 为什么需要它：验证客户端不能只靠"看起来对"。
 * 真实 memcached 镜像拉不下来时，用一个按协议实现的假服务端
 * 才能覆盖这些关键路径：
 *   · 多行响应（stats / cachedump / metadump）与单行响应（STORED / DELETED）的边界
 *   · 二进制安全的 value（含 \r\n 的值不能被截断）
 *   · 未命中（END）、错误行（SERVER_ERROR）的处理
 *   · 连接被服务端主动断开后的重连
 *   · 分段 LRU：cachedump 只返回部分键（hideFromCachedump 模拟 HOT/WARM 段）
 *
 * 它不实现完整协议（没有 slab 计算、没有 LRU 淘汰），
 * 只保证"客户端发出什么、收到什么"与真机一致。
 */
const net = require('node:net')

const CRLF = '\r\n'

function createServer(options = {}) {
  const store = new Map() // key -> { flags, data, expiresAt }
  /*
   * 字段集对齐真实 memcached 的 stats 输出（常用子集）。
   * 少给字段会让"界面读不到值就显示 —"这种问题在测试里隐形。
   */
  const stats = {
    cmd_get: 0,
    cmd_set: 0,
    cmd_flush: 0,
    get_hits: 0,
    get_misses: 0,
    curr_items: 0,
    total_items: 0,
    evictions: 0,
    curr_connections: 7,
    total_connections: 42,
    bytes: 0,
    limit_maxbytes: 67108864,
    expired_unfetched: 0,
    evicted_unfetched: 0,
  }
  /** 记录收到的命令，便于断言 */
  const received = []
  /** 当前活动连接，close 时强制断开（见 return.close） */
  const sockets = new Set()

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = Buffer.alloc(0)

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      drain()
    })

    function drain() {
      for (;;) {
        const lineEnd = buffer.indexOf(CRLF)
        if (lineEnd < 0) return
        const line = buffer.subarray(0, lineEnd).toString('utf8')
        const parts = line.split(' ')
        const cmd = parts[0]
        received.push(line)

        // 存储类命令需要先读数据块
        if (cmd === 'set' || cmd === 'add' || cmd === 'replace') {
          const bytes = Number(parts[4] ?? 0)
          const total = lineEnd + CRLF.length + bytes + CRLF.length
          if (buffer.length < total) return
          const data = buffer.subarray(lineEnd + CRLF.length, lineEnd + CRLF.length + bytes)
          buffer = buffer.subarray(total)

          const key = parts[1]
          const exists = store.has(key)
          stats.cmd_set++
          if (cmd === 'add' && exists) {
            socket.write(`NOT_STORED${CRLF}`)
            continue
          }
          if (cmd === 'replace' && !exists) {
            socket.write(`NOT_STORED${CRLF}`)
            continue
          }
          const exptime = Number(parts[3] ?? 0)
          /*
           * 协议规定：超过 30 天的 exptime 按绝对 Unix 时间戳解释。
           * 假服务端也要遵守，否则「TTL > 30 天被写成绝对时间」的路径
           * 在测试里根本走不到。
           */
          const expiresAt =
            exptime === 0
              ? 0
              : exptime > 60 * 60 * 24 * 30
                ? exptime * 1000
                : Date.now() + exptime * 1000
          store.set(key, {
            flags: Number(parts[2] ?? 0),
            data: Buffer.from(data),
            expiresAt,
          })
          stats.curr_items = store.size
          stats.total_items++
          socket.write(`STORED${CRLF}`)
          continue
        }

        buffer = buffer.subarray(lineEnd + CRLF.length)

        switch (cmd) {
          case 'version':
            socket.write(`VERSION 1.6.21${CRLF}`)
            break

          case 'get': {
            stats.cmd_get++
            const key = parts[1]
            const hit = store.get(key)
            if (!hit) {
              stats.get_misses++
              socket.write(`END${CRLF}`)
              break
            }
            stats.get_hits++
            socket.write(`VALUE ${key} ${hit.flags} ${hit.data.length}${CRLF}`)
            socket.write(hit.data)
            socket.write(`${CRLF}END${CRLF}`)
            break
          }

          /*
           * meta get（1.6+）：`mg <key> v [f] [t]`。
           * 只需覆盖客户端用到的形态：带 v 返回字节，f/t 附带 flags 与剩余 TTL。
           * 不支持 meta 的旧服务端会对 mg 回 ERROR —— 客户端的回退路径靠这一点验证。
           */
          case 'mg': {
            /* options.disableMeta 用于验证「旧服务端不支持 meta」的回退路径 */
            if (options.disableMeta) {
              socket.write(`ERROR${CRLF}`)
              break
            }
            const key = parts[1]
            const hit = store.get(key)
            if (!hit) {
              socket.write(`EN${CRLF}`)
              break
            }
            const ttl = hit.expiresAt
              ? Math.max(0, Math.ceil((hit.expiresAt - Date.now()) / 1000))
              : -1
            const tokens = []
            if (parts.includes('f')) tokens.push(`f${hit.flags}`)
            if (parts.includes('t')) tokens.push(`t${ttl}`)
            socket.write(`VA ${hit.data.length}${tokens.length ? ` ${tokens.join(' ')}` : ''}${CRLF}`)
            socket.write(hit.data)
            socket.write(CRLF)
            break
          }

          case 'delete': {
            const key = parts[1]
            if (store.delete(key)) {
              stats.curr_items = store.size
              socket.write(`DELETED${CRLF}`)
            } else {
              socket.write(`NOT_FOUND${CRLF}`)
            }
            break
          }

          case 'incr':
          case 'decr': {
            const key = parts[1]
            const hit = store.get(key)
            if (!hit) {
              socket.write(`NOT_FOUND${CRLF}`)
              break
            }
            const current = Number(hit.data.toString('utf8')) || 0
            const delta = Number(parts[2] ?? 1)
            const next = cmd === 'incr' ? current + delta : Math.max(0, current - delta)
            store.set(key, { flags: hit.flags, data: Buffer.from(String(next)), expiresAt: hit.expiresAt })
            socket.write(`${next}${CRLF}`)
            break
          }

          case 'flush_all': {
            store.clear()
            stats.curr_items = 0
            socket.write(`OK${CRLF}`)
            break
          }

          /*
           * lru_crawler metadump all：遍历整条 LRU 链，返回全部缓存项。
           * 键名按协议做 URL 编码；exp 为绝对 Unix 时间戳（-1 = 永久）。
           * options.disableMetadump 用于验证「旧服务端不支持 metadump」的回退路径。
           */
          case 'lru_crawler': {
            if (parts[1] !== 'metadump') {
              socket.write(`ERROR${CRLF}`)
              break
            }
            if (options.disableMetadump) {
              socket.write(`CLIENT_ERROR lru crawler disabled${CRLF}`)
              break
            }
            const nowSeconds = Math.floor(Date.now() / 1000)
            for (const [key, item] of store) {
              const exp = item.expiresAt ? Math.floor(item.expiresAt / 1000) : -1
              /*
               * 与真实 memcached 一致：metadump 的记录行用 \n 结尾，
               * 只有最后的 END 是 \r\n —— 客户端必须能容忍这种混用。
               */
              socket.write(
                `key=${encodeURIComponent(key)} exp=${exp} la=${nowSeconds} cas=1 fetch=no cls=1 size=${item.data.length} flags=${item.flags} \n`,
              )
            }
            socket.write(`END${CRLF}`)
            break
          }

          case 'stats': {
            const sub = parts[1]
            if (!sub) {
              /* curr_items / bytes 随写入实时更新 */
              stats.curr_items = store.size
              stats.bytes = [...store.values()].reduce((sum, item) => sum + item.data.length, 0)
              for (const [k, v] of Object.entries(stats)) socket.write(`STAT ${k} ${v}${CRLF}`)
              socket.write(`STAT uptime 86400${CRLF}`)
              socket.write(`STAT threads 4${CRLF}`)
              socket.write(`STAT version 1.6.21${CRLF}`)
              socket.write(`END${CRLF}`)
              break
            }
            if (sub === 'settings') {
              socket.write(`STAT maxbytes 67108864${CRLF}`)
              socket.write(`STAT maxconns 1024${CRLF}`)
              socket.write(`STAT tcpport 11211${CRLF}`)
              socket.write(`END${CRLF}`)
              break
            }
            if (sub === 'items') {
              if (store.size) {
                socket.write(`STAT items:1:number ${store.size}${CRLF}`)
                socket.write(`STAT items:1:age 120${CRLF}`)
              }
              socket.write(`END${CRLF}`)
              break
            }
            if (sub === 'cachedump') {
              /* options.disableCachedump 用于验证"被禁用"分支 */
              if (options.disableCachedump) {
                socket.write(`CLIENT_ERROR stats cachedump not allowed${CRLF}`)
                break
              }
              /*
               * 真实 cachedump 只遍历 COLD 分段。hideFromCachedump 用来模拟
               * 仍留在 HOT/WARM 段的键（例如刚写入、最近访问过的），
               * 确保「metadump 才能读全」这条回归路径不会在测试里隐形。
               */
              const hidden = options.hideFromCachedump ?? []
              const keys = [...store.keys()].filter((key) => !hidden.includes(key))
              for (const key of keys) {
                const item = store.get(key)
                socket.write(`ITEM ${key} [${item.data.length} b; ${item.expiresAt ? Math.floor(item.expiresAt / 1000) : 0} s]${CRLF}`)
              }
              socket.write(`END${CRLF}`)
              break
            }
            socket.write(`END${CRLF}`)
            break
          }

          case 'quit':
            socket.end()
            break

          default:
            socket.write(`ERROR${CRLF}`)
        }
      }
    }
  })

  return {
    server,
    store,
    stats,
    received,
    listen: (port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port))),
    /*
     * 断言失败会跳过 client.disconnect()，此时连接还挂在 server 上，
     * server.close() 要等所有连接关完才回调 —— afterAll 就这样超时。
     * 测试收尾不需要优雅关闭，先强制断开再关监听。
     */
    close: () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      return new Promise((resolve) => server.close(resolve))
    },
    /** 强制断开所有连接，用于验证重连 */
    dropConnections: () => server._connections === 0,
  }
}

module.exports = { createServer }

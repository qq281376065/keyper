import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { MemcachedClient, MemcachedError } from '../../electron/services/engines/memcached/client'
import { MemcachedPool } from '../../electron/services/engines/memcached/pool'

/*
 * 用真实的 TCP 往返验证协议实现 —— 不是 mock。
 * 服务端是 tests/fixtures/memcached-server.cjs，按文本协议实现，
 * 能覆盖多行响应解析、二进制安全、错误行等真实边界。
 */

const require = createRequire(import.meta.url)
const { createServer } = require('../fixtures/memcached-server.cjs') as {
  createServer: (options?: { disableCachedump?: boolean }) => {
    listen: (port?: number) => Promise<number>
    close: () => Promise<void>
    store: Map<string, { flags: number; data: Buffer; expiresAt: number }>
  }
}

let port = 0
let fixture: ReturnType<typeof createServer>

beforeAll(async () => {
  fixture = createServer()
  port = await fixture.listen()
})

afterAll(async () => {
  await fixture.close()
})

function newClient(): MemcachedClient {
  return new MemcachedClient({ host: '127.0.0.1', port })
}

describe('memcached 客户端 · 基础命令', () => {
  it('version 握手能拿到版本号', async () => {
    const client = newClient()
    await client.connect()
    expect(await client.version()).toBe('1.6.21')
    client.disconnect()
  })

  it('set 后 get 能原样取回', async () => {
    const client = newClient()
    await client.connect()
    expect(await client.store('set', 'k1', Buffer.from('hello'))).toBe(true)
    const value = await client.get('k1')
    expect(value?.data.toString('utf8')).toBe('hello')
    client.disconnect()
  })

  it('未命中的 key 返回 null 而不是报错', async () => {
    const client = newClient()
    await client.connect()
    expect(await client.get('missing-key')).toBeNull()
    client.disconnect()
  })

  it('metaGet 同时返回内容、flags 与剩余 TTL', async () => {
    const client = newClient()
    await client.connect()
    await client.store('set', 'meta:k', Buffer.from('{"a":1}'), { flags: 42, exptime: 600 })
    const meta = await client.metaGet('meta:k')
    expect(meta?.data.toString()).toBe('{"a":1}')
    expect(meta?.flags).toBe(42)
    expect(meta?.ttl).toBeGreaterThan(590)
    expect(meta?.ttl).toBeLessThanOrEqual(600)
    expect(await client.metaGet('meta:missing')).toBeNull()
    client.disconnect()
  })

  it('二进制内容不被截断（含 CRLF 与零字节）', async () => {
    const client = newClient()
    await client.connect()
    const raw = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x41, 0x0d, 0x0a])
    await client.store('set', 'bin', raw)
    const value = await client.get('bin')
    expect(value?.data.equals(raw)).toBe(true)
    client.disconnect()
  })

  it('add 对已存在的键不覆盖，replace 对不存在的键不写入', async () => {
    const client = newClient()
    await client.connect()
    await client.store('set', 'guard', Buffer.from('first'))
    expect(await client.store('add', 'guard', Buffer.from('second'))).toBe(false)
    expect((await client.get('guard'))?.data.toString()).toBe('first')
    expect(await client.store('replace', 'nope', Buffer.from('x'))).toBe(false)
    client.disconnect()
  })

  it('delete 返回是否真的删掉了', async () => {
    const client = newClient()
    await client.connect()
    await client.store('set', 'del-me', Buffer.from('1'))
    expect(await client.delete('del-me')).toBe(true)
    expect(await client.delete('del-me')).toBe(false)
    client.disconnect()
  })

  it('incr / decr 正常计数，缺失键抛 NOT_FOUND', async () => {
    const client = newClient()
    await client.connect()
    await client.store('set', 'counter', Buffer.from('10'))
    expect(await client.incr('counter', 5)).toBe(15)
    expect(await client.incr('counter', 3, 'decr')).toBe(12)

    await expect(client.incr('no-such-counter', 1)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    client.disconnect()
  })
})

describe('memcached 客户端 · 统计与键浏览', () => {
  it('stats 解析多行结果为对象', async () => {
    const client = newClient()
    await client.connect()
    const stats = await client.stats()
    expect(stats.version).toBe('1.6.21')
    expect(Number(stats.threads)).toBe(4)
    expect(stats.uptime).toBe('86400')
    client.disconnect()
  })

  it('cachedump 解析出键、字节数与过期时间', async () => {
    const client = newClient()
    await client.connect()
    await client.store('set', 'dump:a', Buffer.from('12345'), { exptime: 600 })
    const items = await client.cachedump(1, 100)
    const found = items.find((item) => item.key === 'dump:a')
    expect(found).toBeDefined()
    expect(found?.bytes).toBe(5)
    /* 600s 过期 → 服务端回绝对时间戳，这里只验证"有值且在未来" */
    expect(found!.expiresAt).toBeGreaterThan(Date.now() / 1000 - 5)
    client.disconnect()
  })

  it('cachedump 被服务端禁用时抛出可读错误', async () => {
    const disabled = createServer({ disableCachedump: true })
    const p = await disabled.listen()
    const client = new MemcachedClient({ host: '127.0.0.1', port: p })
    await client.connect()
    await expect(client.cachedump(1, 10)).rejects.toBeInstanceOf(MemcachedError)
    client.disconnect()
    await disabled.close()
  })
})

describe('memcached 连接池', () => {
  it('按 poolSize 建立多条连接，命令都能执行', async () => {
    const pool = new MemcachedPool({ host: '127.0.0.1', port, poolSize: 3 })
    await pool.connect()
    expect(pool.size).toBe(3)
    await pool.run((client) => client.store('set', 'pool:key', Buffer.from('ok')))
    const value = await pool.run((client) => client.get('pool:key'))
    expect(value?.data.toString()).toBe('ok')
    pool.disconnect()
  })

  it('池内连接全部建立失败时抛错，而不是静默', async () => {
    const pool = new MemcachedPool({ host: '127.0.0.1', port: 1, poolSize: 2 })
    await expect(pool.connect()).rejects.toBeInstanceOf(Error)
    pool.disconnect()
  })
})

describe('memcached 客户端 · 错误与超时', () => {
  it('连接不存在的主机时报 CONNECT_TIMEOUT 或 SOCKET_CLOSED', async () => {
    const client = new MemcachedClient({ host: '127.0.0.1', port: 2, connectTimeoutMs: 500 })
    await expect(client.connect()).rejects.toMatchObject({
      code: expect.stringMatching(/CONNECT_TIMEOUT|SOCKET_CLOSED/),
    })
    client.disconnect()
  })

  it('主动断开后再发命令抛 SOCKET_CLOSED', async () => {
    const client = newClient()
    await client.connect()
    client.disconnect()
    await expect(client.get('any')).rejects.toMatchObject({ code: 'SOCKET_CLOSED' })
  })
})

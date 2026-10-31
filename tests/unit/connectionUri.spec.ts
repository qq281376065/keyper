import { describe, expect, it } from 'vitest'
import {
  MAX_BATCH_URIS,
  extractUriFromText,
  parseConnectionUri,
  parseConnectionUriBatch,
} from '@/utils/connectionUri'

describe('parseConnectionUri', () => {
  it('标准形态：带密码与库号', () => {
    const r = parseConnectionUri('redis://:secret@127.0.0.1:6379/2')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({
      engine: 'redis',
      host: '127.0.0.1',
      port: 6379,
      username: undefined,
      password: 'secret',
      db: 2,
      tls: false,
    })
  })

  it('带用户名（Redis 6+ ACL）', () => {
    const r = parseConnectionUri('redis://admin:pw@db.internal:6380/1')
    expect(r.ok && r.value.username).toBe('admin')
    expect(r.ok && r.value.password).toBe('pw')
  })

  it('rediss:// 映射为 TLS', () => {
    const r = parseConnectionUri('rediss://cache.example.com:6380/0')
    expect(r.ok && r.value.tls).toBe(true)
    expect(r.ok && r.value.port).toBe(6380)
  })

  it('省略端口与库号时取默认值', () => {
    const r = parseConnectionUri('redis://localhost')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.port).toBe(6379)
    expect(r.value.db).toBe(0)
  })

  it('省略协议也接受（日志里常见 host:port）', () => {
    const r = parseConnectionUri('10.0.0.5:6380/3')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.host).toBe('10.0.0.5')
    expect(r.value.port).toBe(6380)
    expect(r.value.db).toBe(3)
  })

  it('清洗外层引号与 export 前缀', () => {
    const r = parseConnectionUri(`export REDIS_URL="redis://:pw@8.8.8.8:6379/0"`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.host).toBe('8.8.8.8')
    expect(r.value.password).toBe('pw')
  })

  it('密码中的转义字符会被还原', () => {
    const r = parseConnectionUri('redis://:p%40ss%3Aword@host:6379/0')
    expect(r.ok && r.value.password).toBe('p@ss:word')
  })

  it('拒绝非 redis 协议', () => {
    const r = parseConnectionUri('http://example.com')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.key).toBe('uri.unsupportedProtocol')
    expect(r.error.params).toEqual({ scheme: 'http' })
  })

  it('拒绝超范围的库号', () => {
    const r = parseConnectionUri('redis://host:6379/99')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.key).toBe('uri.databaseOutOfRange')
    expect(r.error.params).toEqual({ db: 99, max: 15 })
  })

  it('拒绝空输入', () => {
    const r = parseConnectionUri('   ')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.key).toBe('uri.pasteConnectionString')
  })

  it('memcached:// 映射为 Memcached 并取默认端口', () => {
    const r = parseConnectionUri('memcached://cache.internal')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({
      engine: 'memcached',
      host: 'cache.internal',
      port: 11211,
      db: 0,
      tls: false,
    })
  })

  it('memcached 带认证时明确拒绝', () => {
    const r = parseConnectionUri('memcached://user:pw@cache.internal:11211')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.key).toBe('uri.memcachedNoAuth')
  })

  it('memcached 带库号时明确拒绝', () => {
    const r = parseConnectionUri('memcached://cache.internal:11211/2')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.key).toBe('uri.memcachedNoDatabase')
    expect(r.error.params).toEqual({ db: '2' })
  })
})

describe('parseConnectionUriBatch', () => {
  it('跳过空行与 # 注释，保留原始行号', () => {
    const r = parseConnectionUriBatch(
      ['# 生产环境', 'redis://:pw@10.0.0.1:6379/0', '', 'memcached://10.0.0.2:11211'].join('\n'),
    )
    expect(r.total).toBe(2)
    expect(r.valid).toBe(2)
    expect(r.invalid).toBe(0)
    expect(r.entries.map((entry) => entry.line)).toEqual([2, 4])
    expect(r.entries.map((entry) => entry.result.ok && entry.result.value.engine)).toEqual([
      'redis',
      'memcached',
    ])
  })

  it('行内说明文字被截掉', () => {
    const r = parseConnectionUriBatch('redis://10.0.0.1:6379/0   # 主库\n10.0.0.2:6380 备用')
    expect(r.valid).toBe(2)
    const second = r.entries[1]!
    expect(second.result.ok && second.result.value.host).toBe('10.0.0.2')
  })

  it('非法行不中断整批，错误指回对应行', () => {
    const r = parseConnectionUriBatch('redis://10.0.0.1:6379/0\nhttp://example.com\nredis://host/99')
    expect(r.total).toBe(3)
    expect(r.valid).toBe(1)
    expect(r.invalid).toBe(2)
    expect(r.entries[1]!.result.ok).toBe(false)
    expect(r.entries[2]!.result.ok).toBe(false)
  })

  it('超过上限时截断并标记 tooMany', () => {
    const text = Array.from({ length: MAX_BATCH_URIS + 1 }, (_, index) => `10.0.0.${index}:6379`).join('\n')
    const r = parseConnectionUriBatch(text)
    expect(r.total).toBe(MAX_BATCH_URIS)
    expect(r.tooMany).toBe(true)
  })
})

describe('extractUriFromText', () => {
  it('从命令行里取出连接串', () => {
    expect(extractUriFromText('redis-cli -u redis://:pw@1.2.3.4:6379/0 ping')).toBe(
      'redis://:pw@1.2.3.4:6379/0',
    )
  })

  it('没有协议时原样返回，交给解析器报错', () => {
    expect(extractUriFromText('hello world')).toBe('hello world')
  })
})

import { describe, expect, it } from 'vitest'
import { extractUriFromText, parseConnectionUri } from '@/utils/connectionUri'

describe('parseConnectionUri', () => {
  it('标准形态：带密码与库号', () => {
    const r = parseConnectionUri('redis://:secret@127.0.0.1:6379/2')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({
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
    expect(r.error).toContain('不支持')
  })

  it('拒绝超范围的库号', () => {
    const r = parseConnectionUri('redis://host:6379/99')
    expect(r.ok).toBe(false)
  })

  it('拒绝空输入', () => {
    expect(parseConnectionUri('   ').ok).toBe(false)
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

import { describe, expect, it } from 'vitest'
import {
  TRANSFER_FORMAT,
  TRANSFER_VERSION,
  buildExportPayload,
  buildPreviewItems,
  mergeImported,
  parseTransferText,
  validateConnectionEntries,
} from '@shared/connection-transfer'
import type {
  CacheConnectionConfig,
  MemcachedConnectionConfig,
  RedisConnectionConfig,
} from '@shared/types'

function redisConfig(overrides: Partial<RedisConnectionConfig> = {}): RedisConnectionConfig {
  return {
    id: 'c-redis',
    engine: 'redis',
    name: '生产库',
    host: '10.0.0.1',
    port: 6379,
    username: 'admin',
    password: 'secret',
    db: 2,
    tls: true,
    ...overrides,
  }
}

function memcachedConfig(overrides: Partial<MemcachedConnectionConfig> = {}): MemcachedConnectionConfig {
  return {
    id: 'c-mem',
    engine: 'memcached',
    name: '缓存池',
    host: '10.0.0.2',
    port: 11211,
    poolSize: 8,
    ...overrides,
  }
}

function exportJson(
  list: CacheConnectionConfig[],
  includeCredentials: boolean,
): string {
  return JSON.stringify(buildExportPayload(list, { includeCredentials }, '1.0.7').file)
}

describe('buildExportPayload', () => {
  const withSsh = redisConfig({
    pinned: true,
    credentialError: '解密失败',
    ssh: {
      host: 'jump.example.com',
      port: 22,
      username: 'ops',
      authMethod: 'password',
      password: 'jump-pw',
      privateKey: 'PRIVATE-KEY',
      passphrase: 'key-pass',
      hops: [
        {
          host: 'hop.example.com',
          port: 2222,
          username: 'hop-user',
          authMethod: 'key',
          privateKey: 'HOP-KEY',
          passphrase: 'hop-pass',
        },
      ],
    },
    sshEnabled: true,
  })

  it('默认剥掉所有凭据与运行时字段', () => {
    const { file, missingCredentials } = buildExportPayload(
      [withSsh, memcachedConfig()],
      { includeCredentials: false },
      '1.0.7',
    )

    expect(file.format).toBe(TRANSFER_FORMAT)
    expect(file.version).toBe(TRANSFER_VERSION)
    expect(file.includesCredentials).toBe(false)
    expect(file.connections).toHaveLength(2)

    const redis = file.connections[0] as RedisConnectionConfig
    expect(redis.password).toBeUndefined()
    expect(redis.username).toBe('admin')
    expect(redis.db).toBe(2)
    expect(redis.tls).toBe(true)
    expect(redis.ssh).toBeDefined()
    expect(redis.ssh?.password).toBeUndefined()
    expect(redis.ssh?.privateKey).toBeUndefined()
    expect(redis.ssh?.passphrase).toBeUndefined()
    expect(redis.ssh?.hops?.[0]?.privateKey).toBeUndefined()
    expect(redis.ssh?.hops?.[0]?.passphrase).toBeUndefined()
    expect(redis.ssh?.hops?.[0]?.host).toBe('hop.example.com')

    expect('pinned' in redis).toBe(false)
    expect('credentialError' in redis).toBe(false)
    expect(missingCredentials).toBe(1)
  })

  it('显式勾选后保留凭据，但仍不导出运行时字段', () => {
    const { file } = buildExportPayload(
      [withSsh],
      { includeCredentials: true },
      '1.0.7',
    )
    const redis = file.connections[0] as RedisConnectionConfig
    expect(redis.password).toBe('secret')
    expect(redis.ssh?.password).toBe('jump-pw')
    expect(redis.ssh?.privateKey).toBe('PRIVATE-KEY')
    expect(redis.ssh?.hops?.[0]?.privateKey).toBe('HOP-KEY')
    expect('pinned' in redis).toBe(false)
  })

  it('保存但停用的隧道导出为 sshEnabled: false', () => {
    const source = redisConfig({
      ssh: { host: 'jump', port: 22, username: 'ops', authMethod: 'password' },
      sshEnabled: false,
    })
    const { file } = buildExportPayload([source], { includeCredentials: false }, '1.0.7')
    const redis = file.connections[0] as RedisConnectionConfig
    expect(redis.sshEnabled).toBe(false)
    expect(redis.ssh).toBeDefined()
  })

  it('Memcached 不携带 Redis 字段', () => {
    const { file } = buildExportPayload([memcachedConfig()], { includeCredentials: false }, '1.0.7')
    const mem = file.connections[0] as MemcachedConnectionConfig
    expect(mem.engine).toBe('memcached')
    expect(mem.poolSize).toBe(8)
    expect('db' in mem).toBe(false)
    expect('password' in mem).toBe(false)
    expect('tls' in mem).toBe(false)
  })
})

describe('parseTransferText', () => {
  it('接受导出文件并按实际字段判断是否含凭据', () => {
    const plain = parseTransferText(exportJson([redisConfig()], false))
    expect(plain.includesCredentials).toBe(false)
    expect(plain.total).toBe(1)
    expect(plain.issues).toEqual([])
    expect(plain.configs[0]?.engine).toBe('redis')

    const secret = parseTransferText(exportJson([redisConfig()], true))
    expect(secret.includesCredentials).toBe(true)
    expect((secret.configs[0] as RedisConnectionConfig).password).toBe('secret')
  })

  it('解析 Memcached 的 port 与 poolSize', () => {
    const parsed = parseTransferText(exportJson([memcachedConfig()], false))
    const mem = parsed.configs[0] as MemcachedConnectionConfig
    expect(mem.port).toBe(11211)
    expect(mem.poolSize).toBe(8)
  })

  it('拒绝内部裸数组配置文件', () => {
    expect(() => parseTransferText(JSON.stringify([redisConfig()]))).toThrow()
  })

  it('拒绝错误格式与不支持的版本', () => {
    expect(() => parseTransferText('{}')).toThrow()
    expect(() =>
      parseTransferText(
        JSON.stringify({
          format: TRANSFER_FORMAT,
          version: 99,
          connections: [redisConfig()],
        }),
      ),
    ).toThrow()
  })

  it('拒绝空文件与非法 JSON', () => {
    expect(() => parseTransferText('   ')).toThrow()
    expect(() => parseTransferText('{')).toThrow()
  })

  it('条目级错误只记 issue，不中断其余条目', () => {
    const file = {
      format: TRANSFER_FORMAT,
      version: TRANSFER_VERSION,
      includesCredentials: false,
      connections: [
        redisConfig({ id: 'a' }),
        { id: 'b', engine: 'redis', name: '坏端口', host: '10.0.0.3', port: 70000, db: 0 },
        { id: 'c', engine: 'memcached', name: '池太大', host: '10.0.0.4', port: 11211, poolSize: 999 },
        memcachedConfig({ id: 'd' }),
      ],
    }
    const parsed = parseTransferText(JSON.stringify(file))
    expect(parsed.total).toBe(4)
    expect(parsed.configs).toHaveLength(2)
    expect(parsed.issues.map((issue) => issue.index)).toEqual([1, 2])
  })

  it('重复 ID 的第二条记为 issue', () => {
    const file = {
      format: TRANSFER_FORMAT,
      version: TRANSFER_VERSION,
      includesCredentials: false,
      connections: [redisConfig({ id: 'dup' }), memcachedConfig({ id: 'dup' })],
    }
    const parsed = parseTransferText(JSON.stringify(file))
    expect(parsed.configs).toHaveLength(1)
    expect(parsed.issues).toHaveLength(1)
    expect(parsed.issues[0]?.index).toBe(1)
  })
})

describe('validateConnectionEntries', () => {
  it('按字段白名单重建配置，条目级错误不抛异常', () => {
    const { configs, issues } = validateConnectionEntries([
      redisConfig({ id: 'a', pinned: true, credentialError: '解密失败' }),
      { id: 'b', engine: 'redis', name: '坏端口', host: 'h', port: 70000, db: 0 },
    ])

    expect(configs).toHaveLength(1)
    expect(configs[0]?.id).toBe('a')
    expect('pinned' in configs[0]!).toBe(false)
    expect('credentialError' in configs[0]!).toBe(false)
    expect(issues.map((issue) => issue.index)).toEqual([1])
  })

  it('重复 ID 的第二条记为 issue', () => {
    const { configs, issues } = validateConnectionEntries([
      redisConfig({ id: 'dup' }),
      redisConfig({ id: 'dup' }),
    ])
    expect(configs).toHaveLength(1)
    expect(issues).toHaveLength(1)
  })
})

describe('buildPreviewItems', () => {
  const existing = [redisConfig({ id: 'same-id', name: '旧名字' }), memcachedConfig({ id: 'other', name: '缓存池' })]
  const incoming = [
    redisConfig({ id: 'same-id', name: '新名字' }),
    redisConfig({ id: 'new-id', name: '缓存池' }),
    redisConfig({ id: 'fresh', name: '全新' }),
  ]

  it('区分 id 冲突 / 名称冲突 / 新条目', () => {
    const items = buildPreviewItems(incoming, {
      existing,
      isConnected: (id) => id === 'same-id',
    })
    expect(items.map((item) => item.conflict)).toEqual(['id', 'name', 'none'])
    expect(items[0]?.connected).toBe(true)
    expect(items[1]?.connected).toBe(false)
    expect(items[0]?.hasPassword).toBe(true)
  })

  it('Memcached 预览不带 db / 密码字段', () => {
    const items = buildPreviewItems([memcachedConfig()], { existing: [], isConnected: () => false })
    expect(items[0]?.poolSize).toBe(8)
    expect(items[0]?.db).toBeUndefined()
    expect(items[0]?.hasPassword).toBe(false)
  })
})

describe('mergeImported', () => {
  it('默认全部生成新 ID，并按序号去重名称', () => {
    const existing = [redisConfig({ id: 'keep', name: '生产库' })]
    const result = mergeImported(
      existing,
      [redisConfig({ id: 'keep', name: '生产库' })],
      { overwrite: false, connectedIds: new Set() },
    )
    expect(result.summary).toEqual({ imported: 1, overwritten: 0, skipped: 0 })
    expect(result.next).toHaveLength(2)
    expect(result.next[1]?.id).not.toBe('keep')
    expect(result.next[1]?.name).toBe('生产库 (2)')
    // 原数组不被修改
    expect(existing).toHaveLength(1)
  })

  it('按 ID 覆盖时保留原置顶状态', () => {
    const existing = [redisConfig({ id: 'same', name: '旧', pinned: true })]
    const result = mergeImported(
      existing,
      [redisConfig({ id: 'same', name: '新', host: '10.9.9.9' })],
      { overwrite: true, connectedIds: new Set() },
    )
    expect(result.summary).toEqual({ imported: 0, overwritten: 1, skipped: 0 })
    expect(result.next).toHaveLength(1)
    expect(result.next[0]?.host).toBe('10.9.9.9')
    expect(result.next[0]?.pinned).toBe(true)
  })

  it('已连接项在覆盖策略下跳过', () => {
    const existing = [redisConfig({ id: 'live', name: '在线库' })]
    const result = mergeImported(
      existing,
      [redisConfig({ id: 'live', name: '在线库', host: '10.9.9.9' })],
      { overwrite: true, connectedIds: new Set(['live']) },
    )
    expect(result.summary).toEqual({ imported: 0, overwritten: 0, skipped: 1 })
    expect(result.skippedConnected).toEqual(['在线库'])
    expect(result.next[0]?.host).toBe('10.0.0.1')
  })

  it('不覆盖时已连接项照常以新 ID 导入', () => {
    const existing = [redisConfig({ id: 'live', name: '在线库' })]
    const result = mergeImported(
      existing,
      [redisConfig({ id: 'live', name: '在线库', host: '10.9.9.9' })],
      { overwrite: false, connectedIds: new Set(['live']) },
    )
    expect(result.summary).toEqual({ imported: 1, overwritten: 0, skipped: 0 })
    expect(result.next).toHaveLength(2)
  })
})

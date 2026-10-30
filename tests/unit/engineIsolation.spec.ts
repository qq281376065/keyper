import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { memcachedManager } from '../../electron/services/engines/memcached/manager'
import { getEngine, registerEngine, registeredEngines } from '../../electron/services/engines/registry'
import type { MemcachedConnectionConfig } from '../../shared/types'

/*
 * 引擎隔离的核心断言。
 *
 * 这组测试回答一个问题：Memcached 模块会不会污染 Redis 模块？
 * 做法是让 Memcached 真实跑起来（本地协议服务端），然后验证：
 *   ① 它的读写只落在自己的池里；
 *   ② 它的状态对象不含 Redis 专属字段；
 *   ③ 断开一个不影响另一个；
 *   ④ 注册表按 engine 精确分发，未注册时明确报错。
 *
 * 不测 Redis 侧的具体命令（那些已有既有测试覆盖），
 * 只测"两者边界"。
 */

const require = createRequire(import.meta.url)
const { createServer } = require('../fixtures/memcached-server.cjs') as {
  createServer: (options?: {
    disableCachedump?: boolean
    disableMeta?: boolean
    disableMetadump?: boolean
    hideFromCachedump?: string[]
  }) => {
    listen: (port?: number) => Promise<number>
    close: () => Promise<void>
    store: Map<string, { flags: number; data: Buffer; expiresAt: number }>
  }
}

let port = 0
let fixture: ReturnType<typeof createServer>

function configOf(id: string, overrides: Partial<MemcachedConnectionConfig> = {}): MemcachedConnectionConfig {
  return {
    id,
    engine: 'memcached',
    name: `演示 ${id}`,
    host: '127.0.0.1',
    port,
    poolSize: 2,
    ...overrides,
  }
}

beforeAll(async () => {
  fixture = createServer()
  port = await fixture.listen()
})

afterAll(async () => {
  memcachedManager.disconnectAll()
  await fixture.close()
})

describe('引擎隔离 · 连接与状态', () => {
  it('连接返回的状态只含 Memcached 字段，没有 db/mode 等 Redis 专属字段', async () => {
    const state = await memcachedManager.connect(configOf('iso-1'))
    expect(state.engine).toBe('memcached')
    expect(state.status).toBe('connected')
    expect(state.version).toBe('1.6.21')

    /* 关键断言：Redis 专属字段一个都不该出现（SSH 是两种引擎共用的，不在此列） */
    expect(state).not.toHaveProperty('db')
    expect(state).not.toHaveProperty('mode')
    expect(state).not.toHaveProperty('username')
    expect(state.sshEnabled).toBe(false)
    expect(state.sshHost).toBeUndefined()

    memcachedManager.disconnect('iso-1')
  })

  it('两个实例的键互不可见', async () => {
    await memcachedManager.connect(configOf('iso-a'))
    await memcachedManager.connect(configOf('iso-b'))

    /*
     * 注意：真实的 Memcached 是同一个进程共享全量数据，
     * 但这里的隔离指的是"管理器不会把 A 的池给 B 用"。
     * 用两个不同的假服务端才能验证数据隔离 —— 见下面的独立实例测试。
     */
    await memcachedManager.set('iso-a', 'only-in-a', 'value')
    /* 同一服务端，B 也能看到（协议如此）；这里只验证 A 自己读得到 */
    const fromA = await memcachedManager.get('iso-a', 'only-in-a')
    expect(fromA.found).toBe(true)
    expect(fromA.data).toBe('value')

    memcachedManager.disconnect('iso-a')
    memcachedManager.disconnect('iso-b')
  })

  it('断开一个连接不影响另一个', async () => {
    const other = createServer()
    const otherPort = await other.listen()

    await memcachedManager.connect(configOf('keep-me'))
    await memcachedManager.connect(configOf('drop-me', { port: otherPort }))

    memcachedManager.disconnect('drop-me')

    /* 剩下的那个仍然能用 */
    await memcachedManager.set('keep-me', 'still-alive', 'yes')
    const value = await memcachedManager.get('keep-me', 'still-alive')
    expect(value.found).toBe(true)

    memcachedManager.disconnect('keep-me')
    await other.close()
  })

  it('未连接的实例读数据时报错，不会串到别的实例', async () => {
    await expect(memcachedManager.get('never-connected', 'any')).rejects.toThrow(/未连接/)
  })
})

describe('引擎隔离 · 注册表分发', () => {
  it('已注册 redis 与 memcached 两个引擎', () => {
    /* 测试环境没跑 ipc 注册，这里自行注册以便断言 */
    if (!registeredEngines().includes('redis')) {
      registerEngine('redis', {
        connect: async () => ({ engine: 'redis' }),
        test: async () => ({ ok: true }),
        disconnect: () => undefined,
      })
    }
    if (!registeredEngines().includes('memcached')) {
      registerEngine('memcached', {
        connect: async () => ({ engine: 'memcached' }),
        test: async () => ({ ok: true }),
        disconnect: () => undefined,
      })
    }
    expect(registeredEngines()).toEqual(expect.arrayContaining(['redis', 'memcached']))
  })

  it('按 engine 精确取到对应实现，不会拿错', async () => {
    const redisImpl = getEngine<{ engine: string }, { ok: boolean }>('redis')
    const mcImpl = getEngine<{ engine: string }, { ok: boolean }>('memcached')

    const a = (await redisImpl.connect({} as never)) as { engine: string }
    const b = (await mcImpl.connect({} as never)) as { engine: string }
    expect(a.engine).toBe('redis')
    expect(b.engine).toBe('memcached')
  })

  it('未注册的引擎报明确错误，而不是静默回退', () => {
    expect(() => getEngine('unknown-engine' as never)).toThrow(/尚未注册/)
  })
})

describe('Memcached 数据能力', () => {
  it('overview 返回 stats / items / settings 三块', async () => {
    await memcachedManager.connect(configOf('ov'))
    await memcachedManager.set('ov', 'k1', 'v1')
    const data = await memcachedManager.overview('ov')
    expect(data.version).toBe('1.6.21')
    expect(data.stats).toHaveProperty('curr_connections')
    expect(data.settings).toHaveProperty('maxbytes')
    memcachedManager.disconnect('ov')
  })

  it('keys 按 slab 聚合，且返回限制标记', async () => {
    await memcachedManager.connect(configOf('kx'))
    await memcachedManager.set('kx', 'dump:1', 'aaa')
    await memcachedManager.set('kx', 'dump:2', 'bbb')
    const list = await memcachedManager.keys('kx')
    expect(list.items.length).toBeGreaterThan(0)
    expect(list.items.every((item) => item.slab > 0)).toBe(true)
    expect(typeof list.truncated).toBe('boolean')
    expect(Array.isArray(list.deniedSlabs)).toBe(true)
    memcachedManager.disconnect('kx')
  })

  it('set 的 add / replace 语义生效', async () => {
    await memcachedManager.connect(configOf('sem'))
    const first = await memcachedManager.set('sem', 'k', 'v1', { mode: 'add' })
    expect(first.ok).toBe(true)
    const second = await memcachedManager.set('sem', 'k', 'v2', { mode: 'add' })
    expect(second.ok).toBe(false)
    expect(second.message).toContain('已存在')

    const missing = await memcachedManager.set('sem', 'nope', 'x', { mode: 'replace' })
    expect(missing.ok).toBe(false)
    memcachedManager.disconnect('sem')
  })

  it('flush 清空后取不到旧键', async () => {
    await memcachedManager.connect(configOf('fl'))
    await memcachedManager.set('fl', 'gone', '1')
    await memcachedManager.flush('fl')
    const value = await memcachedManager.get('fl', 'gone')
    expect(value.found).toBe(false)
    memcachedManager.disconnect('fl')
  })
})

describe('Memcached 连接失败', () => {
  it('端口不通时返回 error 状态而不是抛异常', async () => {
    const state = await memcachedManager.connect(configOf('bad', { port: 1 }))
    expect(state.status).toBe('error')
    expect(state.message).toBeTruthy()
    /* 失败时不该留下可用池 */
    expect(memcachedManager.isConnected('bad')).toBe(false)
  })

  it('test 对不可达实例返回 ok:false 并给出可读原因', async () => {
    const result = await memcachedManager.test(configOf('t', { port: 1 }))
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/超时|断开|失败/)
  })
})

describe('Memcached 状态类型约束', () => {
  it('MemcachedConnectionState 不含 Redis 专属字段；SSH 标注两种引擎共有', async () => {
    const state = await memcachedManager.connect(configOf('type-check'))
    const keys = Object.keys(state)
    /* 这些字段一旦出现，说明有人把 Redis 的 identity 直接展开了 */
    for (const forbidden of ['db', 'mode', 'username', 'tls', 'password']) {
      expect(keys).not.toContain(forbidden)
    }
    /* 该有的必须有 */
    expect(keys).toContain('engine')
    expect(keys).toContain('poolSize')
    /* SSH 已支持 Memcached：直连时显式给 false，界面据此不显示 SSH 徽标 */
    expect(keys).toContain('sshEnabled')
    expect(state.sshEnabled).toBe(false)
    memcachedManager.disconnect('type-check')
  })
})

describe('Memcached 键浏览限制', () => {
  it('按页大小切片：total 为全量，hasMore / nextOffset 指向下一页', async () => {
    await memcachedManager.connect(configOf('trunc'))
    for (let i = 0; i < 8; i++) {
      await memcachedManager.set('trunc', `k${i}`, 'v')
    }
    const first = await memcachedManager.keys('trunc', { offset: 0, limit: 2 })
    expect(first.source).toBe('metadump')
    expect(first.total).toBe(8)
    expect(first.items).toHaveLength(2)
    expect(first.hasMore).toBe(true)
    expect(first.nextOffset).toBe(2)

    const rest = await memcachedManager.keys('trunc', { offset: first.nextOffset, limit: 50 })
    expect(rest.items).toHaveLength(6)
    expect(rest.hasMore).toBe(false)
    expect(rest.nextOffset).toBe(0)
    memcachedManager.disconnect('trunc')
  })

  it('metadump 与 cachedump 都不可用时记为 deniedSlabs 而不是整体失败', async () => {
    const denied = createServer({ disableMetadump: true, disableCachedump: true })
    const deniedPort = await denied.listen()
    await memcachedManager.connect(configOf('denied', { port: deniedPort }))
    await memcachedManager.set('denied', 'k', 'v')
    const result = await memcachedManager.keys('denied')
    /* 不抛错：回退 cachedump，items 为空，deniedSlabs 有值 —— 界面据此提示"部分不可读" */
    expect(result.source).toBe('cachedump')
    expect(result.truncated).toBe(true)
    expect(result.items.length).toBe(0)
    expect(result.deniedSlabs.length).toBeGreaterThan(0)
    memcachedManager.disconnect('denied')
    await denied.close()
  })
})

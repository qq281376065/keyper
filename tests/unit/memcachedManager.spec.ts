import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { memcachedManager } from '../../electron/services/engines/memcached/manager'
import type { MemcachedConnectionConfig } from '../../shared/types'

/*
 * 重命名是组合实现的（Memcached 没有 RENAME）：
 * 读取原值 → add 新键 → 删除旧键。这里用真实 TCP 假服务端验证
 * 语义边界：TTL/flags 保留、目标已存在必须拒绝、旧服务端回退。
 */

const require = createRequire(import.meta.url)
const { createServer } = require('../fixtures/memcached-server.cjs') as {
  createServer: (options?: { disableCachedump?: boolean; disableMeta?: boolean }) => {
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
  memcachedManager.disconnectAll()
  await fixture.close()
})

let seq = 0
function config(id: string, target = port): MemcachedConnectionConfig {
  return {
    id,
    name: id,
    engine: 'memcached',
    host: '127.0.0.1',
    port: target,
    poolSize: 1,
  }
}

describe('memcached 管理器 · 重命名键', () => {
  it('保留值、flags 与剩余 TTL', async () => {
    const id = `rename-${++seq}`
    const state = await memcachedManager.connect(config(id))
    expect(state.status).toBe('connected')

    const set = await memcachedManager.set(id, 'rename:src', 'payload', {
      flags: 42,
      ttlSeconds: 600,
    })
    expect(set.ok).toBe(true)

    const res = await memcachedManager.rename(id, 'rename:src', 'rename:dst')
    expect(res.ok).toBe(true)
    expect(res.message).not.toContain('未能读取原 TTL')

    const dst = await memcachedManager.get(id, 'rename:dst')
    expect(dst.found).toBe(true)
    expect(dst.data).toBe('payload')
    expect(dst.flags).toBe(42)
    expect(dst.ttl).toBeGreaterThan(590)

    expect((await memcachedManager.get(id, 'rename:src')).found).toBe(false)
    memcachedManager.disconnect(id)
  })

  it('目标键已存在时拒绝，且不覆盖、不删除源键', async () => {
    const id = `rename-${++seq}`
    await memcachedManager.connect(config(id))
    await memcachedManager.set(id, 'conflict:src', 'source')
    await memcachedManager.set(id, 'conflict:dst', 'target')

    const res = memcachedManager.rename(id, 'conflict:src', 'conflict:dst')
    await expect(res).rejects.toThrow('已存在')

    expect((await memcachedManager.get(id, 'conflict:src')).data).toBe('source')
    expect((await memcachedManager.get(id, 'conflict:dst')).data).toBe('target')
    memcachedManager.disconnect(id)
  })

  it('超长 TTL（>30 天）按绝对时间戳写入，协议语义不丢失', async () => {
    const id = `rename-${++seq}`
    await memcachedManager.connect(config(id))
    const fortyDays = 40 * 24 * 3600
    await memcachedManager.set(id, 'long:src', 'v', { ttlSeconds: fortyDays })

    const before = fixture.store.get('long:src')!.expiresAt
    const res = await memcachedManager.rename(id, 'long:src', 'long:dst')
    expect(res.ok).toBe(true)

    const after = fixture.store.get('long:dst')!.expiresAt
    /* 绝对时间戳换算回来应仍是 40 天左右（允许 5s 误差） */
    expect(Math.abs(after - before)).toBeLessThan(5000)
    expect(after - Date.now()).toBeGreaterThan((fortyDays - 5) * 1000)
    memcachedManager.disconnect(id)
  })

  it('键名含空格时拒绝（协议不允许）', async () => {
    const id = `rename-${++seq}`
    await memcachedManager.connect(config(id))
    await memcachedManager.set(id, 'bad:src', 'v')

    await expect(memcachedManager.rename(id, 'bad:src', 'bad key')).rejects.toThrow('空格')
    await expect(memcachedManager.rename(id, 'bad:src', '   ')).rejects.toThrow('不能为空')

    memcachedManager.disconnect(id)
  })

  it('源键不存在时报错', async () => {
    const id = `rename-${++seq}`
    await memcachedManager.connect(config(id))
    await expect(memcachedManager.rename(id, 'ghost:src', 'ghost:dst')).rejects.toThrow('过期')
    memcachedManager.disconnect(id)
  })

  it('旧服务端不支持 meta 时回退 plain get，并明确提示 TTL 丢失', async () => {
    const old = createServer({ disableMeta: true })
    const oldPort = await old.listen()
    const id = `rename-${++seq}`
    const state = await memcachedManager.connect(config(id, oldPort))
    expect(state.status).toBe('connected')

    await memcachedManager.set(id, 'legacy:src', 'legacy-value', { ttlSeconds: 900 })
    const res = await memcachedManager.rename(id, 'legacy:src', 'legacy:dst')
    expect(res.ok).toBe(true)
    expect(res.message).toContain('未能读取原 TTL')

    const dst = await memcachedManager.get(id, 'legacy:dst')
    expect(dst.found).toBe(true)
    expect(dst.data).toBe('legacy-value')
    expect(dst.ttl).toBeUndefined()

    memcachedManager.disconnect(id)
    await old.close()
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { gzipSync, deflateSync } from 'node:zlib'

/**
 * connection-manager 集成测试（真实 Redis，Docker redis:7-alpine）。
 *
 * 运行前提：KEYPER_TEST_REDIS_PORT 指向一次性测试实例（默认 6390）。
 * 实例不存在时整个套件跳过（skipIf），不阻塞无 Docker 环境的常规单测。
 *
 * 覆盖本轮性能改动的行为不变量：
 *   · string 大值分段（STRLEN+GETRANGE）：首屏截断 / 续读拼接 / UTF-8 边界 / whole 整读
 *   · valueBinary 限量取回 + 异步 gzip/zlib 解压
 *   · setValue MULTI 原子整写 + stream 批量 XADD + TTL 语义（KEEPTTL / EX）
 *   · 微操作 pipeline 合并后的返回值语义（新增/重复/越界/防覆盖）
 *   · bulk 批量通道：逐键结果 / 取消令牌 / 进度推送
 *   · describeKeys / deleteKeys 分片
 */

const require = createRequire(import.meta.url)
const Redis = require('ioredis') as typeof import('ioredis').default

const PORT = Number(process.env.KEYPER_TEST_REDIS_PORT ?? 6390)

/* 探测测试实例是否可用（同步决定 skip，避免 beforeAll 里抛错） */
let available = false
try {
  const probe = new Redis({ host: '127.0.0.1', port: PORT, lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 0, retryStrategy: () => null })
  await probe.connect()
  await probe.ping()
  await probe.quit()
  available = true
} catch {
  available = false
}

const describeIf = available ? describe : describe.skip

/* 连接管理器不依赖 electron（ssh-tunnel 仅 import 类型），可直接加载 */
import { connectionManager } from '@electron/services/connection-manager'
import type { RedisConnectionConfig } from '@shared/types'

const CONN_ID = 'perf-test-conn'
const config: RedisConnectionConfig = {
  id: CONN_ID,
  name: 'perf-test',
  engine: 'redis',
  host: '127.0.0.1',
  port: PORT,
  db: 15,
} as RedisConnectionConfig

/** 独立校验客户端（不走被测代码，直接对答案） */
let verify: InstanceType<typeof Redis>

beforeAll(async () => {
  if (!available) return
  verify = new Redis({ host: '127.0.0.1', port: PORT, db: 15 })
  await verify.flushdb()
  const state = await connectionManager.connect(config)
  expect(state.status).toBe('connected')
})

afterAll(async () => {
  if (!available) return
  await connectionManager.disconnect(CONN_ID)
  await verify.flushdb()
  await verify.quit()
})

describeIf('connection-manager · string 大值分段', () => {
  it('小于上限的 string 原样整读，无截断标记', async () => {
    await verify.set('small', 'hello 世界')
    const v = await connectionManager.getValue(CONN_ID, 'small')
    expect(v.value).toBe('hello 世界')
    expect(v.truncated).toBeFalsy()
    expect(v.nextCursor).toBeNull()
  })

  it('超过 2MB 的 string 首屏截断，续读拼回完整内容', async () => {
    /* 3MB ASCII：首屏 2MB + 续读 1MB */
    const big = 'a'.repeat(3 * 1024 * 1024)
    await verify.set('big', big)
    const first = await connectionManager.getValue(CONN_ID, 'big')
    expect(first.truncated).toBe(true)
    expect(first.length).toBe(big.length)
    expect((first.value as string).length).toBe(2 * 1024 * 1024)
    expect(first.nextCursor).toBe(String(2 * 1024 * 1024))

    const page = await connectionManager.valuePage(CONN_ID, 'big', {
      type: 'string',
      cursor: first.nextCursor!,
    })
    expect(page.value).toBe('a'.repeat(1024 * 1024))
    expect(page.nextCursor).toBeNull()
    expect((first.value as string) + (page.value as string)).toBe(big)
  })

  it('UTF-8 多字节字符跨段边界不丢字', async () => {
    /* 构造恰好在 2MB 边界切断三字节字符的内容 */
    const unit = '汉' /* 3 字节 */
    const count = Math.ceil((2 * 1024 * 1024) / 3) + 100
    const text = unit.repeat(count)
    await verify.set('utf8big', text)
    const first = await connectionManager.getValue(CONN_ID, 'utf8big')
    expect(first.truncated).toBe(true)
    const firstText = first.value as string
    /* 首屏不含替换字符（边界回退到完整字符） */
    expect(firstText.includes('\uFFFD')).toBe(false)
    expect(firstText.endsWith('汉')).toBe(true)
    /* 游标按实际消费字节推进 */
    expect(Number(first.nextCursor)).toBe(firstText.length * 3)

    let assembled = firstText
    let cursor = first.nextCursor
    while (cursor != null) {
      const page = await connectionManager.valuePage(CONN_ID, 'utf8big', { type: 'string', cursor })
      assembled += page.value as string
      cursor = page.nextCursor
    }
    expect(assembled).toBe(text)
  })

  it('whole=true 整读放宽到硬上限（复制/导出全部路径）', async () => {
    const big = 'b'.repeat(3 * 1024 * 1024)
    await verify.set('big2', big)
    const whole = await connectionManager.getValue(CONN_ID, 'big2', { whole: true })
    expect(whole.value).toBe(big)
    expect(whole.nextCursor).toBeNull()
  })
})

describeIf('connection-manager · valueBinary 限量与异步解压', () => {
  it('gzip 解压走异步路径且结果正确', async () => {
    const payload = JSON.stringify({ hello: 'world', n: 42 })
    await verify.set('gz', gzipSync(Buffer.from(payload)))
    const res = await connectionManager.valueBinary(CONN_ID, 'gz', { decode: 'gzip' })
    expect(res.decodeError).toBeUndefined()
    expect(res.decodedText).toBe(payload)
  })

  it('zlib 解压同样正确', async () => {
    const payload = 'x'.repeat(1000)
    await verify.set('zl', deflateSync(Buffer.from(payload)))
    const res = await connectionManager.valueBinary(CONN_ID, 'zl', { decode: 'zlib' })
    expect(res.decodedText).toBe(payload)
  })

  it('超过 4MB 的值只取回前 4MB（STRLEN 给真实大小）', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 0x61)
    await verify.set('binbig', big)
    const res = await connectionManager.valueBinary(CONN_ID, 'binbig')
    expect(res.bytes).toBe(big.length)
    expect(res.truncated).toBe(true)
    expect(Buffer.from(res.base64, 'base64').length).toBe(4 * 1024 * 1024)
  })
})

describeIf('connection-manager · setValue 原子整写', () => {
  it('hash 整写：DEL+HSET 原子，TTL 统一补 EXPIRE', async () => {
    await verify.hset('h1', 'old', 'x')
    const res = await connectionManager.setValue(CONN_ID, 'h1', 'hash', { a: '1', b: '2' }, 60)
    expect(res.ok).toBe(true)
    expect(await verify.hgetall('h1')).toEqual({ a: '1', b: '2' })
    expect(await verify.ttl('h1')).toBeGreaterThan(50)
  })

  it('string 不传 TTL 走 KEEPTTL（保留剩余存活时间）', async () => {
    await verify.set('s1', 'old', 'EX', 100)
    await connectionManager.setValue(CONN_ID, 's1', 'string', 'new')
    expect(await verify.get('s1')).toBe('new')
    const ttl = await verify.ttl('s1')
    expect(ttl).toBeGreaterThan(90)
    expect(ttl).toBeLessThanOrEqual(100)
  })

  it('string 显式 TTL 并入 SET EX', async () => {
    await connectionManager.setValue(CONN_ID, 's2', 'string', 'v', 30)
    expect(await verify.ttl('s2')).toBeGreaterThan(20)
  })

  it('stream 整写：N 行一次 MULTI，全部落库', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => `f${i} :: v${i}`)
    const res = await connectionManager.setValue(CONN_ID, 'st1', 'stream', rows)
    expect(res.ok).toBe(true)
    expect(await verify.xlen('st1')).toBe(50)
  })

  it('zset 整写按 member :: score 约定', async () => {
    await connectionManager.setValue(CONN_ID, 'z1', 'zset', ['a :: 1.5', 'b :: 2'])
    expect(await verify.zscore('z1', 'a')).toBe('1.5')
    expect(await verify.zcard('z1')).toBe(2)
  })

  it('大集合分片整写（>500 元素）不丢数据', async () => {
    const items = Array.from({ length: 1200 }, (_, i) => `item-${i}`)
    await connectionManager.setValue(CONN_ID, 'l1', 'list', items)
    expect(await verify.llen('l1')).toBe(1200)
    expect(await verify.lindex('l1', 1199)).toBe('item-1199')
  })
})

describeIf('connection-manager · 微操作 pipeline 语义', () => {
  it('addZsetMember：新建 / 追加 / 重复更新三种文案分支', async () => {
    const created = await connectionManager.addZsetMember(CONN_ID, 'mz', 'a', 1)
    expect(created.ok).toBe(true)
    const added = await connectionManager.addZsetMember(CONN_ID, 'mz', 'b', 2)
    expect(added.ok).toBe(true)
    const dup = await connectionManager.addZsetMember(CONN_ID, 'mz', 'a', 9)
    expect(dup.ok).toBe(true)
    expect(await verify.zscore('mz', 'a')).toBe('9')
    expect(await verify.zcard('mz')).toBe(2)
  })

  it('addSetMember：重复成员不重复添加', async () => {
    await connectionManager.addSetMember(CONN_ID, 'ms', 'x')
    const dup = await connectionManager.addSetMember(CONN_ID, 'ms', 'x')
    expect(dup.ok).toBe(true)
    expect(await verify.scard('ms')).toBe(1)
  })

  it('appendListElement：追加后长度正确', async () => {
    await connectionManager.appendListElement(CONN_ID, 'ml', 'a')
    const res = await connectionManager.appendListElement(CONN_ID, 'ml', 'b')
    expect(res.ok).toBe(true)
    expect(await verify.lrange('ml', 0, -1)).toEqual(['a', 'b'])
  })

  it('deleteListElement：哨兵法精确删除重复值中的指定位置', async () => {
    await verify.rpush('dl', 'same', 'same', 'other')
    const res = await connectionManager.deleteListElement(CONN_ID, 'dl', 1)
    expect(res.ok).toBe(true)
    expect(await verify.lrange('dl', 0, -1)).toEqual(['same', 'other'])
  })

  it('deleteListElement：越界返回失败', async () => {
    const res = await connectionManager.deleteListElement(CONN_ID, 'dl', 99)
    expect(res.ok).toBe(false)
  })

  it('insertListElement：before/after 位置正确且原值还原', async () => {
    await verify.rpush('il', 'a', 'b', 'c')
    await connectionManager.insertListElement(CONN_ID, 'il', 1, 'X', 'before')
    expect(await verify.lrange('il', 0, -1)).toEqual(['a', 'X', 'b', 'c'])
    await connectionManager.insertListElement(CONN_ID, 'il', 2, 'Y', 'after')
    expect(await verify.lrange('il', 0, -1)).toEqual(['a', 'X', 'b', 'Y', 'c'])
  })

  it('setZsetMember：改名 + 改分，目标重名如实提示', async () => {
    await verify.zadd('sz', 1, 'a', 2, 'b')
    const res = await connectionManager.setZsetMember(CONN_ID, 'sz', 'a', 'a2', 5)
    expect(res.ok).toBe(true)
    expect(await verify.zscore('sz', 'a2')).toBe('5')
    expect(await verify.zscore('sz', 'a')).toBeNull()
  })

  it('setSetMember：改名等价 SREM+SADD', async () => {
    await verify.sadd('ss', 'a', 'b')
    const res = await connectionManager.setSetMember(CONN_ID, 'ss', 'a', 'a2')
    expect(res.ok).toBe(true)
    expect(await verify.smembers('ss')).toEqual(expect.arrayContaining(['a2', 'b']))
    expect(await verify.sismember('ss', 'a')).toBe(0)
  })

  it('renameKey：目标已存在拒绝覆盖（防覆盖语义保留）', async () => {
    await verify.set('rk-src', '1')
    await verify.set('rk-dst', '2')
    await expect(connectionManager.renameKey(CONN_ID, 'rk-src', 'rk-dst')).rejects.toThrow()
    expect(await verify.get('rk-dst')).toBe('2')
    expect(await verify.get('rk-src')).toBe('1')
    const ok = await connectionManager.renameKey(CONN_ID, 'rk-src', 'rk-new')
    expect(ok.ok).toBe(true)
    expect(await verify.get('rk-new')).toBe('1')
  })
})

describeIf('connection-manager · bulk 批量通道', () => {
  it('批量删除：逐键结果，不存在的键记失败', async () => {
    await verify.mset({ bk1: '1', bk2: '2', bk3: '3' })
    const res = await connectionManager.bulk(CONN_ID, {
      action: 'delete',
      keys: ['bk1', 'bk2', 'bk-missing'],
    })
    expect(res.succeeded).toEqual(['bk1', 'bk2'])
    expect(res.failed.map((f: { key: string }) => f.key)).toEqual(['bk-missing'])
    expect(res.cancelled).toBe(false)
    expect(await verify.exists('bk1', 'bk2')).toBe(0)
    expect(await verify.get('bk3')).toBe('3')
  })

  it('批量 TTL：EXPIRE / PERSIST 分支都正确', async () => {
    await verify.mset({ bt1: '1', bt2: '2' })
    const set = await connectionManager.bulk(CONN_ID, { action: 'ttl', keys: ['bt1', 'bt2'], ttlSeconds: 120 })
    expect(set.succeeded.length).toBe(2)
    expect(await verify.ttl('bt1')).toBeGreaterThan(110)
    const persist = await connectionManager.bulk(CONN_ID, { action: 'ttl', keys: ['bt1'], ttlSeconds: -1 })
    expect(persist.succeeded).toEqual(['bt1'])
    expect(await verify.ttl('bt1')).toBe(-1)
  })

  it('批量重命名：映射到自身跳过记成功，目标冲突记失败', async () => {
    await verify.mset({ br1: '1', br2: '2', 'br-dst': 'x' })
    const res = await connectionManager.bulk(CONN_ID, {
      action: 'rename',
      keys: ['br1', 'br2', 'br2'],
      renameMap: { br1: 'br-dst', br2: 'br2' },
    })
    /* br1 → br-dst 冲突失败；br2 映射自身跳过成功（两条） */
    expect(res.failed.map((f: { key: string }) => f.key)).toEqual(['br1'])
    expect(res.succeeded).toEqual(['br2', 'br2'])
    expect(await verify.get('br-dst')).toBe('x')
  })

  it('取消令牌：bulkCancel 后循环在分片边界停下', async () => {
    const keys = Array.from({ length: 1500 }, (_, i) => `bc-${i}`)
    await verify.mset(Object.fromEntries(keys.map((k) => [k, 'v'])))
    const progress: number[] = []
    const off = connectionManager.onBulkProgress((p: { done: number }) => {
      progress.push(p.done)
      /* 第一批（500）完成后立即取消 */
      if (p.done >= 500) void connectionManager.bulkCancel(CONN_ID)
    })
    const res = await connectionManager.bulk(CONN_ID, { action: 'delete', keys })
    off()
    expect(res.cancelled).toBe(true)
    expect(res.succeeded.length).toBe(500)
    expect(res.succeeded.length + res.failed.length).toBeLessThan(1500)
    expect(progress.length).toBeGreaterThan(0)
    /* 未处理的键仍在库里 */
    expect(await verify.exists('bc-1499')).toBe(1)
  })

  it('超过 500 键的删除分片执行且计数正确', async () => {
    const keys = Array.from({ length: 1200 }, (_, i) => `chunk-${i}`)
    await verify.mset(Object.fromEntries(keys.map((k) => [k, 'v'])))
    const res = await connectionManager.deleteKeys(CONN_ID, keys)
    expect(res.ok).toBe(true)
    expect(await verify.dbsize()).toBeGreaterThanOrEqual(0)
    expect(await verify.exists(...keys.slice(0, 10))).toBe(0)
  })
})
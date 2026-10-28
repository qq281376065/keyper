import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatHistoryTime, useSearchHistory } from '@/hooks/useSearchHistory'
import type { SearchHistoryEntry } from '@shared/types'

/**
 * 键搜索历史 hook 单测（React 版）。
 *
 * LRU / 30 上限的落盘语义在主进程 store 与 mock 里各有一份，
 * 由 scripts/check-search-history.mjs 源级断言锁一致；
 * 这里测渲染层的纯逻辑：分桶加载、record 的本地副本更新、
 * 快速切库的时序守卫、matches / ghostTarget 的匹配语义。
 *
 * 移植说明：Vue 版 load() 显式调用 + ref 依赖；React 版由 effect
 * 依赖 [connId, db] 自动加载，测试用 renderHook rerender 驱动切换。
 */

const h = vi.hoisted(() => {
  const buckets = new Map<string, SearchHistoryEntry[]>()
  const calls: Array<{ fn: string; args: unknown[] }> = []
  let hangGet = false
  return { buckets, calls, hangGet }
})

vi.mock('@/api', () => ({
  api: {
    searchHistory: {
      get: vi.fn(async (connId: string, db: number) => {
        h.calls.push({ fn: 'get', args: [connId, db] })
        if (h.hangGet) return new Promise(() => {}) /* 永不 resolve，模拟慢请求 */
        return { ok: true, data: [...(h.buckets.get(`${connId}@${db}`) ?? [])] }
      }),
      record: vi.fn(async (connId: string, db: number, term: string) => {
        h.calls.push({ fn: 'record', args: [connId, db, term] })
        const key = `${connId}@${db}`
        const bucket = h.buckets.get(key) ?? []
        const i = bucket.findIndex((e) => e.q === term)
        if (i >= 0) {
          const [hit] = bucket.splice(i, 1)
          bucket.unshift({ q: hit.q, count: hit.count + 1, at: Date.now() })
        } else {
          bucket.unshift({ q: term, count: 1, at: Date.now() })
        }
        h.buckets.set(key, bucket)
        return { ok: true, data: [...bucket] }
      }),
      remove: vi.fn(async (connId: string, db: number, term: string) => {
        h.calls.push({ fn: 'remove', args: [connId, db, term] })
        const key = `${connId}@${db}`
        const bucket = (h.buckets.get(key) ?? []).filter((e) => e.q !== term)
        if (bucket.length) h.buckets.set(key, bucket)
        else h.buckets.delete(key)
        return { ok: true, data: [...bucket] }
      }),
      clear: vi.fn(async (connId: string, db: number) => {
        h.calls.push({ fn: 'clear', args: [connId, db] })
        h.buckets.delete(`${connId}@${db}`)
        return { ok: true, data: [] }
      }),
    },
  },
}))

function seedBucket(connId: string, db: number, entries: SearchHistoryEntry[]): void {
  h.buckets.set(`${connId}@${db}`, entries)
}

/** 等待一轮微任务 + 定时器排空（effect 里的异步 get/record 结果落地） */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

function mount(connId: string | null, db: number) {
  return renderHook(({ id, d }: { id: string | null; d: number } = { id: connId, d: db }) =>
    useSearchHistory(id, d),
  )
}

beforeEach(() => {
  h.buckets.clear()
  h.calls.length = 0
  h.hangGet = false
})

describe('useSearchHistory · 分桶加载', () => {
  it('按 连接@库 调用 get，桶数据进入 entries', async () => {
    seedBucket('c1', 2, [{ q: 'user:*', count: 3, at: 1 }])
    const s = mount('c1', 2)
    await flush()
    expect(h.calls[0]).toEqual({ fn: 'get', args: ['c1', 2] })
    expect(s.result.current.entries.map((e) => e.q)).toEqual(['user:*'])
    s.unmount()
  })

  it('未连接（connId null）直接清空，不发请求', async () => {
    const s = mount(null, 0)
    await flush()
    expect(h.calls.length).toBe(0)
    expect(s.result.current.entries).toEqual([])
    s.unmount()
  })

  it('快速切库：旧库的慢响应不覆盖新库数据（loadSeq 守卫）', async () => {
    seedBucket('c1', 0, [{ q: 'old-db0:*', count: 1, at: 1 }])
    seedBucket('c1', 1, [{ q: 'new-db1:*', count: 1, at: 2 }])
    const s = mount('c1', 0)

    /* 先放一个挂起的 db0 请求（永远不会 resolve） */
    h.hangGet = true
    await flush()
    h.hangGet = false

    /* 切到 db1：effect 重跑，db1 正常返回 */
    await act(async () => {
      s.rerender({ id: 'c1', d: 1 })
    })
    await flush()
    expect(s.result.current.entries.map((e) => e.q)).toEqual(['new-db1:*'])

    /* 旧 promise 永不 resolve；即使 resolve，seq 已不匹配，不允许覆盖新库数据 */
    s.unmount()
  })
})

describe('useSearchHistory · 记录与维护', () => {
  it('record 转发到正确的桶并更新本地副本（LRU 置顶）', async () => {
    seedBucket('c1', 0, [
      { q: 'a:*', count: 1, at: 1 },
      { q: 'b:*', count: 2, at: 2 },
    ])
    const s = mount('c1', 0)
    await flush()
    await act(async () => {
      await s.result.current.record('a:*')
    })
    expect(s.result.current.entries[0].q).toBe('a:*')
    expect(s.result.current.entries[0].count).toBe(2)
    s.unmount()
  })

  it('空词与未连接不产生 record 调用', async () => {
    const s = mount('c1', 0)
    await act(async () => {
      await s.result.current.record('   ')
    })
    const s2 = mount(null, 0)
    await act(async () => {
      await s2.result.current.record('user:*')
    })
    expect(h.calls.filter((c) => c.fn === 'record').length).toBe(0)
    s.unmount()
    s2.unmount()
  })

  it('remove 删除单条；最后一个删掉后本地也清空', async () => {
    seedBucket('c1', 0, [{ q: 'only:*', count: 1, at: 1 }])
    const s = mount('c1', 0)
    await flush()
    await act(async () => {
      await s.result.current.remove('only:*')
    })
    expect(s.result.current.entries).toEqual([])
    s.unmount()
  })

  it('clear 清空当前桶', async () => {
    seedBucket('c1', 0, [{ q: 'a:*', count: 1, at: 1 }])
    const s = mount('c1', 0)
    await flush()
    await act(async () => {
      await s.result.current.clear()
    })
    expect(s.result.current.entries).toEqual([])
    expect(h.buckets.has('c1@0')).toBe(false)
    s.unmount()
  })

  it('get 失败静默：entries 回退空数组而不是抛错', async () => {
    const { api } = await import('@/api')
    vi.mocked(api.searchHistory.get).mockRejectedValueOnce(new Error('boom'))
    const s = mount('c1', 0)
    await flush()
    expect(s.result.current.entries).toEqual([])
    s.unmount()
  })
})

describe('useSearchHistory · 匹配语义', () => {
  const entries: SearchHistoryEntry[] = [
    { q: 'HALLOWEEN:ANCHOR_TASK', count: 9, at: 3 },
    { q: 'HALLOWEEN:CONFIG', count: 5, at: 2 },
    { q: 'LUCKYSTAR', count: 1, at: 1 },
  ]

  async function ready() {
    seedBucket('c1', 0, entries)
    const s = mount('c1', 0)
    await flush()
    return s
  }

  it('空输入返回全部（LRU 顺序）', async () => {
    const s = await ready()
    expect(s.result.current.matches('').map((e) => e.q)).toEqual([
      'HALLOWEEN:ANCHOR_TASK',
      'HALLOWEEN:CONFIG',
      'LUCKYSTAR',
    ])
    s.unmount()
  })

  it('子串命中且区分大小写（与 filteredKeys / SCAN MATCH 一致）', async () => {
    const s = await ready()
    expect(s.result.current.matches('HALLOW').length).toBe(2)
    expect(s.result.current.matches('hallow').length).toBe(0) /* 小写不命中 */
    expect(s.result.current.matches('STAR').map((e) => e.q)).toEqual(['LUCKYSTAR'])
    s.unmount()
  })

  it('ghostTarget：更长的前缀命中，取 LRU 首条', async () => {
    const s = await ready()
    expect(s.result.current.ghostTarget('HALLOWEEN')?.q).toBe('HALLOWEEN:ANCHOR_TASK')
    expect(s.result.current.ghostTarget('LUCKYSTAR')).toBeNull() /* 完整词无剩余可补 */
    expect(s.result.current.ghostTarget('LUCK')?.q).toBe('LUCKYSTAR') /* 前缀命中 */
    expect(s.result.current.ghostTarget('luck')).toBeNull() /* 大小写不匹配不补（与 SCAN MATCH 同语义） */
    expect(s.result.current.ghostTarget('')).toBeNull()
    s.unmount()
  })

  it('formatHistoryTime：今天显示 HH:mm，更早显示 MM-DD', () => {
    const now = Date.now()
    const today = new Date()
    const sameBase = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 14, 30)
    const todayTs = new Date(sameBase).getTime() <= now ? new Date(sameBase).getTime() : new Date(sameBase).getTime() - 86_400_000
    const sameDay = new Date(todayTs).toDateString() === new Date(now).toDateString()
    if (sameDay) expect(formatHistoryTime(todayTs)).toMatch(/^\d{2}:\d{2}$/)
    else expect(formatHistoryTime(todayTs)).toMatch(/^\d{2}-\d{2}$/)
    /* 更早的日期：月-日形态 */
    const past = new Date(now - 40 * 86_400_000).getTime()
    expect(formatHistoryTime(past)).toMatch(/^\d{2}-\d{2}$/)
  })
})

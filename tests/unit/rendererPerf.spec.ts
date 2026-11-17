import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createStore, storeBatch, storeSubscribe, storeVersion } from '@/store/reactiveStore'
import { renderHook, act } from '@testing-library/react'
import { useCoalescedStream } from '@/hooks/useCoalescedStream'

/**
 * 本轮渲染层性能改动的行为不变量：
 *   · storeBatch：多字段写入合并为一次通知，嵌套安全，异常不吞
 *   · useCoalescedStream：同一帧内多条推送合并为一次 setState，上限裁剪保留最新
 */

describe('reactiveStore · batch 批量写入', () => {
  it('batch 内多字段写入只触发一次订阅通知', () => {
    const store = createStore({ a: 0, b: 0, c: 0 })
    const listener = vi.fn()
    storeSubscribe(store)(listener)

    storeBatch(store, () => {
      store.a = 1
      store.b = 2
      store.c = 3
    })

    expect(listener).toHaveBeenCalledTimes(1)
    expect(storeVersion(store)).toBe(1)
    expect(store.a).toBe(1)
    expect(store.c).toBe(3)
  })

  it('batch 外的写入仍逐次通知（语义不变）', () => {
    const store = createStore({ a: 0 })
    const listener = vi.fn()
    storeSubscribe(store)(listener)
    store.a = 1
    store.a = 2
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('嵌套 batch 只在最外层退出时通知一次', () => {
    const store = createStore({ a: 0, b: 0 })
    const listener = vi.fn()
    storeSubscribe(store)(listener)

    storeBatch(store, () => {
      store.a = 1
      storeBatch(store, () => {
        store.b = 2
      })
      expect(listener).not.toHaveBeenCalled()
    })

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('batch 内无写入不触发通知', () => {
    const store = createStore({ a: 1 })
    const listener = vi.fn()
    storeSubscribe(store)(listener)
    storeBatch(store, () => {
      store.a = 1 /* 同值写入，Object.is 相等 */
    })
    expect(listener).not.toHaveBeenCalled()
  })

  it('batch 内抛异常不吞错，且已写入的字段仍合并通知', () => {
    const store = createStore({ a: 0 })
    const listener = vi.fn()
    storeSubscribe(store)(listener)
    expect(() =>
      storeBatch(store, () => {
        store.a = 1
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(store.a).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('深层字段写入在 batch 内同样合并', () => {
    const store = createStore({ nested: { list: [] as number[] } })
    const listener = vi.fn()
    storeSubscribe(store)(listener)
    storeBatch(store, () => {
      store.nested.list.push(1)
      store.nested.list.push(2)
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.nested.list).toEqual([1, 2])
  })
})

describe('useCoalescedStream · 合帧缓冲', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    let rafId = 0
    const callbacks = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = ++rafId
      callbacks.set(id, cb)
      setTimeout(() => {
        if (callbacks.has(id)) {
          callbacks.delete(id)
          cb(performance.now())
        }
      }, 16)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      callbacks.delete(id)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('同一帧内多条推送合并为一次状态更新，保留全部条目', () => {
    const { result } = renderHook(() => useCoalescedStream<string>(10))
    act(() => {
      result.current.push('a')
      result.current.push('b')
      result.current.push('c')
    })
    /* flush 前 items 仍为空（缓冲在 ref 里） */
    expect(result.current.items).toEqual([])
    act(() => {
      vi.advanceTimersByTime(20)
    })
    expect(result.current.items).toEqual(['a', 'b', 'c'])
  })

  it('超过上限裁剪保留最新条目', () => {
    const { result } = renderHook(() => useCoalescedStream<number>(3))
    act(() => {
      for (let i = 0; i < 6; i++) result.current.push(i)
    })
    act(() => {
      vi.advanceTimersByTime(20)
    })
    expect(result.current.items).toEqual([3, 4, 5])
  })

  it('clear 清空已呈现与缓冲中的条目', () => {
    const { result } = renderHook(() => useCoalescedStream<string>(10))
    act(() => {
      result.current.push('a')
    })
    act(() => {
      vi.advanceTimersByTime(20)
    })
    act(() => {
      result.current.push('b')
      result.current.clear()
    })
    act(() => {
      vi.advanceTimersByTime(20)
    })
    expect(result.current.items).toEqual([])
  })

  it('跨帧推送分批呈现', () => {
    const { result } = renderHook(() => useCoalescedStream<string>(10))
    act(() => {
      result.current.push('a')
    })
    act(() => {
      vi.advanceTimersByTime(20)
    })
    act(() => {
      result.current.push('b')
    })
    act(() => {
      vi.advanceTimersByTime(20)
    })
    expect(result.current.items).toEqual(['a', 'b'])
  })
})
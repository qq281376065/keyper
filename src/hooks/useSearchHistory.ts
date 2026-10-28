import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import { useObservable } from '@/store/subscription'
import type { AppStore } from '@/store'
import type { SearchHistoryEntry } from '@shared/types'

export const SEARCH_HISTORY_LIMIT = 30

export interface UseSearchHistoryOptions {
  /** 会话 store：条目变化时要触发重渲染 */
  holder: AppStore<any>
  /** 不传则取会话状态里的 activeId / activeDb */
  getScope?: () => { connId: string | null; db: number }
}

/**
 * 键搜索历史（按连接 + 库分桶，LRU 30 条，落配置文件）。
 *
 * 移植说明：Vue 版用 watch([connId, db]) 重新 load；React 版在 effect 里
 * 依赖同样的两个值，语义一致（值变化即重读，且带 loadSeq 防串数据）。
 */
export function useSearchHistory(connId: string | null, db: number) {
  const [entries, setEntries] = useState<SearchHistoryEntry[]>([])

  /**
   * 加载序号：快速切库时 A 的连接历史可能晚于 B 返回，
   * 过期响应必须丢弃，否则会把上一台连接的历史显示在新建连接下。
   */
  const loadSeq = useRef(0)

  useEffect(() => {
    const seq = ++loadSeq.current
    if (!connId) {
      setEntries([])
      return
    }
    let alive = true
    void api.searchHistory
      .get(connId, db)
      .then((res) => {
        if (!alive || seq !== loadSeq.current) return
        if (res.ok) setEntries(res.data)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [connId, db])

  /** 只在「执行查询」时记录；输入过程中不记（否则每个字符都进历史） */
  async function record(keyword: string): Promise<void> {
    const kw = keyword.trim()
    if (!connId || !kw) return
    const res = await api.searchHistory.record(connId, db, kw)
    if (res.ok && res.data) setEntries(res.data)
  }

  async function remove(keyword: string): Promise<void> {
    if (!connId) return
    const res = await api.searchHistory.remove(connId, db, keyword)
    if (res.ok && res.data) setEntries(res.data)
  }

  async function clear(): Promise<void> {
    if (!connId) return
    const res = await api.searchHistory.clear(connId, db)
    if (res.ok) setEntries([])
  }

  /** 当前输入命中的候选（子串、区分大小写 —— 与 filteredKeys 同语义） */
  function matches(input: string): SearchHistoryEntry[] {
    const kw = input.trim()
    if (!kw) return entries
    return entries.filter((item) => item.q.includes(kw))
  }

  /** 幽灵补全建议：取 LRU 里首条「以已输入为前缀且更长」的条目（区分大小写） */
  function ghostTarget(input: string): SearchHistoryEntry | null {
    const typed = input
    if (!typed) return null
    for (const item of entries) {
      if (item.q.length > typed.length && item.q.startsWith(typed)) return item
    }
    return null
  }

  return { entries, record, remove, clear, matches, ghostTarget, reload: () => setEntries((v) => [...v]) }
}

/** 历史条目的相对时间：今天显示 HH:mm，更早显示 MM-DD */
export function formatHistoryTime(at: number): string {
  const date = new Date(at)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const pad = (n: number) => String(n).padStart(2, '0')
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

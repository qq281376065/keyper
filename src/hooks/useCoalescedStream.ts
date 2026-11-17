import { useEffect, useRef, useState } from 'react'

/**
 * 高频推送流的合帧缓冲。
 *
 * Pub/Sub 消息与键空间事件可能每秒上百条，逐条 setState 会让渲染帧
 * 被消息驱动打满（每条一次数组拷贝 + 重渲染 + 滚动）。这里把到达的
 * 条目先收进 ref 缓冲，用 requestAnimationFrame 每帧最多 flush 一次：
 * 一帧内的 N 条消息合并成一次 setState，DOM 更新与滚动也只发生一次。
 *
 * 上限裁剪在 flush 时做（保留最新 max 条），与逐条路径的语义一致。
 * 组件卸载时取消未执行的 rAF，不泄漏。
 */
export function useCoalescedStream<T>(max: number): {
  items: T[]
  push: (item: T) => void
  clear: () => void
} {
  const [items, setItems] = useState<T[]>([])
  const bufferRef = useRef<T[]>([])
  const frameRef = useRef<number | null>(null)
  const maxRef = useRef(max)
  maxRef.current = max

  useEffect(() => {
    return () => {
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [])

  function flush(): void {
    frameRef.current = null
    const buffered = bufferRef.current
    if (!buffered.length) return
    bufferRef.current = []
    setItems((prev) => {
      const next = [...prev, ...buffered]
      const limit = maxRef.current
      return next.length > limit ? next.slice(next.length - limit) : next
    })
  }

  function push(item: T): void {
    bufferRef.current.push(item)
    if (frameRef.current == null) {
      frameRef.current = requestAnimationFrame(flush)
    }
  }

  function clear(): void {
    bufferRef.current = []
    if (frameRef.current != null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    setItems([])
  }

  return { items, push, clear }
}
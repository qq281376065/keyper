import { useSyncExternalStore } from 'react'

let now = Date.now()
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function tick(): void {
  now = Date.now()
  for (const listener of listeners) listener()
}

function start(): void {
  if (timer !== null) return
  timer = setInterval(tick, 1000)
}

function stop(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

function onVisibilityChange(): void {
  if (document.hidden) {
    stop()
    return
  }
  start()
  tick()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    now = Date.now()
    document.addEventListener('visibilitychange', onVisibilityChange)
    if (!document.hidden) start()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }
}

function snapshot(): number {
  return now
}

/**
 * 全局共享的 1 秒时钟。
 *
 * 只有真正显示倒计时的组件（LiveTtl）订阅它：
 * 若把 tick 放在键列表顶层，展开的大树会每秒整体重渲染。
 * 页面不可见时停表，恢复时按真实时间戳重算，休眠回来也不会漂。
 */
export function useTtlClock(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

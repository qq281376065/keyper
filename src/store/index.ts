/*
 * 全局 store 入口：把「响应式对象 + 订阅」捆成一个 hooks 可用的对象。
 *
 * 用法（渲染层）：
 *   const state = useAppStore()   // 任何字段写入都会触发重渲染
 *   const s = useAppStore((v) => ...)   // 选择器版本，只在结果变化时重渲染
 *
 * 用法（逻辑层 / 非组件代码）：直接读裸对象，不需要订阅。
 */
import { useSyncExternalStore } from 'react'
import { createStore, storeSubscribe, storeVersion } from './reactiveStore'

export interface AppStore<T extends object> {
  /** 可观察对象：读 = 取当前值；写 = 触发订阅者 */
  store: T
  subscribe: (listener: () => void) => () => void
  getVersion: () => number
}

export function defineStore<T extends object>(initial: T): AppStore<T> {
  const store = createStore(initial)
  return {
    store,
    subscribe: storeSubscribe(store),
    getVersion: () => storeVersion(store),
  }
}

/** 订阅整个 store：任何写入都重渲染（与 Vue 组件内的响应式粒度一致） */
export function useStore<T extends object>(holder: AppStore<T>): T {
  useSyncExternalStore(holder.subscribe, holder.getVersion, holder.getVersion)
  return holder.store
}

/**
 * 选择器订阅：只有 selector 的返回值变化时才重渲染。
 *
 * 比较用 Object.is；返回对象/数组时请在 selector 里自己收敛成原始值
 * （对象字面量每次都会是新引用，会导致每次都重渲染）。
 */
export function useStoreSelector<T extends object, R>(
  holder: AppStore<T>,
  selector: (value: T) => R,
): R {
  let current = selector(holder.store)
  const getSnapshot = () => {
    const next = selector(holder.store)
    if (!Object.is(next, current)) current = next
    return current
  }
  useSyncExternalStore(holder.subscribe, getSnapshot, getSnapshot)
  return current
}

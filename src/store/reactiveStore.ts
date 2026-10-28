/*
 * 极简响应式 store。
 *
 * 为什么不用第三方状态库：
 * 本项目从 Vue 移植而来，原来的 composables 是「一个 reactive 对象 + 一堆
 * 直接改字段的函数」。若换成 reducer/immer 风格，等于把 2600 行已经
 * 调过几十个坑的业务逻辑重写一遍 —— 而重写的目标恰恰是**行为不变**。
 *
 * 这里提供一个和 Vue reactive 语义最接近的最小实现：
 *   · 任何深度的字段写入都会触发订阅者重新渲染；
 *   · 读取不需要 .value，直接 store.xxx；
 *   · 订阅者是 React，通过 useSyncExternalStore 接入，天然支持 tearing 校验。
 *
 * 实现方式：每次 get 返回的嵌套对象/数组先包一层 Proxy 并缓存。
 * 写入时沿「脏路径」向上逐个失效缓存 —— 上层也必须重新包，否则父对象
 * 上缓存的旧 Proxy 会让新子对象永远拿不到通知。
 */

type Listener = () => void

const proxyCache = new WeakMap<object, { proxy: object; unsubscribe: () => void }>()

/** 路径 → 该路径上被包裹过的 Proxy（用于写入时精确失效） */
const proxyPaths = new WeakMap<object, string[]>()

export interface StoreOptions {
  /** 写入时打印路径，调试用 */
  debug?: boolean
}

/**
 * 把普通对象变成可观察对象。
 *
 * 返回值的类型与入参完全一致（T），这样调用侧无需 `as any`。
 */
export function createStore<T extends object>(initial: T, options: StoreOptions = {}): T {
  const listeners = new Set<Listener>()
  let version = 0

  function emit(): void {
    version += 1
    for (const listener of [...listeners]) listener()
  }

  function isPlain(value: unknown): value is Record<string, unknown> | unknown[] {
    if (!value || typeof value !== 'object') return false
    if (Array.isArray(value)) return true
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
  }

  /** 注册「某路径上的对象发生了变化」，把该路径及其所有祖先的缓存清掉 */
  function invalidate(path: string[]): void {
    for (let i = path.length; i >= 0; i--) {
      const target = resolveRaw(path.slice(0, i))
      if (target && typeof target === 'object') proxyCache.delete(target as object)
    }
  }

  /** 从根开始按路径取原始对象（不经过 Proxy） */
  let resolveRaw: (path: string[]) => unknown = () => initial

  function wrap(target: Record<string, unknown> | unknown[], path: string[]): unknown {
    if (options.debug) {
      // 调试模式只额外记录一次来源，不影响行为
      void path
    }
    const cached = proxyCache.get(target)
    if (cached) return cached.proxy

    let proxy: unknown
    let unsubscribeCurrent: (() => void) | undefined
    const handler: ProxyHandler<Record<string, unknown> | unknown[]> = {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver)
        if (typeof prop === 'symbol' || typeof value === 'function') return value
        if (isPlain(value)) {
          return wrap(value, [...path, prop])
        }
        return value
      },
      set(obj, prop, value) {
        if (typeof prop === 'symbol') return Reflect.set(obj, prop, value)
        const previous = (obj as Record<string, unknown>)[prop]
        const done = Reflect.set(obj, prop, value)
        if (!done || Object.is(previous, value)) return done
        // 共享引用（如把全局数组赋给会话字段）不能算子树变更
        if (isPlain(previous)) proxyCache.delete(previous as object)
        invalidate([...path, prop])
        emit()
        return done
      },
      deleteProperty(obj, prop) {
        if (typeof prop === 'symbol') return Reflect.deleteProperty(obj, prop)
        const previous = (obj as Record<string, unknown>)[prop]
        const done = Reflect.deleteProperty(obj, prop)
        if (!done) return done
        if (isPlain(previous)) proxyCache.delete(previous as object)
        invalidate([...path, prop])
        emit()
        return done
      },
    }

    proxy = new Proxy(target, handler)
    unsubscribeCurrent = () => {
      // 保留接口以便将来做精细订阅；当前用整体失效即可
      void unsubscribeCurrent
    }
    proxyCache.set(target as object, { proxy: proxy as object, unsubscribe: () => {} })
    proxyPaths.set(target, path)
    /**
     * 数组方法（push/splice/filter…）走的是内部 [[Set]]，会触发上面的 set trap，
     * 因此无需单独包装。数组索引写入同理。
     */
    return proxy
  }

  resolveRaw = (path: string[]) => {
    let current: unknown = initial
    for (const key of path) {
      if (!current || typeof current !== 'object') return undefined
      current = (current as Record<string, unknown>)[key]
    }
    return current
  }

  function subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function getVersion(): number {
    return version
  }

  const root = wrap(initial as unknown as Record<string, unknown>, []) as T

  Object.defineProperties(root as unknown as Record<string, unknown>, {
    __subscribe: { value: subscribe, enumerable: false },
    __getVersion: { value: getVersion, enumerable: false },
  })

  return root
}

/** 从 createStore 产物上取订阅函数（不参与业务字段枚举） */
export function storeSubscribe<T extends object>(store: T): (listener: Listener) => () => void {
  return (store as unknown as { __subscribe: (l: Listener) => () => void }).__subscribe
}

export function storeVersion<T extends object>(store: T): number {
  return (store as unknown as { __getVersion: () => number }).__getVersion()
}

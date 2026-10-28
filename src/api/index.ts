import type { RedisDesktopApi } from '@shared/api'
import { mockApi } from './mock'

const bridge = (window as unknown as { redisApi?: RedisDesktopApi }).redisApi

/**
 * 统一数据入口。
 * 运行在 Electron 容器内时走 IPC 桥；纯浏览器环境下自动降级到 Mock，
 * 便于不启动主进程也能预览与联调界面。
 */
export const isElectron = !!bridge

/**
 * 把值洗成「可跨 contextBridge / IPC 传输」的纯数据。
 *
 * 清洗必须发生在**主世界**（本文件），而不是 preload 的 invoke()：
 * contextBridge 暴露的方法被渲染端调用时，参数要先从主世界跨到
 * preload 的隔离世界 —— 这一步用的是结构化克隆，响应式 store 返回的
 * Proxy 在这里就被拦截并抛 "An object could not be cloned"，
 * **根本轮不到** preload 里的 toPlain。
 *
 * 典型触发路径：从连接列表点连接（传 state.connections 的元素）。
 * 而「保存并连接」之所以没事，是因为表单 payload() 用展开运算符
 * 生成的是普通对象。
 *
 * 序列化失败（循环引用等）时返回原值，让真正的错误在调用处暴露。
 */
function sanitize(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return value
    }
  }
  return value
}

/**
 * 包一层函数：先把每个参数洗成纯数据，再调用 contextBridge 暴露的原始方法。
 */
function wrapFn(fn: (...args: never[]) => unknown): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => fn(...(args.map(sanitize) as never[]))
}

/**
 * 把 contextBridge 暴露的对象复制成普通对象，方法全部经 sanitize 包装。
 *
 * ⚠️ 必须用「复制对象」而不能用 `new Proxy(bridge, ...)`：
 * exposeInMainWorld 暴露的属性是只读且不可配置的，Proxy 的 get trap
 * 返回"包装过的副本"而非 target 原值，违反 JS 引擎 invariant 校验，
 * 直接抛
 *   'get' on proxy: property 'xxx' is a read-only and non-configurable
 *   data property on the proxy target but the proxy did not return its
 *   actual value
 * （0.0.5 的修复曾因此被 0.0.6 回滚）。复制出的普通对象属性访问
 * 不经过任何 trap，方法在主世界先洗参数再过桥，两头都安全。
 */
function wrapApi(source: object, depth = 0): unknown {
  const out: Record<string, unknown> = {}
  // 防御性限深：contextBridge 的 api 只有两层（app/connection/...），3 层足够
  for (const key of Object.keys(source)) {
    const value = (source as Record<string, unknown>)[key]
    if (typeof value === 'function') {
      out[key] = wrapFn(value as (...args: never[]) => unknown)
    } else if (value && typeof value === 'object' && depth < 3) {
      out[key] = wrapApi(value, depth + 1)
    } else {
      out[key] = value
    }
  }
  return out
}

export const api: RedisDesktopApi = bridge ? (wrapApi(bridge) as RedisDesktopApi) : mockApi

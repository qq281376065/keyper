/*
 * 把「可观察对象」接进 React 的渲染循环。
 *
 * 为什么需要它：
 * 业务代码（会话层、组件）写的是 store.xxx = value，这类写入发生在
 * 事件回调、异步回调、甚至定时器里。React 不会自动知道，必须有一个
 * 订阅把「版本号变了」翻译成「这个组件要重渲染」。
 *
 * 订阅的是「会话 store」而不是全局 store：
 * 每个标签一份会话，切换标签时组件树的 key 变化会重建订阅，
 * 因此不会出现「显示 A 连接数据、收到 B 连接更新」的串台。
 */
import { useSyncExternalStore } from 'react'

export interface Observable {
  subscribe: (listener: () => void) => () => void
  getVersion: () => number
}

export function useObservable(source: Observable): number {
  return useSyncExternalStore(source.subscribe, source.getVersion, source.getVersion)
}

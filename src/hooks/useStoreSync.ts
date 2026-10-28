/*
 * 组件级订阅：让 35 个组件用与 Vue 版一致的形态读取状态。
 *
 * 用法（组件内）：
 *   const { state, loadKeys, filteredKeys, settings } = useRedis()
 *   useBaseState(state)        // ← 新增的一行，等价于 Vue 模板里的隐式依赖收集
 *
 * 为什么订阅放在组件里而不是 hook 里：
 * 组件拿到的 state 可能是会话 Proxy、也可能是激活会话代理，两者底层
 * 是同一个 store；只有组件知道自己该订阅谁，所以统一用「当前会话 or 全局」
 * 的订阅源 —— 切换标签会重建组件树，订阅随之重建。
 */
import { globalHolder } from '@/store/global'
import { useObservable } from '@/store/subscription'
import { useSessionStore } from './useSessionStore'
import type { AppState } from '@/store/session'

/** 订阅当前会话状态；参数仅用于类型提示，实际订阅源按当前激活会话解析。 */
export function useBaseState(_state?: AppState): void {
  useObservable(useSessionStore())
}

/** 订阅全局状态（连接列表 / 标签栏 / toast / confirm） */
export function useGlobalState(): void {
  useObservable(globalHolder)
}

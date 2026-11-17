/*
 * 会话订阅句柄。
 *
 * 组件需要知道「本标签的会话」何时被写入。会话在切换标签时会被替换，
 * 因此订阅必须在渲染期解析到当前会话的 store，而不是在模块加载时固定。
 *
 * 会话 store 通过 createSession 里的 __holder 非枚举属性暴露；
 * 标签外（主页态）退回全局 store —— 与 useRedis 的回退语义一致。
 */
import { getSession, globalHolder, globalState } from '@/store/global'
import { getSessionHolder } from '@/store/session'
import { useContext, useRef, useSyncExternalStore } from 'react'
import { RedisSessionContext } from '@/store/useRedis'
import type { Observable } from '@/store/subscription'
import type { AppStore } from '@/store'
import { storeFieldVersion } from '@/store/reactiveStore'

/**
 * 取「当前组件该订阅的 store」：
 * 1. 标签树内（上下文里有本标签会话）：订阅**本会话**的 store —— 状态隔离的根基；
 * 2. 标签外：订阅全局 store（连接列表、标签栏、toast 等）。
 *
 * ⚠️ 早期实现从 `session.__holder` 取句柄，而句柄实际登记在 state 上
 * （且后来改用 WeakMap），于是永远取不到、全部退回全局 store ——
 * 表现为「键列表数据已经写进会话，界面却一直停在加载态」：
 * 组件订阅了错误的 store，写入自然触发不了重渲染。
 */
export function useSessionStore(): Observable {
  const scoped = useContext(RedisSessionContext)
  /*
   * 必须显式订阅 activeTabId 再按 id 取会话，不能直接调 currentSession()：
   * React Compiler 会把 currentSession() 的结果按上下文缓存，标签外（上下文恒为
   * undefined）永远返回首次解析到的全局 store，切换/新建标签后 CLI 等组件订阅
   * 不到会话写入，表现为「命令没有任何输出且输入框一直禁用」。
   */
  const activeTabId = useSyncExternalStore(
    globalHolder.subscribe,
    () => globalState.activeTabId,
    () => globalState.activeTabId,
  )
  const session = scoped?.session ?? (activeTabId ? getSession(activeTabId) : null)
  if (session) {
    const holder = getSessionHolder(session.state)
    if (holder) return holder
  }
  return globalHolder
}

/**
 * 字段级会话订阅：只有列出的顶层字段被写入时才重渲染。
 *
 * 为什么需要：useObservable(useSessionStore()) 订阅整个会话 store，
 * CLI 输出一行、搜索进度一跳都会让概览卡片（监控 / Pub/Sub / 慢查询）
 * 跟着重渲染 —— 它们实际只读 activeId / serverInfo 等少数字段。
 *
 * 实现：store 为每个顶层字段维护独立版本号（深层写入沿路径归到根字段），
 * 这里把「关心字段的版本拼接串」作为 useSyncExternalStore 的快照，
 * 无关字段写入时快照不变，React 跳过重渲染。
 *
 * ⚠️ fields 必须是编译期可确定的常量数组（调用处写字面量）：
 * 快照按字段列表计算，运行期变化会导致订阅口径漂移。
 * 全局字段（connections / tabs / toast…）不在会话 store 里，
 * 需要它们的组件仍用 useObservable(globalHolder) 或整店订阅。
 */
export function useSessionFields(fields: readonly string[]): void {
  const holder = useSessionStore() as AppStore<object>
  /* 快照缓存：版本串不变时返回同一引用，避免 useSyncExternalStore 误判 */
  const snapshotRef = useRef('')
  const getSnapshot = (): string => {
    let next = ''
    for (const field of fields) {
      next += `${field}:${storeFieldVersion(holder.store, field)};`
    }
    if (next !== snapshotRef.current) snapshotRef.current = next
    return snapshotRef.current
  }
  useSyncExternalStore(holder.subscribe, getSnapshot, getSnapshot)
}

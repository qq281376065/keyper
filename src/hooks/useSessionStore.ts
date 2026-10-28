/*
 * 会话订阅句柄。
 *
 * 组件需要知道「本标签的会话」何时被写入。会话在切换标签时会被替换，
 * 因此订阅必须在渲染期解析到当前会话的 store，而不是在模块加载时固定。
 *
 * 会话 store 通过 createSession 里的 __holder 非枚举属性暴露；
 * 标签外（主页态）退回全局 store —— 与 useRedis 的回退语义一致。
 */
import { currentSession, globalHolder } from '@/store/global'
import { getSessionHolder } from '@/store/session'
import { useContext } from 'react'
import { RedisSessionContext } from '@/store/useRedis'
import type { Observable } from '@/store/subscription'

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
  const session = scoped?.session ?? currentSession()
  if (session) {
    const holder = getSessionHolder(session.state)
    if (holder) return holder
  }
  return globalHolder
}

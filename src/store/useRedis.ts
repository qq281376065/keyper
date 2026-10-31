/*
 * useRedis：渲染层取数据与动作的唯一入口（对应 Vue 版的同名 composable）。
 *
 * 两种语境：
 *   · 标签树内（Workspace 之下）：拿到**本标签的会话**，状态完全隔离；
 *   · 标签外（App 顶栏、CLI 面板、确认弹窗）：拿到**激活会话代理**，
 *     自动跟随当前激活标签，主页态回退到全局层。
 *
 * 移植说明：
 * React 没有 inject/provide，改为 <RedisSessionContext> + useSession(connId)。
 * 为了让 35 个组件保持和原来一样的调用形态（const { state, loadKeys } = useRedis()），
 * 这里仍返回一个「合并后的对象」：state 与会话动作来自会话，连接管理来自全局。
 * state 用 Proxy 把全局字段（connections / tabs / toast / confirm）的读取
 * 转发到全局层 —— 与会话字段同处一个对象，组件无需关心字段归属。
 */
import { createContext, useContext } from 'react'
import {
  currentSession,
  globalActions,
  globalHolder,
  globalState,
  sessionActions,
  type ConnectionItem,
  type GlobalActions,
  type SessionActionKey,
} from '@/store/global'
import { defineStore, type AppStore } from '@/store'
import type { AppState, ConfirmRequest, RedisSessionApi, Toast } from '@/store/session'
import { getSessionHolder } from '@/store/session'
import type { RedisDesktopApi } from '@shared/api'
import { api } from '@/api'
import { settings } from '@/services/settings'

/** 全局字段：读取时转发到全局层，与会话字段共用同一个 state 对象 */
const GLOBAL_KEYS = new Set(['ready', 'envLabel', 'connections', 'toast', 'confirm', 'tabs', 'activeTabId'])

function makeStateProxy(sessionStore: AppStore<AppState>): AppState {
  const raw = sessionStore.store
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && GLOBAL_KEYS.has(prop)) {
        return (globalState as unknown as Record<string, unknown>)[prop]
      }
      return Reflect.get(target, prop, receiver)
    },
    set(target, prop, value) {
      if (typeof prop === 'string' && GLOBAL_KEYS.has(prop)) {
        ;(globalState as unknown as Record<string, unknown>)[prop] = value
        return true
      }
      return Reflect.set(target, prop, value)
    },
  }) as AppState
}

export interface RedisApi
  extends Omit<RedisSessionApi, 'state' | 'globals' | 'currentDbKeys' | 'filteredKeys'>,
    GlobalActions,
    /** 底层 IPC API（window / app / connection / redis / log / file / searchHistory） */
    Pick<RedisDesktopApi, 'window' | 'app' | 'connection' | 'redis' | 'log' | 'file' | 'searchHistory'> {
  state: AppState
  /** 当前上下文所属的会话（标签树内），标签外为 null */
  session: RedisSessionApi | null
  onlineConnections: ConnectionItem[]
  activeConnection: ConnectionItem | null
  currentDbKeys: number
  filteredKeys: ReturnType<RedisSessionApi['filteredKeys']>
  settings: typeof settings
  dispose: () => void
}

/**
 * 组装一个 RedisApi。
 * @param session 指定会话（标签树内）；null 表示「激活会话代理」语义
 */
function buildApi(session: RedisSessionApi | null): RedisApi {
  /*
   * 会话态必须代理**真实会话 store**，不能改成新 store 的浅拷贝：
   * 浅拷贝只是形状相同，写入（扫描结果、选中键…）全部落在副本里，
   * 真实会话永远拿不到数据 —— 表现为「连上了、库数也有了，但键列表恒空」。
   */
  const state = session ? makeStateProxy(sessionHolderOf(session)) : followState()

  return {
    ...(sessionActions as unknown as Record<SessionActionKey, (...a: any[]) => any>),
    ...(session
      ? ({
          /* 标签树内：直接绑定本会话的动作，避免"转发到激活标签"在并发渲染下串台 */
          ...pickSessionActions(session),
        } as object)
      : {}),
    ...globalActions,
    /* 底层 API 直接透出：组件里 api.redis.xxx / api.file.xxx 的调用形态保持不变 */
    window: api.window,
    app: api.app,
    connection: api.connection,
    redis: api.redis,
    log: api.log,
    file: api.file,
    searchHistory: api.searchHistory,
    state,
    session,
    get onlineConnections() {
      return globalState.connections.filter((item) => item.status === 'connected')
    },
    get activeConnection() {
      const id = session?.state.activeId ?? globalState.activeId
      return globalState.connections.find((item) => item.id === id) ?? null
    },
    get currentDbKeys() {
      return (session ?? currentSession())?.currentDbKeys() ?? 0
    },
    get filteredKeys() {
      return (session ?? currentSession())?.filteredKeys() ?? []
    },
    settings,
    dispose: () => session?.dispose(),
  } as unknown as RedisApi
}

/**
 * 取会话的内部 store 句柄。
 * createSession 把 __holder 以非枚举属性挂在 **state** 上（不是 session 对象），
 * 因此要从 state 上取；取不到时退回会话自身的 state（只读场景仍可用）。
 */
function sessionHolderOf(session: RedisSessionApi): AppStore<AppState> {
  const holder = getSessionHolder(session.state)
  if (holder) return holder
  return {
    store: session.state,
    subscribe: () => () => {},
    getVersion: () => 0,
  }
}

/** 会话动作直绑（标签树内） */
function pickSessionActions(session: RedisSessionApi): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const keys = [
    'loadDatabases', 'loadServerInfo', 'loadKeys', 'loadMore', 'loadAll', 'refreshKeys', 'switchDb',
    'selectKey', 'markSelected', 'refreshSelected', 'loadMoreValue', 'readWholeValue', 'dropElementLocally',
    'insertElementLocally', 'replaceElementLocally', 'renameFieldLocally', 'deleteKeys',
    'openBulkTask', 'runBulkTask', 'cancelBulkTask', 'closeBulkTask',
    'openMcBulkTask', 'runMcBulkTask', 'cancelMcBulkTask', 'closeMcBulkTask',
    'saveValue', 'setTtl',
    'renameKey', 'runCli', 'clearCli', 'stopRemoteSearch', 'searchCurrentDb',
  ]
  for (const key of keys) {
    const fn = (session as unknown as Record<string, (...a: unknown[]) => unknown>)[key]
    out[key] = typeof fn === 'function' ? fn.bind(session) : fn
  }
  const extended = session as unknown as Record<string, unknown>
  out.resetRemoteSearch = extended.resetRemoteSearch
  out.setKeyFilterExact = extended.setKeyFilterExact
  out.notify = session.notify
  out.askConfirm = session.askConfirm
  return out
}

/**
 * 激活会话代理的 state：
 * 标签外组件读 state 时，字段级路由到当前激活会话，
 * 主页态回退到全局层的同名字段。
 */
const EMPTY_STATE = {
  ready: false,
  envLabel: '',
  activeId: null,
  databases: [],
  activeDb: 0,
  keys: [],
  cursor: '0',
  pattern: '*',
  loadingKeys: false,
  refreshingKeys: false,
  keysDataset: '',
  keyFilter: '',
  keyFilterExact: false,
  remoteSearch: null,
  remoteKeys: [],
  selectedKey: null,
  selectedValue: null,
  loadingValue: false,
  refreshingValue: false,
  loadingMoreValue: false,
  serverInfo: null,
  cliEntries: [],
  cliRunning: false,
  cliHistory: [],
  cliHistoryIndex: -1,
  bulkTask: null,
  mcBulkTask: null,
  toast: null,
  confirm: null,
  tabs: [],
  activeTabId: null,
} as unknown as AppState

/** 主页态兜底：全局层字段 + 会话字段默认值 */
const homeHolder = defineStore<AppState>({ ...EMPTY_STATE })
homeHolder.store.ready = globalState.ready
homeHolder.store.envLabel = globalState.envLabel
homeHolder.store.tabs = globalState.tabs
homeHolder.store.activeTabId = globalState.activeTabId

function followState(): AppState {
  return new Proxy(homeHolder.store, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return undefined
      /*
       * 全局字段优先判定（顺序不可颠倒）：
       * 会话 state 为了满足 AppState 形状，也带着一份同名的默认值
       * （connections: []、toast: null…）。若先查会话，标签外的组件
       * 读 state.connections 会拿到**会话里那份空数组** ——
       * 表现为「连接成功后左侧列表变空」，而 store 本身并未被清空。
       */
      if (GLOBAL_KEYS.has(prop)) return (globalState as unknown as Record<string, unknown>)[prop]
      const session = currentSession()
      if (session) return (session.state as unknown as Record<string, unknown>)[prop]
      return Reflect.get(target, prop, receiver)
    },
    set(target, prop, value) {
      if (typeof prop !== 'string') return false
      if (GLOBAL_KEYS.has(prop)) {
        ;(globalState as unknown as Record<string, unknown>)[prop] = value
        return true
      }
      const session = currentSession()
      if (session) {
        ;(session.state as unknown as Record<string, unknown>)[prop] = value
        return true
      }
      return Reflect.set(target, prop, value)
    },
  })
}

/* ---------------------------------------------------------------- Context */

/**
 * 标签树内的会话上下文。
 * Workspace 用 <RedisSessionContext.Provider value={api}> 注入本标签的会话，
 * 内部组件通过 useRedis() 取到它（而不是激活标签的会话）。
 */
export const RedisSessionContext = createContext<RedisApi | null>(null)

/** 标签树外共享的激活会话代理（App 根注入） */
const activeApi = buildApi(null)

export function useActiveApi(): RedisApi {
  return activeApi
}

/**
 * 取 Redis API：
 * - Workspace 标签树内：上下文里的本标签会话（状态隔离的根基）；
 * - 标签外：激活会话代理 —— 自动跟随当前激活标签，主页时回退全局。
 */
export function useRedis(): RedisApi {
  return useContext(RedisSessionContext) ?? activeApi
}

/** 永远取全局 API（连接管理、标签栏操作；TabBar / 侧栏 / 对话框使用） */
export function useGlobalRedis(): RedisApi {
  return activeApi
}

/** 供 Workspace 组件构造某个连接的 API（内部已绑定该会话） */
export function makeSessionApi(session: RedisSessionApi): RedisApi {
  return buildApi(session)
}

export type { AppState, ConfirmRequest, RedisSessionApi, Toast }
export type { ConnectionItem } from './session'
export { globalHolder, globalState }

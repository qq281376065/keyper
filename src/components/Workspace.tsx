/**
 * 多标签工作区：键列表 + 分隔条 + 值区。
 *
 * 核心职责是把「本标签的会话」提供（provide）给整棵子树 ——
 * KeyBrowser / ValueViewer / 各弹窗与编辑器 hook 里的 useRedis()
 * 由此拿到隔离的 state（键列表、选中键、CLI 输出…），
 * 多标签之间的状态互不可见。
 *
 * 多个 Workspace 同时挂载（非激活的用 hidden 隐藏），切换标签零重建：
 * 组件本地状态（树展开、滚动位置、行内编辑草稿）天然保留。
 */
import { useEffect, useState } from 'react'
import { KeyBrowser } from '@/components/KeyBrowser'
import { MemcachedKeyBrowser } from '@/components/MemcachedKeyBrowser'
import { MemcachedValueViewer } from '@/components/MemcachedValueViewer'
import { globalState } from '@/store/global'
import { BlurTickContext } from '@/hooks/useTabBlur'
import { ValueViewer } from '@/components/ValueViewer'
import { SplitPane } from '@/components/SplitPane'
import { getSession } from '@/store/global'
import { RedisSessionContext, makeSessionApi } from '@/store/useRedis'
import { KEY_BROWSER_MIN_WIDTH, useSettings } from '@/services/settings'

export function Workspace({ connId, hidden }: { connId: string; hidden?: boolean }) {
  /**
   * 会话必须在渲染期同步就绪：连接成功时 activateOrOpenTab 已经建好会话，
   * 这里按 id 取即可。取不到说明标签与会话失步（理论上不会发生），
   * 此时渲染空壳而不是抛错 —— 抛错会让整窗白屏。
   */
  /*
   * 每次渲染都重新取会话并重建 API 包装：
   * - getSession 是 O(1) 的 Map 查询，重建包装成本极低；
   * - 若用 useMemo 按 [session, connId] 缓存，会话在挂载后被创建/替换时
   *   缓存会锁住旧的 null，表现为「标签打开了但键列表永远是空/加载中」。
   */
  const session = getSession(connId)
  const api = session ? makeSessionApi(session) : null
  const { settings, save: saveSettings } = useSettings()

  /**
   * 标签被隐藏时通知子树「我失焦了」。
   *
   * 为什么需要：浮层菜单（行右键菜单、键右键菜单、tooltip）都通过
   * createPortal 挂到 <body>，**不在本标签的 DOM 子树内**，
   * 因此 hidden / display:none 对它们无效 —— 切换标签后，
   * 上一个标签的菜单会原地留在屏幕上，且其数据属于上一个连接
   * （用户看到的就是「右侧面板没跟着切换」）。
   * 这里用一个递增计数广播失焦信号，子树据此关闭全部浮层。
   */
  const [blurTick, setBlurTick] = useState(0)
  useEffect(() => {
    if (hidden) setBlurTick((n) => n + 1)
  }, [hidden])

  if (!api) return null

  /**
   * 键栏宽度落盘。
   *
   * 只在拖拽结束（SplitPane 的 onCommit）时写一次，
   * 而不是每帧都写 —— 拖动过程中指针事件可达 120Hz，
   * 每次都走 IPC 写文件会造成明显卡顿。
   */
  function persistKeyWidth(width: number): void {
    void saveSettings({ keyBrowserWidth: width })
  }

  return (
    <BlurTickContext.Provider value={blurTick}>
      <RedisSessionContext.Provider value={api}>
        {/*
        v-show 语义：非激活标签必须真正不占位。
        用 HTML hidden 属性不行 —— 浏览器 UA 的 [hidden]{display:none} 优先级低于
        作者样式 .s-workspace.tab-workspace{display:flex}，会被覆盖，
        表现为所有标签的工作区并排同时显示（Vue v-show 写的是内联 display，无此问题）。
        这里直接写内联 display，与原版 v-show 行为一致。
      */}
      <div
        className="tab-workspace s-workspace"
        hidden={hidden}
        style={hidden ? { display: 'none' } : undefined}
        data-blur-tick={blurTick}
      >
        {/*
          左栏按引擎分流。
          Memcached 的键栏不能复用 KeyBrowser —— 那套骨架建立在
          db 选择、SCAN 游标、类型徽标、分隔符建树上，Memcached 一个都没有。
          复用会让界面出现大量"点了没反应"的控件。
        */}
        {globalState.connections.find((item) => item.id === connId)?.engine === 'memcached' ? (
          <MemcachedKeyBrowser />
        ) : (
          <KeyBrowser />
        )}
        {/*
          分隔条是两栏之间的**独立 flex 子元素**，不属于任何一栏。
          这样它天然占据两栏之间的缝隙，不需要越界定位，
          也就不会叠到值区上、不会误触发值区的 hover/选中态。
        */}
        <SplitPane
          value={settings.keyBrowserWidth}
          min={KEY_BROWSER_MIN_WIDTH}
          max={720}
          defaultValue={KEY_BROWSER_MIN_WIDTH}
          onChange={(width) => {
            settings.keyBrowserWidth = width
          }}
          onCommit={persistKeyWidth}
        />
        {/*
          右栏同样按引擎分流。
          Memcached 只需要"看一个字符串值"，而 Redis 的 ValueViewer 带着
          六种类型的编辑器、TTL、虚拟滚动、行号槽 —— 全是 Memcached 没有的概念。
        */}
        {globalState.connections.find((item) => item.id === connId)?.engine === 'memcached' ? (
          <MemcachedValueViewer connectionId={connId} />
        ) : (
          <ValueViewer />
        )}
      </div>
      </RedisSessionContext.Provider>
    </BlurTickContext.Provider>
  )
}

export default Workspace

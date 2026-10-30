import { useEffect, useRef, useState } from 'react'
import { api, isElectron } from '@/api'
import { AppTooltip } from '@/components/AppTooltip'
import { CliConsole } from '@/components/CliConsole'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ConnectionDialog } from '@/components/ConnectionDialog'
import { ImportUriDialog } from '@/components/ImportUriDialog'
import { ConnectionSidebar } from '@/components/ConnectionSidebar'
import { DialogIcon } from '@/components/DialogIcon'
import { LogPanel } from '@/components/LogPanel'
import { SettingsDialog } from '@/components/SettingsDialog'
import { TabBar } from '@/components/TabBar'
import { ThemeSwitch } from '@/components/ThemeSwitch'
import { VersionInfoDialog } from '@/components/VersionInfoDialog'
import { WelcomePanel } from '@/components/WelcomePanel'
import { Workspace } from '@/components/Workspace'
import { APP_VERSION } from '@/services/errorReport'
import { migrateThemeFromStorage } from '@/services/theme'
import { useSettings } from '@/services/settings'
import { globalActions, globalHolder, globalState, type ConnectionItem } from '@/store/global'
import { useActiveApi } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { tipProps } from '@/components/tip'
import { toConfig } from '@/utils/engine'
import type { CacheConnectionConfig, RedisConnectionConfig } from '@shared/types'

/**
 * 应用外壳：顶栏 + 连接侧栏 + 标签工作区 + CLI，以及各全局弹窗的挂载点。
 *
 * 多标签主区：标签栏常驻（主页标签固定），下方按激活标签切换内容。
 * 连接标签用 hidden 而非卸载 —— 切换零重建，树展开、滚动位置、
 * 行内编辑草稿等组件本地状态天然保留在各标签内。
 */
export function App() {
  const api = useActiveApi()
  const state = api.state
  const global = globalHolder.store
  useObservable(globalHolder)
  const { load: loadSettings } = useSettings()

  const [dialogVisible, setDialogVisible] = useState(false)
  /** null 表示新建；有值表示编辑既有连接 */
  const [dialogInitial, setDialogInitial] = useState<CacheConnectionConfig | null>(null)
  /** 粘贴连接串弹窗：解析成功后把结果交给标准连接表单，用户仍可改 */
  const [importUriVisible, setImportUriVisible] = useState(false)
  const [version, setVersion] = useState(APP_VERSION)
  const [settingsVisible, setSettingsVisible] = useState(false)
  /** 正在查看版本信息的连接 */
  const [versionTarget, setVersionTarget] = useState<ConnectionItem | null>(null)

  /*
   * 操作日志抽屉的开关。
   *
   * 两个状态：`logVisible` 控制是否渲染，`logClosing` 控制离场动画。
   *
   * 卸载时机用「动画结束事件」而非固定 setTimeout：
   * setTimeout 与 CSS 时长一旦不同步（改动画时长忘了改常量、
   * 系统开启"减少动态效果"导致动画被跳过），就会出现
   * "动画没播完就消失"或"播完了还留着"两种坏情况。
   * 监听 animationend 能天然跟随实际播放进度。
   */
  const [logVisible, setLogVisible] = useState(false)
  const [logClosing, setLogClosing] = useState(false)

  /*
   * 无边框窗口的自绘标题栏状态：
   * 最大化时按钮图标要从「最大化」切换成「向下还原」。
   * 初始值拉取一次，之后靠主进程的 maximize/unmaximize 事件推送。
   */
  const [windowMaximized, setWindowMaximized] = useState(false)
  const [toastVisible, setToastVisible] = useState(true)

  useEffect(() => {
    setToastVisible(true)
    if (!global.toast) return
    const timer = setTimeout(() => setToastVisible(false), 200)
    return () => clearTimeout(timer)
  }, [global.toast])

  useEffect(() => {
    let unlistenWindowState: (() => void) | null = null
    /*
     * 退出确认：主进程拦下窗口 close，通知这里弹自绘弹窗。
     *
     * 用 askConfirm(force) 而不是新写一个弹窗 —— 它就是全局的
     * ConfirmDialog，与删除键、删除连接同一套外观，深浅主题自动跟随。
     * force: true 让它不受「删除键前确认」那个设置影响：
     * 退出程序永远该问一次，与删键偏好无关。
     *
     * 用户确认 → api.window.confirmClose() → 主进程 destroy。
     * 点取消就什么都不做，窗口保持原样。
     */
    let unlistenBeforeClose: (() => void) | null = null
    if (isElectron) {
      unlistenBeforeClose = api.window.onBeforeClose(() => {
        /*
         * 先回执，主进程据此取消兜底强制关闭。
         * 必须放在弹窗之前、同步执行：哪怕后面取数据抛错，
         * 也不能让窗口因为"渲染层没回应"而被强杀。
         */
        api.window.closeHandled()

        /*
         * 列出正在连接的实例，让用户在退出前看清会中断哪些会话。
         * 这些是"当前活着的东西"，是退出决策真正需要的信息；
         * 连接配置本身退出后仍在，不必列。
         */
        const online = globalState.connections.filter((c) => c.status === 'connected')
        /*
         * 明细里带上引擎：同时连了 Redis 与 Memcached 时，
         * 只写 host:port 分不清是哪个模块的会话，
         * 而"退出会断哪些"正是这个弹窗要回答的问题。
         * 尾部信息也按引擎给：Redis 显示 db，Memcached 显示连接池。
         */
        const details = online.map((c) => ({
          label: '连接中',
          value:
            c.engine === 'memcached'
              ? `[Memcached] ${c.name} · ${c.host}:${c.port} · 池 ${c.poolSize ?? 4}`
              : `[Redis] ${c.name} · ${c.host}:${c.port} · db${c.db}`,
          mono: false,
        }))

        /*
         * 文案区分单复数：只有 1 个连接时说「这些会话」很别扭，
         * 而"1 个连接"恰恰是最常见的情况。
         */
        const many = online.length > 1
        void globalActions
          .askConfirm({
            force: true,
            danger: true,
            title: '退出 Keyper',
            description: online.length ? '退出前会先断开连接' : '退出后可以再次打开，连接配置不会丢失',
            message: online.length
              ? `当前有 ${online.length} 个连接处于连接状态，退出会连同${many ? '这些' : '该'}会话一起断开。`
              : '当前没有处于连接状态的实例。未保存的编辑内容会丢失。',
            details,
            warning: online.length ? `退出时将自动断开${many ? '以上连接' : '该连接'}。` : undefined,
            confirmText: online.length ? '断开并退出' : '退出',
          })
          .then(async (ok) => {
            if (!ok) return
            /*
             * 先断开全部连接再关窗口。
             *
             * 顺序不能反：destroy 之后渲染进程没了，disconnect 的 IPC 发不出去，
             * 服务端的连接要等 TCP 超时才回收，在 Redis 侧会留下
             * 「客户端列表里挂着一堆僵尸连接」的观感。
             */
            await globalActions.disconnectAllForQuit()
            api.window.confirmClose()
          })
      })
    }
    void (async () => {
      await loadSettings()
      // 设置就绪后迁移旧版主题偏好（localStorage → settings.json）
      migrateThemeFromStorage()
      await api.bootstrap()

      // 无边框窗口：拉取最大化初始状态并订阅后续变化（浏览器预览为 no-op）
      if (isElectron) {
        const res = await api.window.state()
        if (res.ok) setWindowMaximized(res.data.maximized)
        unlistenWindowState = api.window.onStateChange((s) => {
          setWindowMaximized(s.maximized)
        })
      }
      /*
       * 多标签：不再恢复上次的连接选择 —— 重启后永远从主页标签开始
       * （「开机不自动连生产库」原则不变）。lastDb / lastConnectionId
       * 仍会在使用过程中记录，作为新开标签的库号偏好。
       */
      const versionRes = await api.app.getVersion()
      if (versionRes.ok) setVersion(versionRes.data)
    })()
    return () => {
      unlistenWindowState?.()
      unlistenWindowState = null
      unlistenBeforeClose?.()
      unlistenBeforeClose = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 兜底定时器：动画事件因浏览器设置被跳过时，保证面板仍会被卸载 */
  const logCloseRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  function openLog(): void {
    window.clearTimeout(logCloseRef.current)
    setLogClosing(false)
    setLogVisible(true)
  }

  function finishCloseLog(): void {
    window.clearTimeout(logCloseRef.current)
    setLogVisible(false)
    setLogClosing(false)
  }

  function closeLog(): void {
    if (!logVisible || logClosing) return
    setLogClosing(true)

    /*
     * 兜底：若动画事件始终没来（例如系统开启"减少动态效果"，
     * 浏览器直接跳过动画），600ms 后强制卸载，避免面板卡在中间态。
     * 正常路径由 LogPanel 的 animationend 提前卸载，这里的定时器会被清掉。
     */
    logCloseRef.current = setTimeout(finishCloseLog, 600)
  }

  function minimizeWindow(): void {
    void api.window.minimize()
  }

  function toggleMaximize(): void {
    void api.window.maxToggle()
  }

  function closeWindow(): void {
    void api.window.close()
  }

  function openNewConnection(): void {
    setDialogInitial(null)
    setDialogVisible(true)
  }

  function openEditConnection(connection: ConnectionItem): void {
    /*
     * 编辑传的是"配置"而不是界面条目：ConnectionItem 挂着
     * status/latency 这些运行时字段，直接塞进表单会让对话框
     * 拿到一份含过期状态的草稿，保存时容易连带写回磁盘。
     */
    setDialogInitial(toConfig(connection))
    setDialogVisible(true)
  }

  /**
   * 连接串解析完成 → 用解析结果预填标准表单。
   *
   * 不直接连接：解析结果仍要经过用户的确认与可编辑的表单，
   * 否则粘贴错一行就会连到别的实例上。
   */
  function handleUriParsed(config: RedisConnectionConfig): void {
    setDialogInitial(config)
    setDialogVisible(true)
  }

  return (
    <div className="shell s-app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">R</span>
          <span className="brand-name">Keyper</span>
          <span className="version mono">v{version}</span>
        </div>

        {/*
          顶栏不再展示服务端指标：
          这些数据（版本/模式/键总数/客户端/内存/命中率/OPS）与主区的
          概览卡片完全重复，而卡片版分组更清晰、还带详情。
          顶栏只保留品牌与操作入口，视觉上也更安静。
        */}

        <div className="topbar-actions">
          <button className="bar-btn" {...tipProps('操作日志')} onClick={openLog}>
            <DialogIcon name="activity" size={14} />
          </button>
          <button className="bar-btn" {...tipProps('全局设置')} onClick={() => setSettingsVisible(true)}>
            <DialogIcon name="hamburger" size={14} />
          </button>
          <ThemeSwitch />
          {/* 自绘窗口控制：系统标题栏已隐藏（titleBarStyle: hidden） */}
          <div className="win-controls">
            <button className="win-btn" {...tipProps('最小化')} onClick={minimizeWindow}>
              <DialogIcon name="win-min" size={12} />
            </button>
            <button
              className="win-btn"
              {...tipProps(windowMaximized ? '向下还原' : '最大化')}
              onClick={toggleMaximize}
            >
              <DialogIcon name={windowMaximized ? 'win-restore' : 'win-max'} size={12} />
            </button>
            <button className="win-btn win-close" {...tipProps('关闭')} onClick={closeWindow}>
              <DialogIcon name="cancel" size={13} />
            </button>
          </div>
        </div>
      </header>

      <main className="body">
        <ConnectionSidebar
          onNewConnection={openNewConnection}
          onEditConnection={openEditConnection}
          onViewVersion={(item) => setVersionTarget(item)}
        />

        <div className="workspace">
          <TabBar />
          <div className="workspace-body">
            {/* 主页：固定标签，承载原欢迎页内容 */}
            {!state.activeTabId ? <WelcomePanel
              onNewConnection={openNewConnection}
              onImportUri={() => setImportUriVisible(true)}
              onOpenLog={openLog}
            /> : null}
            {state.tabs.map((connId) => (
              <Workspace key={connId} connId={connId} hidden={state.activeTabId !== connId} />
            ))}
          </div>
        </div>
      </main>

      <CliConsole />

      {dialogVisible ? (
        <ConnectionDialog initial={dialogInitial} onClose={() => setDialogVisible(false)} />
      ) : null}

      {importUriVisible ? (
        <ImportUriDialog onClose={() => setImportUriVisible(false)} onSubmit={handleUriParsed} />
      ) : null}

      {settingsVisible ? <SettingsDialog onClose={() => setSettingsVisible(false)} /> : null}

      {/*
        操作日志以右侧抽屉形式呈现。
        closing 触发离场动画；动画结束（animationend）后再卸载组件。
      */}
      {logVisible ? <LogPanel closing={logClosing} onClose={closeLog} onClosed={finishCloseLog} /> : null}

      {versionTarget ? (
        <VersionInfoDialog
          connectionId={versionTarget.id}
          connectionName={versionTarget.name}
          host={versionTarget.host}
          port={versionTarget.port}
          onClose={() => setVersionTarget(null)}
        />
      ) : null}

      <ConfirmDialog />

      {global.toast && toastVisible ? <div className={`toast ${global.toast.kind}`}>{global.toast.text}</div> : null}

      {/* 全局提示层：所有 tooltip 共用一个实例，挂在最外层避免被局部容器裁剪 */}
      <AppTooltip />
    </div>
  )
}

export default App

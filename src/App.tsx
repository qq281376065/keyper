import { useEffect, useRef, useState } from 'react'
import { api, isElectron } from '@/api'
import { AppTooltip } from '@/components/AppTooltip'
import { CliConsole } from '@/components/CliConsole'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ConnectionDialog } from '@/components/ConnectionDialog'
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
import { globalHolder, type ConnectionItem } from '@/store/global'
import { useActiveApi } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { tipProps } from '@/components/tip'
import type { RedisConnectionConfig } from '@shared/types'

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
  const [dialogInitial, setDialogInitial] = useState<RedisConnectionConfig | null>(null)
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
    setDialogInitial(connection)
    setDialogVisible(true)
  }

  return (
    <div className="shell s-app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">R</span>
          <span className="brand-name">RedisDocter</span>
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
            {!state.activeTabId ? <WelcomePanel onNewConnection={openNewConnection} /> : null}
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

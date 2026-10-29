import path from 'node:path'
import fs from 'node:fs'
import util from 'node:util'
import { BrowserWindow, Menu, app, dialog, nativeTheme, shell } from 'electron'
import { IPC } from '../shared/api'
import { registerIpcHandlers } from './ipc'
import { connectionManager } from './services/connection-manager'
import { appendErrorLog, pruneOldLogs } from './services/log-service'
import { configDir } from './services/config-path'

/**
 * 启动诊断日志（仅在设置了 REDISDOCTER_DEBUG_LOG 时写入）。
 *
 * 打包后的应用若"启动即退出"，从控制台看不到任何输出 ——
 * Electron 主进程的异常不会冒泡到 stdout。提供一个环境变量开关，
 * 把关键节点的执行轨迹落到文件，便于现场排查而不必改代码重打包。
 */
const DEBUG_LOG = process.env.REDISDOCTER_DEBUG_LOG
function trace(label: string, extra?: unknown): void {
  if (!DEBUG_LOG) return
  const line = `[${new Date().toISOString()}] ${label}${
    extra === undefined ? '' : ` ${JSON.stringify(extra)}`
  }\n`
  try {
    fs.appendFileSync(DEBUG_LOG, line, 'utf-8')
  } catch {
    // 日志写不进去也不该影响主流程
  }
}

trace('module loaded', { version: process.versions.electron, pid: process.pid })

/*
 * 主进程未捕获异常落盘（2026-10 用户需求：报错写本地 log 文件夹）。
 *
 * 双击启动的 exe 没有 stdout —— 主进程异常一旦冒泡到顶层，
 * 控制台里什么都看不到，现场排查只能靠猜。这里把
 * uncaughtException / unhandledRejection 全量写进
 * <配置目录>/logs/errors-yyyymmdd.log（与渲染层错误同文件，
 * source 字段区分层级）。
 *
 * ⚠️ 监听后 Electron 不再因未捕获异常退出（uncaughtException 语义），
 * 这正是想要的：写日志 → 继续跑，比「静默退出留一个没有线索的崩溃」
 * 更符合桌面工具的可用性要求。
 */
process.on('uncaughtException', (error) => {
  try {
    console.error('[主进程未捕获异常]', error)
    appendErrorLog({
      source: 'main',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      platform: `${process.platform}-${process.arch} / Electron ${process.versions.electron}`,
      timestamp: Date.now(),
    })
  } catch {
    /* appendErrorLog 自身已吞错；这里再兜一层确保 handler 绝不抛 */
  }
})

process.on('unhandledRejection', (reason) => {
  try {
    console.error('[主进程未处理的 Promise 拒绝]', reason)
    appendErrorLog({
      source: 'main',
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      info: 'unhandledRejection',
      platform: `${process.platform}-${process.arch} / Electron ${process.versions.electron}`,
      timestamp: Date.now(),
    })
  } catch {
    /* 同上：绝不向上抛 */
  }
})

/** 由 vite-plugin-electron 在开发模式下注入 */
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const isDev = !!DEV_SERVER_URL

/*
 * 生产调试模式：`RedisDocter.exe --rd-debug` 或环境变量 REDISDOCTER_DEBUG=1。
 *
 * 用途：打包前用生产构建测试连接（SSH 隧道、safeStorage 加密等只在
 * 打包环境复现）。开发模式天然带 DevTools，生产模式默认什么都没有 ——
 * 连接失败时界面只有一句 toast，原始错误全在主进程 stdout 里
 * （双击启动的 exe 根本没有 stdout）。
 *
 * 开启后：
 *   1. 自动打开 DevTools（与开发模式同款 detach）
 *   2. 主进程 console.log/warn/error 镜像到 <配置目录>/logs/debug.log
 *      （每次启动截断重建；与操作日志同目录，界面「打开日志目录」可达）
 *   3. F12 / Ctrl+Shift+I 随时切换（生产模式下也可手动开）
 *
 * 环境变量方式只在**首次启动**有效；单实例锁下二次启动请带 --rd-debug 参数，
 * second-instance 里会识别并给现有窗口补开调试。
 *
 * ⚠️ 参数名不能叫 --debug：那是 Chromium/node 的保留开关，
 * Electron 启动时直接报 DEP0062 退出，根本到不了应用代码。
 */
const debugMode = process.argv.includes('--rd-debug') || !!process.env.REDISDOCTER_DEBUG

let debugConsoleHooked = false

function debugLogFile(): string {
  return path.join(configDir(), 'logs', 'debug.log')
}

function appendDebugLog(line: string): void {
  try {
    fs.appendFileSync(debugLogFile(), line, 'utf-8')
  } catch {
    // 目录不可写时静默放弃 —— 调试日志不能反过来把应用拖死
  }
}

/** 幂等：安装主进程 console 镜像（终端输出保留，文件多一份带时间戳的） */
function enableDebugConsole(): void {
  if (debugConsoleHooked) return
  debugConsoleHooked = true

  fs.mkdirSync(path.dirname(debugLogFile()), { recursive: true })
  fs.writeFileSync(
    debugLogFile(),
    `# RedisDocter ${app.getVersion()} debug session ${new Date().toISOString()}\n` +
      `# platform=${process.platform} electron=${process.versions.electron} node=${process.versions.node}\n` +
      `# argv=${JSON.stringify(process.argv)}\n`,
    'utf-8',
  )

  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      const time = new Date().toISOString().slice(11, 23)
      appendDebugLog(`[${time}] ${level.toUpperCase()} ${util.format(...args)}\n`)
      original(...args)
    }
  }
  console.log(`[debug] 主进程日志镜像已开启 → ${debugLogFile()}`)
}

/** 切换 DevTools（F12 / Ctrl+Shift+I / --debug 均走这里） */
function toggleDevTools(): void {
  const contents = mainWindow?.webContents
  if (!contents) return
  if (contents.isDevToolsOpened()) contents.closeDevTools()
  else contents.openDevTools({ mode: 'detach' })
}

if (debugMode) enableDebugConsole()

/** 窗口底色跟随系统主题，避免启动瞬间出现反色闪烁 */
const BACKGROUND = { dark: '#15171c', light: '#f4f5f7' }

let mainWindow: BrowserWindow | null = null

/**
 * 是否已经确认过退出。
 *
 * 关闭主窗口默认要二次确认（避免误触把正在编辑的内容带走）。
 * 但以下两种情况不能再弹：
 *   ① 用户已点过「退出」→ 置真，后续 close 直接放行；
 *   ② 系统注销 / 关机（before-quit 由 OS 触发）→ 同样不该拦。
 * 否则会出现"点确定 → 又弹一次"的循环。
 */
let quitConfirmed = false

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 660,
    show: false,
    title: 'RedisDocter',
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    autoHideMenuBar: true,
    /*
     * 隐藏系统标题栏（Windows 上连系统按钮一起隐藏），
     * 最小化 / 最大化 / 关闭由渲染层顶栏自绘，窗口移动走 CSS 拖拽区。
     */
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 首帧渲染完成后再显示，避免白屏闪烁
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  /*
   * 最大化状态推送：自绘按钮要在 max / restore 图标间切换。
   * 渲染层挂载时用 invoke 拉一次初始值，之后靠这两条事件保持同步。
   */
  const sendWindowState = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send(IPC.windowStateChanged, { maximized: mainWindow.isMaximized() })
  }
  mainWindow.on('maximize', sendWindowState)
  mainWindow.on('unmaximize', sendWindowState)

  // 外链一律交给系统浏览器，不在应用内打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  /*
   * F12 / Ctrl+Shift+I 切换 DevTools：生产模式也可用。
   * 应用菜单已置空（Menu.setApplicationMenu(null)），Electron 默认的
   * 调试快捷键随之失效，必须自己接。只在 keyDown 时触发，
   * 忽略自动重复（按住 F12 不该反复开关）。
   */
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      toggleDevTools()
    }
  })

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER_URL as string)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
    // 生产调试模式：与开发模式同款 DevTools，方便打包前测连接
    if (debugMode) {
      mainWindow.webContents.once('devtools-opened', () =>
        console.log('[debug] DevTools 已打开（生产调试模式）'),
      )
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  }

  /*
   * 关闭前确认：用系统原生对话框而不是渲染层弹窗 ——
   * 窗口正在关闭，渲染层的弹窗会随窗口一起消失或闪烁；
   * 且此时用户可能已经切到别的应用，系统级模态才能确保被看到。
   *
   * event.preventDefault() 之后窗口保持原样；用户点「退出」时
   * 先置 quitConfirmed 再 destroy，避免 close 再次被自己拦下。
   */
  mainWindow.on('close', (event) => {
    if (quitConfirmed) return
    const win = mainWindow
    if (!win || win.isDestroyed()) return

    event.preventDefault()

    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['退出', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '退出 RedisDocter',
      message: '确定要退出 RedisDocter 吗？',
      detail: '未保存的编辑内容会丢失。',
      noLink: true,
    })

    if (choice !== 0) return

    quitConfirmed = true
    win.destroy()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// 单实例：重复启动时聚焦已有窗口
trace('before requestSingleInstanceLock')
const gotTheLock = app.requestSingleInstanceLock()
trace('requestSingleInstanceLock result', { gotTheLock })

if (!gotTheLock) {
  app.quit()

} else {
  app.on('second-instance', (_event, commandLine) => {
    if (!mainWindow) return
    /*
     * 已有实例在跑时，带 --debug 的二次启动不白来：
     * 给现有窗口补开 DevTools + 主进程日志镜像。
     * （环境变量方式在这里不可见 —— 它属于新进程，旧进程读不到，
     *  所以文档口径统一用 --debug 参数。）
     */
    if (commandLine.includes('--rd-debug')) {
      enableDebugConsole()
      if (!mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.openDevTools({ mode: 'detach' })
      }
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    trace('app ready')
    // 骨架阶段先隐藏系统菜单，后续按需改成自定义菜单
    Menu.setApplicationMenu(null)
    registerIpcHandlers()
    // 启动时清一次超出保留天数的历史日志
    pruneOldLogs()
    createMainWindow()
    trace('main window created')

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  }).catch((error) => {
    trace('whenReady failed', { error: String(error) })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  /*
   * 走到这里说明是「程序级退出」（Cmd+Q、系统注销、更新后重启），
   * 而不是用户点窗口的关闭按钮 —— 此时不该再拦一次确认。
   */
  quitConfirmed = true
  connectionManager.disconnectAll()
})

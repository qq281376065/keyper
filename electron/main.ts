import path from 'node:path'
import fs from 'node:fs'
import util from 'node:util'
import { BrowserWindow, Menu, app, nativeTheme, session, shell } from 'electron'
import { IPC } from '../shared/api'
import { registerIpcHandlers } from './ipc'
import { connectionManager } from './services/connection-manager'
import { appendErrorLog, pruneOldLogs } from './services/log-service'
import { configDir } from './services/config-path'
import { setSystemLocale, syncMainLocale } from './services/settings-store'
import { CLOSE_CONFIRM, CLOSE_HANDLED, closeSignal } from './services/close-signal'

/**
 * 启动诊断日志（仅在设置了 KEYPER_DEBUG_LOG 时写入）。
 *
 * 打包后的应用若"启动即退出"，从控制台看不到任何输出 ——
 * Electron 主进程的异常不会冒泡到 stdout。提供一个环境变量开关，
 * 把关键节点的执行轨迹落到文件，便于现场排查而不必改代码重打包。
 */
const DEBUG_LOG = process.env.KEYPER_DEBUG_LOG || process.env.REDISDOCTER_DEBUG_LOG
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

/**
 * 生产 CSP。
 *
 * 几条关键取舍（均经真实 Electron 运行时实测，见 .qa/ 下的探针）：
 *
 * · `script-src 'self'` + 内联脚本的 sha256 hash，不用 unsafe-inline。
 *   index.html 里那段「首屏主题脚本」必须同步执行（否则亮暗闪烁），
 *   用 hash 精确放行比放开整个 inline 安全得多。
 *   ⚠️ 脚本内容一旦改动，hash 必须同步更新 ——
 *   由 scripts/csp-hash.mjs 在构建时自动写入 index.html。
 *
 * · `style-src 'self'` 不含 unsafe-inline。
 *   React 的 inline style 走 CSSOM（node.style.setProperty），
 *   不受 CSP 行内样式限制；实测 42 个 [style] 元素计算值全部正确，
 *   1880 条样式规则正常加载。
 *
 * · `img-src` 保留 data:（图标内联为 data URI 的场景）。
 * · 其余一律 'none'：本应用不加载远程脚本、不嵌 iframe、
 *   不用 Worker、不提交表单。
 */
const CSP_PROD = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
].join('; ')

/**
 * 开发 CSP：Vite HMR 与 React Refresh 需要额外放行。
 *
 * · unsafe-inline / unsafe-eval：Vite 注入的客户端脚本与
 *   react-refresh 的运行时都依赖动态求值，开发态无法规避。
 * · connect-src 放行 dev server 的 http / ws，否则 HMR 连不上。
 *
 * 这套只在 isDev 生效，不会进入安装包。
 */
const CSP_DEV = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')

/*
 * 生产调试模式：`Keyper.exe --rd-debug` 或环境变量 KEYPER_DEBUG=1。
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
const debugMode =
  process.argv.includes('--rd-debug') ||
  !!process.env.KEYPER_DEBUG ||
  !!process.env.REDISDOCTER_DEBUG

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
    `# Keyper ${app.getVersion()} debug session ${new Date().toISOString()}\n` +
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

/**
 * 等渲染层弹出自绘确认框的最长时间。
 *
 * 800ms 太短：用户点 × 之后窗口会立刻被强制关掉，看起来就像"确认框从来没出现"。
 * 这个值实际衡量的是"渲染层是否还能响应"，不是"用户多久能做完决定" ——
 * 用户决定的时间不计入其中（确认框弹出后计时器就该被取消）。
 * 取 5s：既给慢机器留出渲染时间，又不至于让崩溃的页面把窗口永久卡住。
 */
const CLOSE_FALLBACK_MS = 5000

/**
 * 会话级安全加固：CSP 注入 + 权限请求全拒。
 *
 * 两件事都必须在 whenReady 之后、创建窗口之前完成，
 * 否则首个页面加载时还没有响应头改写器可用。
 */
function applySessionHardening(): void {
  applyContentSecurityPolicy()
  applyPermissionPolicy()
}

/**
 * CSP 注入（响应头方式）。
 *
 * ⚠️ 为什么还要在 index.html 里放 meta CSP：
 * 生产环境走 loadFile 的 `file://` 协议，onHeadersReceived **不会**对
 * file:// 响应生效。两条路径互补：
 *   · file://（生产）→ 由 index.html 的 <meta> 兜底
 *   · http://（开发/未来自定义协议）→ 由这里的响应头兜底
 * 任意一条缺失都会让 CSP 实质失效，所以两处都要有。
 */
function applyContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders }
    responseHeaders['Content-Security-Policy'] = [isDev ? CSP_DEV : CSP_PROD]
    callback({ responseHeaders })
  })

  trace('csp installed', { dev: isDev, devServer: DEV_SERVER_URL || null })
}

/**
 * 权限请求策略：默认全拒，仅放行剪贴板读写。
 *
 * ⚠️ 为什么必须放行剪贴板（而且必须包括 read）：
 *
 * 1. 复制是本应用的核心操作 —— 「复制键名 / 复制值 / 复制连接地址」
 *    等 16 处都走 navigator.clipboard.writeText。
 * 2. 粘贴是导入流程的入口 —— ImportUriDialog 的「从剪贴板粘贴」
 *    显式调用 navigator.clipboard.readText()。
 * 3. 关键：Chromium 的 writeText 在写入前会先发**clipboard-read**
 *    权限请求做探测（实测权限名就是 clipboard-read，不是
 *    clipboard-sanitized-write）。只放行 write 类权限，writeText 依然
 *    抛 NotAllowedError，而降级路径 document.execCommand('copy')
 *    在新版 Chromium 已废弃、同样返回 false ——
 *    结果是复制整体失效，用户只看到"复制失败，请检查剪贴板权限"。
 *
 * 因此这里放行 clipboard-read（覆盖读写两种用途）。
 * 其余（摄像头 / 麦克风 / 定位 / 通知 / MIDI / 串口 / 全屏等）一律拒绝 ——
 * 桌面数据库工具用不到。
 */
const ALLOWED_PERMISSIONS = new Set<string>(['clipboard-read', 'clipboard-sanitized-write'])

function applyPermissionPolicy(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission)
    if (!allowed) trace('permission denied', { permission })
    callback(allowed)
  })
  /*
   * checkHandler 要按权限逐项判断，不能一律 false ——
   * clipboard API 在真正发起请求前会先用它探测，一律 false
   * 会让请求根本发不出来，直接抛 NotAllowedError。
   */
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    ALLOWED_PERMISSIONS.has(permission),
  )
}

/** 兜底关闭计时器（只允许存在一个） */
let closeFallbackTimer: NodeJS.Timeout | null = null

/**
 * 外链白名单：只放行 https，且限定在受信任域。
 *
 * 与 update-service.ts 的 openUpdatePage 同一套口径 —— 那里是「检查更新」
 * 的专用入口，这里覆盖所有由渲染层发起的外链请求（window.open、
 * target=_blank 等）。两处规则必须一致，否则会出现"某个入口校验了、
 * 另一个入口漏了"的短板效应。
 *
 * 仓库已迁到 GitHub，不再放行 gitee.com。
 *
 * 拒绝时静默丢弃并写 trace：用户视角不该看到任何反馈，
 * 但排查时需要知道有被拦下的地址。
 */
const ALLOWED_EXTERNAL_HOSTS = ['github.com']

function openExternalIfSafe(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    trace('openExternal rejected: invalid url', { url: String(rawUrl).slice(0, 120) })
    return false
  }
  if (parsed.protocol !== 'https:') {
    trace('openExternal rejected: non-https', { url: parsed.href.slice(0, 120) })
    return false
  }
  if (!ALLOWED_EXTERNAL_HOSTS.includes(parsed.hostname)) {
    trace('openExternal rejected: host not allowed', { host: parsed.hostname })
    return false
  }
  void shell.openExternal(parsed.href)
  return true
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 660,
    show: false,
    title: 'Keyper',
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
      /*
       * 渲染进程沙箱。
       *
       * 开启后渲染层与 preload 都跑在 Chromium 沙箱内，拿不到完整的 Node
       * （require / process / module / Buffer 均为 undefined），只能通过
       * contextBridge 暴露的 redisApi 走 IPC。
       *
       * 前提已满足：preload 打包后只保留 require("electron")，不依赖
       * __dirname / process / 任何 node 内置模块，因此沙箱下可正常加载。
       * 实测（.qa/sandbox-ipc.js）：10 组 API 暴露完整，invoke 往返正常。
       */
      sandbox: true,
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

  /*
   * 外链一律交给系统浏览器，不在应用内打开。
   *
   * ⚠️ 这里必须校验 scheme / host，不能拿到 url 就直接 openExternal：
   * 渲染层传入的地址一旦被注入（例如某个值被当成链接渲染后点击），
   * openExternal 会把 file:// 或自定义协议直接交给系统处理。
   * 与 update-service.ts 的 openUpdatePage 保持同一套白名单口径。
   */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalIfSafe(url)
    return { action: 'deny' }
  })

  /*
   * 阻止一切应用内导航。
   *
   * 本应用是单页 file:// 应用，正常操作不会触发整页跳转；
   * 一旦发生跳转，说明渲染层被注入或出现异常链接 —— 直接拦下。
   * 开发态要放行 dev server 的 HMR 相关刷新，否则热更新会失效。
   */
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    if (url === current) return
    if (isDev && DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL)) return
    event.preventDefault()
    trace('navigation blocked', { url })
  })

  /* 禁用 <webview>：本应用不用，留着只是多一个攻击面 */
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
    trace('webview attach blocked')
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
   * 关闭前确认：交给渲染层的自绘弹窗（DialogShell），
   * 不用 dialog.showMessageBoxSync —— 原生弹窗与应用视觉是两个体系，
   * 深色主题下尤其突兀。
   *
   * 流程：
   *   ① 拦下 close，向渲染层发 IPC.appBeforeClose；
   *   ② 渲染层弹 ConfirmDialog，用户点「退出」后调 IPC.appConfirmClose；
   *   ③ 主进程置 quitConfirmed 并 destroy。
   *
   * 兜底：渲染层若没响应（页面崩了 / 还在加载），CLOSE_FALLBACK_MS 后
   * 直接放行关闭 —— 否则用户会被一个永远关不掉的窗口卡住。
   * 计时器只启动一次，避免反复点 × 累积多个定时器。
   */
  mainWindow.on('close', (event) => {
    if (quitConfirmed) return
    const win = mainWindow
    if (!win || win.isDestroyed()) return

    event.preventDefault()
    trace('close intercepted, asking renderer to confirm')

    win.webContents.send(IPC.appBeforeClose)

    if (closeFallbackTimer) return
    closeFallbackTimer = setTimeout(() => {
      closeFallbackTimer = null
      if (quitConfirmed) return
      const w = mainWindow
      if (!w || w.isDestroyed()) return
      quitConfirmed = true
      w.destroy()
    }, CLOSE_FALLBACK_MS)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })}

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
    // 首次启动 / 旧配置没有语言字段时，按操作系统语言初始化界面语言
    setSystemLocale(app.getLocale())
    // 主进程的错误文案跟随界面语言（保存设置时会再同步）
    syncMainLocale()
    // 骨架阶段先隐藏系统菜单，后续按需改成自定义菜单
    Menu.setApplicationMenu(null)
    applySessionHardening()
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

/*
 * 渲染层自绘确认框点了「退出」。
 *
 * 不用 app.emit 承载自定义事件：Electron 的 app.on 类型只接受内置事件名，
 * 'rd:confirm-close' 会直接编译失败。这里用一个独立的 EventEmitter
 * 做进程内信号总线，IPC 模块把信号打到它上面。
 */
closeSignal.on(CLOSE_CONFIRM, () => {
  if (closeFallbackTimer) {
    clearTimeout(closeFallbackTimer)
    closeFallbackTimer = null
  }
  const w = mainWindow
  if (!w || w.isDestroyed()) return
  quitConfirmed = true
  /*
   * 再断一次连接，作为最终保障。
   *
   * 渲染层在点「断开并退出」后已经逐个断开过，这里是双保险：
   * destroy 不触发 before-quit，那条 disconnectAll 兜底跑不到 ——
   * 若渲染层因异常漏断了某条，客户端会在 Redis 侧挂到 TCP 超时才回收。
   * 已断开的连接走 disconnect() 是幂等的，重复调用无副作用。
   */
  connectionManager.disconnectAll()
  w.destroy()
})

/*
 * 渲染层确认框已经弹出来了 —— 取消兜底。
 *
 * 兜底的存在意义只是"渲染层没响应时别把窗口卡死"。
 * 一旦收到回执，说明渲染层活得好好的，剩下的时间属于用户思考，
 * 不能再拿 5s 计时器替用户做决定（这正是之前"点 × 直接关掉"的原因）。
 */
closeSignal.on(CLOSE_HANDLED, () => {
  if (closeFallbackTimer) {
    clearTimeout(closeFallbackTimer)
    closeFallbackTimer = null
  }
})

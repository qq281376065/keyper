import { app } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { t } from '@shared/i18n'
import type { OperationResult, UpdateCheckResult, UpdateDownloadState } from '../../shared/types'
import { compareVersion } from '../../shared/version'

/**
 * 应用内更新（electron-updater）。
 *
 * 与 update-service.ts 的分工：
 *   · 这里负责「下载 + 安装」—— 仅打包版可用，更新源是 GitHub Releases；
 *   · update-service.ts 仍是开发态 / 自动更新不可用时的兜底检查，
 *     只告诉用户有没有新版本并打开版本页。
 *
 * 增量更新依赖 electron-builder 生成的 *.blockmap：NSIS 目标下
 * electron-updater 会做差分下载，只拉取与本地安装包不同的分块。
 * 这一步由库内部完成，这里不要改成直接下载 exe。
 */

/** 与 electron-builder.yml 的 publish 配置保持一致 */
const GITHUB_OWNER = 'qq281376065'
const GITHUB_REPO = 'keyper'
const RELEASES_PAGE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`

/**
 * 私有化 / 镜像分发入口：指向一个 generic 更新源（目录里有 latest.yml
 * 与安装包），用于公司内网或 GitHub 不可达的环境。打包时无需改代码。
 */
const FEED_URL =
  process.env.KEYPER_UPDATE_URL?.trim() || process.env.REDISDOCTER_UPDATE_URL?.trim() || ''

let initialized = false
let stateListener: ((state: UpdateDownloadState) => void) | null = null

function idleState(): UpdateDownloadState {
  return {
    phase: 'idle',
    version: null,
    percent: null,
    transferred: 0,
    total: null,
    bytesPerSecond: null,
    message: null,
  }
}

let state: UpdateDownloadState = idleState()

function setState(patch: Partial<UpdateDownloadState>): void {
  state = { ...state, ...patch }
  try {
    stateListener?.(state)
  } catch (error) {
    // 推送失败不能反过来影响下载流程
    console.error('[updater] 状态推送失败:', error)
  }
}

export function getUpdateState(): UpdateDownloadState {
  return state
}

export function onUpdateState(listener: (state: UpdateDownloadState) => void): void {
  stateListener = listener
}

/**
 * 打包版才启用。
 * 开发态没有 app-update.yml，electron-updater 会直接拒绝运行；
 * 这里提前判掉，让上层回退到 Gitee 版本页检查。
 */
export function isAutoUpdateEnabled(): boolean {
  return app.isPackaged
}

function initialize(): void {
  if (initialized) return
  initialized = true

  // 下载必须由用户显式触发：检查更新只是"看一眼"，不该悄悄吃掉流量
  autoUpdater.autoDownload = false
  // 用户没点「重启并安装」就退出时，下次启动前自动完成安装
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false

  autoUpdater.logger = {
    info: (message?: unknown) => console.log('[updater]', message),
    warn: (message?: unknown) => console.warn('[updater]', message),
    error: (message?: unknown) => console.error('[updater]', message),
    debug: (message: string) => console.log('[updater:debug]', message),
  }

  if (FEED_URL) {
    /*
     * generic 源要求目录下同时有 latest.yml 与安装包（electron-builder
     * 的产物直接上传即可）。setFeedURL 会覆盖打包时写入的 app-update.yml。
     */
    autoUpdater.setFeedURL({ provider: 'generic', url: FEED_URL })
  }

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    setState({
      phase: 'downloading',
      percent: Math.min(100, Math.round(progress.percent * 10) / 10),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
      message: null,
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    setState({
      phase: 'downloaded',
      version: info.version.replace(/^v/i, ''),
      percent: 100,
      transferred: state.total ?? state.transferred,
      bytesPerSecond: null,
      message: null,
    })
  })

  autoUpdater.on('error', (error: Error) => {
    /*
     * 只有下载中的错误才进入 error 态。检查更新失败由 check() 的
     * 返回值表达 —— 若这里也改成 error，面板关掉再打开会看到一个
     * 与"检查失败"重复且无法重试的下载错误。
     */
    if (state.phase === 'downloading') {
      setState({ phase: 'error', bytesPerSecond: null, message: error.message })
    } else {
      console.error('[updater]', error)
    }
  })
}

function releaseNotesOf(info: UpdateInfo): string | null {
  const notes = info.releaseNotes
  if (typeof notes === 'string') return notes.trim() || null
  if (Array.isArray(notes)) {
    const text = notes
      .map((entry) => (entry.note ?? '').trim())
      .filter(Boolean)
      .join('\n\n')
    return text || null
  }
  return null
}

/** 通过 electron-updater 检查更新（打包版）。失败由调用方决定是否兜底。 */
export async function checkForAutoUpdate(): Promise<UpdateCheckResult> {
  initialize()

  const currentVersion = app.getVersion()
  const result = await autoUpdater.checkForUpdates()
  const checkedAt = new Date().toISOString()

  if (!result) {
    return {
      currentVersion,
      latestVersion: currentVersion,
      hasUpdate: false,
      notes: null,
      pageUrl: RELEASES_PAGE,
      checkedAt,
      notice: null,
      canAutoUpdate: true,
      packageSize: null,
    }
  }

  const info = result.updateInfo
  const latestVersion = info.version.replace(/^v/i, '')
  const hasUpdate = result.isUpdateAvailable || compareVersion(latestVersion, currentVersion) > 0
  const packageSize = info.files.reduce((sum, file) => sum + (file.size ?? 0), 0) || null

  /*
   * 目标版本变了就清掉上一轮遗留的「已下载」态：
   * 否则界面会把旧包当成新版可用，下载也会因 phase=downloaded 被跳过。
   */
  if (state.phase === 'downloaded' && state.version !== latestVersion) {
    state = idleState()
  }

  return {
    currentVersion,
    latestVersion,
    hasUpdate,
    notes: releaseNotesOf(info),
    pageUrl: RELEASES_PAGE,
    checkedAt,
    notice: null,
    canAutoUpdate: true,
    packageSize,
  }
}

/**
 * 开始下载。version 由渲染层从检查结果传入，用于识别"目标版本已变化"。
 * 重复点击 / 面板重新打开后再次点击都应该是幂等的。
 */
export async function downloadAutoUpdate(version: string): Promise<UpdateDownloadState> {
  initialize()

  if (state.phase === 'downloading') return state
  if (state.phase === 'downloaded' && state.version === version) return state

  setState({
    phase: 'downloading',
    version,
    percent: 0,
    transferred: 0,
    total: null,
    bytesPerSecond: null,
    message: null,
  })

  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setState({ phase: 'error', bytesPerSecond: null, message })
    throw error
  }

  return state
}

/**
 * 退出应用并安装。返回 ok 后主进程很快会退出 —— 渲染层不要依赖后续交互。
 * silent=true：不再弹安装向导；forceRunAfter=true：装完自动拉起新版本。
 */
export function installAutoUpdate(): OperationResult {
  if (state.phase !== 'downloaded') {
    return { ok: false, message: t('updateService.noDownloadedUpdate') }
  }

  /*
   * 延后一拍再退出：让 IPC 的返回值先回到渲染层，
   * 否则窗口可能在 invoke 的响应发出前就被关闭。
   */
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(true, true)
    } catch (error) {
      console.error('[updater] 启动安装失败:', error)
    }
  })

  return { ok: true, message: t('updateService.installingRestart') }
}

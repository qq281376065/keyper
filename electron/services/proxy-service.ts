/**
 * 更新通道代理的应用与自动检测（主进程）。
 *
 * 应用面：
 *   · electron-updater 的下载/检查会话（partition "electron-updater"，
 *     与库内部 getNetSession() 同一个 session —— 给它 setProxy 即接管
 *     latest.yml 检查、blockmap 差分与安装包下载的全部请求）；
 *   · 兜底版本检查（update-service 的 net.request）走默认 session，
 *     同样按设置配置，两条通道行为一致。
 *
 * 代理只影响更新通道，不碰 Redis / Memcached 的 TCP 连接。
 */
import { session } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProxyDetectResult, ProxySettings } from '../../shared/types'
import { buildProxyConfig, normalizeProxyUrl, parseProxyProbe } from './proxy-rules'

const execFileAsync = promisify(execFile)

/** electron-updater 内部会话的 partition 名（与库的 NET_SESSION_NAME 一致） */
const UPDATER_PARTITION = 'electron-updater'

/**
 * 把代理设置应用到更新通道。设置保存时调用，即时生效，无需重启。
 * 两个 session 都配置：updater 专用会话 + 默认会话（兜底检查用）。
 */
export async function applyUpdateProxy(settings: ProxySettings): Promise<void> {
  const config = buildProxyConfig(settings)
  const targets = [session.fromPartition(UPDATER_PARTITION, { cache: false }), session.defaultSession]
  for (const target of targets) {
    try {
      await target.setProxy(config)
    } catch (error) {
      console.error('[proxy] 应用代理设置失败:', error)
    }
  }
}

/** 读 Windows 系统代理注册表（ProxyEnable + ProxyServer）。失败返回 null。 */
async function readWindowsSystemProxy(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const { stdout: enableOut } = await execFileAsync('reg', ['query', key, '/v', 'ProxyEnable'])
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(enableOut)) return null
    const { stdout: serverOut } = await execFileAsync('reg', ['query', key, '/v', 'ProxyServer'])
    const match = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(serverOut)
    return match ? match[1]!.trim() : null
  } catch {
    return null
  }
}

/**
 * 自动检测本地代理设置，返回可填充的候选地址。
 *
 * 探测顺序（先具体后兜底）：
 *   1. Windows 注册表 ProxyServer（用户显式配置的系统代理，最可靠）
 *   2. 环境变量 HTTPS_PROXY / HTTP_PROXY（CLI 场景常见）
 *   3. session.resolveProxy（Chromium 视角的系统代理，含 PAC 结果）
 *
 * 检测用 GitHub 更新源做目标 URL —— 代理要服务的正是这条通道。
 */
export async function detectLocalProxy(): Promise<ProxyDetectResult> {
  /* 1. 系统注册表 */
  const registry = await readWindowsSystemProxy()
  if (registry) {
    const url = parseProxyProbe(registry)
    if (url) return { found: true, url, source: 'system' }
  }

  /* 2. 环境变量 */
  const envProxy =
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    ''
  if (envProxy) {
    const check = normalizeProxyUrl(envProxy)
    if (check.ok) return { found: true, url: check.normalized, source: 'env' }
  }

  /* 3. Chromium 会话解析（PAC / 系统设置） */
  try {
    const probe = await session.defaultSession.resolveProxy('https://github.com')
    const url = parseProxyProbe(probe)
    if (url) return { found: true, url, source: 'session' }
  } catch (error) {
    console.error('[proxy] resolveProxy 检测失败:', error)
  }

  return { found: false, url: null, source: null }
}
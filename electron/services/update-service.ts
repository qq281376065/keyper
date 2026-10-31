import { app, shell } from 'electron'
import { net } from 'electron'
import { t } from '@shared/i18n'
import type { UpdateCheckResult } from '../../shared/types'
import { compareVersion } from '../../shared/version'

export { compareVersion }

/**
 * 检查更新。
 *
 * 数据源：Gitee 公开 API 的 tags 列表（本仓库托管在 Gitee，且没有用
 * 正式的 Release 发布流程，tags 是最稳定的"已发布版本"事实来源）。
 * 用 tags 而不是 releases/latest：后者在本仓库返回 404。
 *
 * 设计取舍：
 *   · 走主进程的 net 模块而不是 node:http —— 自动继承系统代理设置，
 *     公司网络下走代理的用户才连得出去；
 *   · 只读、只比较、不下载、不自动安装 —— 自动更新需要签名与差分包，
 *     不在当前范围，这里只负责"告诉你有没有新版本 + 打开下载页"。
 */

const OWNER = 'jack_ssdddd'
const REPO = 'redis-docter'
const TIMEOUT_MS = 8000

interface GiteeTag {
  name?: string
  message?: string | null
}

/** 带超时的 GET JSON。超时与网络错误统一转成可读的中文原因。 */
async function getJson<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: { ok: true; data: T } | { ok: false; error: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: t('updateService.requestTimedOut', { seconds: TIMEOUT_MS / 1000 }),
      })
      try {
        request.abort()
      } catch {
        /* 已结束则忽略 */
      }
    }, TIMEOUT_MS)

    let request: Electron.ClientRequest
    try {
      request = net.request({ method: 'GET', url })
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : t('updateService.failedSendRequest') })
      return
    }

    request.setHeader('Accept', 'application/json')
    request.setHeader('User-Agent', `Keyper/${app.getVersion()}`)

    request.on('response', (response) => {
      // 3xx 交给 net 自动跟随；这里只处理 2xx 与明确的失败状态
      if (response.statusCode < 200 || response.statusCode >= 300) {
        finish({ ok: false, error: t('updateService.serverReturnedStatus', { status: response.statusCode }) })
        return
      }

      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        try {
          finish({ ok: true, data: JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T })
        } catch {
          finish({ ok: false, error: t('updateService.responseNotValidJson') })
        }
      })
      response.on('error', () => finish({ ok: false, error: t('updateService.failedReadResponse') }))
    })

    request.on('error', (error) => {
      finish({ ok: false, error: error.message || t('updateService.networkRequestFailed') })
    })

    request.end()
  })
}

/**
 * 执行一次版本检查。
 *
 * 永不 reject：网络问题应表现为"检查失败 + 原因"，而不是让渲染层
 * 掉进 catch 里只能显示一句笼统的"检查失败"。
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()

  const res = await getJson<GiteeTag[]>(`https://gitee.com/api/v5/repos/${OWNER}/${REPO}/tags`)
  // 抛错由 IPC 的 handle() 统一转成 { ok:false, error }，不在这里自造响应壳
  if (!res.ok) throw new Error(res.error)

  if (!Array.isArray(res.data)) throw new Error(t('updateService.unexpectedVersionListFormat'))


  /*
   * tags 返回顺序不保证（Gitee 按创建时间倒序，但不承诺），
   * 这里自己挑出最大的版本号，避免"最新 tag 恰好不是最大版本"时误报。
   */
  const versions = res.data
    .map((tag) => (typeof tag.name === 'string' ? tag.name.replace(/^v/i, '').trim() : ''))
    .filter((name) => /^\d+(\.\d+)*$/.test(name))

  if (!versions.length) {
    return {
      currentVersion,
      latestVersion: currentVersion,
      hasUpdate: false,
      notes: null,
      pageUrl: `https://gitee.com/${OWNER}/${REPO}/tags`,
      checkedAt: new Date().toISOString(),
      notice: t('updateService.noVersionTagsRepositoryYet'),
      canAutoUpdate: false,
      packageSize: null,
    }
  }

  const latestVersion = versions.reduce((max, cur) => (compareVersion(cur, max) > 0 ? cur : max), versions[0]!)
  const latestTag = res.data.find((tag) => (tag.name ?? '').replace(/^v/i, '').trim() === latestVersion)

  return {
    currentVersion,
    latestVersion,
    hasUpdate: compareVersion(latestVersion, currentVersion) > 0,
    notes: latestTag?.message?.trim() || null,
    pageUrl: `https://gitee.com/${OWNER}/${REPO}/tags`,
    checkedAt: new Date().toISOString(),
    notice: null,
    canAutoUpdate: false,
    packageSize: null,
  }
}

/**
 * 用系统默认浏览器打开指定地址。
 *
 * 只放行 https 且限定在受信任域：渲染层传来的 url 一旦被注入恶意值，
 * shell.openExternal 会直接把用户带到任意站点。这里是唯一的白名单关口。
 */
export async function openUpdatePage(url: string): Promise<{ ok: boolean; message: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, message: t('updateService.invalidAddressFormat') }
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, message: t('updateService.onlyHttpsAddressesOpened') }
  }

  const allowedHosts = ['gitee.com', 'github.com']
  if (!allowedHosts.includes(parsed.hostname)) {
    return { ok: false, message: t('updateService.addressOutsideAllowedRange') }
  }

  await shell.openExternal(url)
  return { ok: true, message: t('updateService.openedBrowser') }
}

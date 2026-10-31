import { app, shell } from 'electron'
import { net } from 'electron'
import { t } from '@shared/i18n'
import type { UpdateCheckResult } from '../../shared/types'
import { compareVersion } from '../../shared/version'

export { compareVersion }

/**
 * 检查更新（兜底通道）。
 *
 * 数据源：GitHub 公开 API 的 tags 列表。
 *
 * 为什么是 tags 而不是 releases/latest：
 * 实测本仓库 `GET /releases/latest` 返回 404、`GET /releases` 返回空数组 ——
 * 发版走的是「打 tag + electron-builder 上传资产」，没有手建 Release 记录，
 * 因此 tags 才是"已发布版本"的事实来源。
 *
 * 为什么需要这条兜底：
 * 打包版优先走 electron-updater（读 latest.yml，能下载能增量）；
 * 开发态、或更新源不可达时回退到这里，保证"有没有新版"总有一个答案，
 * 而不是只剩一条网络错误。
 *
 * 设计取舍：
 *   · 走主进程的 net 模块而不是 node:http —— 自动继承系统代理设置，
 *     公司网络下走代理的用户才连得出去；
 *   · 只读、只比较、不下载、不自动安装 —— 这里只负责
 *     "告诉你有没有新版本 + 打开下载页"。
 */

const OWNER = 'qq281376065'
const REPO = 'keyper'
const TIMEOUT_MS = 8000

/**
 * GitHub tags 条目。
 *
 * 注意：与 Gitee 不同，GitHub 的 tags 接口**不返回** tag message
 * （annotation 需另取 /git/refs 或 /git/tags），因此这里没有 notes 字段。
 * 版本说明由 electron-updater 那条主路径提供。
 */
interface GithubTag {
  name?: string
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
/**
 * 兜底检查结果的短时缓存。
 *
 * GitHub 未认证 API 限流为 60 次/小时/IP。用户连点「检查更新」、
 * 或多开窗口时容易把这个额度打满，届时接口返回 403，
 * 用户看到的是"检查失败"而非"没有新版本"——体验上差很多。
 *
 * 60 秒内的重复请求直接复用上次结果，既省额度也更快。
 * 只缓存成功结果：失败必须让用户能立刻重试。
 */
const CACHE_TTL_MS = 60_000
let cached: { at: number; value: UpdateCheckResult } | null = null

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()

  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ...cached.value, currentVersion }
  }

  const tagsUrl = `https://api.github.com/repos/${OWNER}/${REPO}/tags`
  const pageUrl = `https://github.com/${OWNER}/${REPO}/tags`

  const res = await getJson<GithubTag[]>(tagsUrl)
  // 抛错由 IPC 的 handle() 统一转成 { ok:false, error }，不在这里自造响应壳
  if (!res.ok) throw new Error(res.error)

  if (!Array.isArray(res.data)) throw new Error(t('updateService.unexpectedVersionListFormat'))

  /*
   * tags 返回顺序不保证（GitHub 按提交时间倒序，但不承诺），
   * 这里自己挑出最大的版本号，避免"最新 tag 恰好不是最大版本"时误报。
   *
   * tag 名可能带 v 前缀（本仓库目前不带，历史 tag 形如 1.0.7），
   * 统一剥掉再比较，两种命名都能识别。
   */
  const versions = res.data
    .map((tag) => (typeof tag.name === 'string' ? tag.name.replace(/^v/i, '').trim() : ''))
    .filter((name) => /^\d+(\.\d+)*$/.test(name))

  const result: UpdateCheckResult = versions.length
    ? (() => {
        const latestVersion = versions.reduce(
          (max, cur) => (compareVersion(cur, max) > 0 ? cur : max),
          versions[0]!,
        )
        return {
          currentVersion,
          latestVersion,
          hasUpdate: compareVersion(latestVersion, currentVersion) > 0,
          /*
           * GitHub 的 tags 接口不返回 tag message，此处恒为 null。
           * 版本说明由 electron-updater 主路径（读 latest.yml 与 Release）
           * 提供；兜底通道只回答"有没有新版"。
           */
          notes: null,
          pageUrl,
          checkedAt: new Date().toISOString(),
          notice: null,
          canAutoUpdate: false,
          packageSize: null,
        }
      })()
    : {
        currentVersion,
        latestVersion: currentVersion,
        hasUpdate: false,
        notes: null,
        pageUrl,
        checkedAt: new Date().toISOString(),
        notice: t('updateService.noVersionTagsRepositoryYet'),
        canAutoUpdate: false,
        packageSize: null,
      }

  cached = { at: Date.now(), value: result }
  return result
}

/**
 * 用系统默认浏览器打开指定地址。
 *
 * 只放行 https 且限定在受信任域：渲染层传来的 url 一旦被注入恶意值，
 * shell.openExternal 会直接把用户带到任意站点。这里是唯一的白名单关口。
 *
 * 仓库已迁到 GitHub，不再放行 gitee.com —— 少一个域就少一个可被利用的出口。
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

  const allowedHosts = ['github.com']
  if (!allowedHosts.includes(parsed.hostname)) {
    return { ok: false, message: t('updateService.addressOutsideAllowedRange') }
  }

  await shell.openExternal(url)
  return { ok: true, message: t('updateService.openedBrowser') }
}

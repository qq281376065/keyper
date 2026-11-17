import { api, isElectron } from '@/api'

/**
 * 项目仓库地址（单一来源）。
 *
 * 顶栏品牌区的 GitHub 图标与主页的「源码仓库」按钮共用这一个常量；
 * 与 package.json 的 repository.url、electron/services/update-service.ts
 * 的 OWNER/REPO 指向同一个仓库，改仓库时三处需同步。
 */
export const REPO_URL = 'https://github.com/qq281376065/keyper'

/**
 * 用系统默认浏览器打开仓库页。
 *
 * Electron 内走 api.update.openPage —— 主进程有 https + github.com
 * 白名单校验（update-service.openUpdatePage），不在渲染层直接开链接；
 * 纯浏览器预览（mock）没有 IPC 桥，降级为 window.open。
 */
export function openRepoPage(): void {
  if (isElectron) {
    void api.update.openPage(REPO_URL)
  } else {
    window.open(REPO_URL, '_blank', 'noopener')
  }
}
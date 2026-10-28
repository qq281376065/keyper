import { api, isElectron } from '@/api'

/** 版本号单一来源：package.json（构建期由 vite 注入） */
/*
 * 构建期注入的版本号（单一来源：package.json）。
 * 这里用 declare 显式声明，避免依赖全局 d.ts 的加载顺序。
 */
declare const __APP_VERSION__: string
export const APP_VERSION: string = __APP_VERSION__

/**
 * 渲染层错误落盘。
 *
 * 携带版本与运行时信息，方便对照用户报错的发布版排查。
 * 静音窗只挡横幅重弹，不挡落盘 —— 文件里的记录必须完整。
 * fire-and-forget：落盘失败不影响错误边界本身。
 */
export function reportRendererError(error: unknown, info: string): void {
  const text = error instanceof Error ? error.message : String(error)
  try {
    void api.log
      .reportError({
        source: 'renderer',
        message: text,
        stack: error instanceof Error ? error.stack : undefined,
        info,
        version: APP_VERSION,
        platform: navigator.userAgent,
        timestamp: Date.now(),
      })
      .catch(() => {})
  } catch {
    /* api 不可用时静默 —— console 已留痕 */
  }
}

export const electronRuntime = isElectron

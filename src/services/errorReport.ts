/*
 * 这里刻意**不在模块顶层** import { api, isElectron } from '@/api'。
 *
 * 依赖链是环形的：
 *   api/index.ts → api/mock.ts → services/errorReport.ts → api/index.ts
 * mock.ts 需要 APP_VERSION（本文件导出），而本文件在顶层取 api，
 * 于是浏览器预览（无 preload 桥、走 mock 分支）时，api/index.ts 的
 * `export const isElectron` 尚未初始化就被读取，抛
 *   Cannot access 'isElectron' before initialization
 * 整个应用白屏 —— 表现为 `npm run dev:web` 一直是空的。
 *
 * 解法：改成运行时惰性引用。错误上报是低频路径，多一次 require 的
 * 开销可忽略；isElectron 用函数包装，避免在模块求值期读取。
 */
import type { RedisDesktopApi } from '@shared/api'

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
    // 惰性取 api：见文件头关于循环依赖的说明
    const api = (require('@/api') as { api: RedisDesktopApi }).api
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

/**
 * 是否运行在 Electron 容器内。
 * 用函数而不是常量：常量会在模块求值期读取 '@/api'，重新引入循环依赖问题。
 */
export function isElectronRuntime(): boolean {
  return (require('@/api') as { isElectron: boolean }).isElectron
}

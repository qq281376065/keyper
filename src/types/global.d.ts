import type { RedisDesktopApi } from '@shared/api'

declare global {
  interface Window {
    redisApi?: RedisDesktopApi
  }
}

export {}

/** 构建期注入的版本号（单一来源：package.json） */
declare const __APP_VERSION__: string

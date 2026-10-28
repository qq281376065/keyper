/*
 * vitest 单元测试配置。
 *
 * 独立成文件而不并入 vite.config.ts 的原因：后者挂载了 vite-plugin-electron，
 * vitest 加载时会尝试编译主进程并可能拉起副作用；单元测试只需要同样的
 * 路径别名与 node 环境（被测对象全部是零副作用纯函数模块）。
 */
import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, 'shared'),
      '@electron': path.resolve(__dirname, 'electron'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.spec.ts'],
    environmentMatchGlobs: [
      /* searchHistory 用 renderHook 驱动 React hook，需要 DOM */
      ['tests/unit/searchHistory.spec.ts', 'jsdom'],
    ],
  },
})
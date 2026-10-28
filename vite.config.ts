import path from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron/simple'

export default defineConfig(({ command, mode }) => {
  const isBuild = command === 'build'
  /**
   * mode=web：只启动 Vite 开发服务器，不编译主进程、也不拉起 Electron。
   * 用于在浏览器里快速调试渲染层（数据自动走 src/api/mock.ts）。
   * 命令：npm run dev:web
   */
  const webOnly = mode === 'web'
  /* 版本号单一来源：构建期注入，避免以往「6 处手同步」的坑 */
  const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as {
    version: string
  }

  return {
    // 渲染进程资源使用相对路径，保证 file:// 协议下可正常加载
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
        '@shared': path.resolve(__dirname, 'shared'),
      },
    },
    plugins: [
      react(),
      /* Tailwind v4: only for shadcn / Cult UI components under components/ui.
         Existing UI keeps src/styles; preflight is disabled so legacy CSS is untouched. */
      tailwindcss(),
      ...(webOnly
        ? []
        : [
            electron({
              // 主进程
              main: {
                entry: 'electron/main.ts',
                vite: {
                  build: {
                    outDir: 'dist-electron',
                    minify: isBuild,
                    sourcemap: !isBuild,
                    rollupOptions: {
                      // ioredis 为纯 JS 依赖，交给 Node 运行时 require，避免打包异常
                      /*
                       * ssh2 依赖可选原生模块（cpu-features）与自己的流实现，
                       * 打进 bundle 会破坏其内部相对路径解析导致运行时崩溃，
                       * 因此与 ioredis 一样保持 external，由 node_modules 提供。
                       */
                      external: ['electron', 'ioredis', 'ssh2'],
                      output: {
                        format: 'cjs',
                        entryFileNames: '[name].js',
                      },
                    },
                  },
                },
              },
              // 预加载脚本：强制 CJS，保证 contextBridge 在沙箱关闭时可用
              preload: {
                input: 'electron/preload.ts',
                vite: {
                  build: {
                    outDir: 'dist-electron',
                    minify: isBuild,
                    sourcemap: !isBuild,
                    rollupOptions: {
                      external: ['electron'],
                      output: {
                        format: 'cjs',
                        entryFileNames: '[name].js',
                      },
                    },
                  },
                },
              },
            }),
          ]),
    ],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: false,
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: !isBuild,
    },
  }
})

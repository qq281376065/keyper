/**
 * 渲染进程入口（React 版）。
 *
 * 与 Vue 版的差异只有两处：
 *   1. createRoot 挂到 #root（index.html 已同步改 id）；
 *   2. 错误边界由 <ErrorBoundary> 承担，替代 onErrorCaptured。
 * 主题首帧防闪烁仍在 index.html 的内联脚本里完成，此处只做后续同步。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/main.css'
import '@/styles/components.css'
/* Tailwind layer for components/ui (shadcn + Cult UI). Loaded after the
   hand-written sheets so utility classes win inside those components only. */
import '@/styles/tailwind.css'
import { App } from '@/App'
import { applyToDom } from '@/services/settings'
import { applyTheme, migrateThemeFromStorage } from '@/services/theme'
import { reportRendererError } from '@/services/errorReport'

/** 先应用一次设置与主题：设置是异步读盘的，但首帧不能等 */
applyToDom()
migrateThemeFromStorage()
applyTheme()

/*
 * 未捕获异常与未处理的 Promise 拒绝统一上报（与主进程 errors-yyyymmdd.log 同文件）。
 * App 内部的错误边界负责"显示横幅"，这里负责"落盘"——
 * 两者职责不同：渲染函数之外抛出的错误不会被边界捕获。
 */
window.addEventListener('error', (event) => {
  reportRendererError(event.error ?? event.message, 'window.onerror')
})
window.addEventListener('unhandledrejection', (event) => {
  reportRendererError(event.reason, 'unhandledrejection')
})

const container = document.getElementById('root')
if (!container) throw new Error('#root 容器缺失')

/*
 * 不加 StrictMode：
 * 该项目大量依赖「effect 只执行一次」的语义（如会话建立后的初次加载、
 * 搜索进度监听的模块级注册）。StrictMode 的双调用会在开发态重复发起
 * IPC 请求、重复注册监听，掩盖真实行为。
 */
void StrictMode

/*
 * React 19 不再把根级渲染错误重新抛给 window.onerror —— 未接 onUncaughtError
 * 时只打 console。这里落盘到与 ErrorBoundary / window.onerror 同一日志。
 * 被边界接住的错误仍由 ErrorBoundary 上报，不接 onCaughtError，避免重复记录。
 */
createRoot(container, {
  onUncaughtError: (error, errorInfo) => {
    console.error('[根级渲染错误]', errorInfo.componentStack, error)
    reportRendererError(error, 'root.onUncaughtError')
  },
}).render(<App />)

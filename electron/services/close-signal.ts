import { EventEmitter } from 'node:events'

/**
 * 主进程内部的信号总线。
 *
 * 为什么需要它：IPC 模块拿不到 main.ts 里的 mainWindow / quitConfirmed
 * （都是模块私有变量），而退出动作必须由持有窗口引用的 main.ts 执行。
 * 直接 app.emit('自定义事件') 也不行 —— Electron 的 app.on 类型只接受
 * 内置事件名，自定义字符串会编译失败。
 *
 * 用一个独立 EventEmitter 做单进程内的广播，两边都只依赖这个模块，
 * 不用把窗口引用或退出状态提升成全局变量。
 */
export const closeSignal = new EventEmitter()

/** 渲染层确认退出了 */
export const CLOSE_CONFIRM = 'confirm'

/** 渲染层已弹出确认框，主进程应取消兜底强制关闭 */
export const CLOSE_HANDLED = 'handled'

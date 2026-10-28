/*
 * 标签失焦信号：浮层（portal 到 body 的菜单 / tooltip）必须随之关闭。
 *
 * 问题来源：ValueViewer 的行右键菜单、KeyBrowser 的键右键菜单都用
 * createPortal 挂到 <body>，物理上不在本标签的 DOM 子树里。
 * 标签用 display:none 隐藏时，子树内的元素会一起消失，
 * 但这些浮层仍然挂在 body 上 → 切换标签后上一个标签的菜单
 * 原地留在屏幕上，而且它承载的是上一个连接的数据，
 * 用户看到的现象就是「右侧面板没跟着切换连接」。
 *
 * Vue 原版的 Teleport 也是同样的物理结构，但 Vue 的响应式让
 * 这些菜单跟随组件状态；React 移植后菜单状态是组件本地 state，
 * 隐藏标签不卸载、不重渲染，于是浮层残留。
 *
 * 做法：Workspace 在 hidden 变 true 时递增一个计数，
 * 子树通过本 hook 监听计数变化并执行回调（关闭全部浮层）。
 */
import { createContext, useContext, useEffect, useRef } from 'react'

/** Workspace 注入的失焦计数（无 Provider 时为 0，页面级浮层不受影响） */
export const BlurTickContext = createContext(0)

/**
 * 标签失焦时执行 onBlur。
 * @param onBlur 关闭本组件管理的全部浮层；需为稳定引用或接受最新闭包
 */
export function useTabBlur(onBlur: () => void): void {
  const tick = useContext(BlurTickContext)
  const saved = useRef(onBlur)
  saved.current = onBlur

  useEffect(() => {
    /* 首次挂载的 tick 是初值，不该当作「失焦」触发 */
    if (tick === 0) return
    saved.current()
  }, [tick])
}

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { tipHolder, type TipPlacement } from './tip'
import { useObservable } from '@/store/subscription'

/**
 * 全局 tooltip 渲染层。在 App 挂载一次即可。
 *
 * 定位策略：
 * - `position: fixed` + 直接写 top/left，不参与文档流，不受父级
 *   `overflow: hidden` 裁剪（键列表、表格容器都有这种裁剪）。
 * - 进入时先量取真实尺寸，再决定最终位置 —— 因为「上方放不下就翻到
 *   下方」的判断必须以实际气泡高度为前提，而文本换行后的高度只有
 *   渲染完才知道。
 * - 因此先以 `visibility: hidden` 完成一次布局，下一帧再显形，
 *   避免气泡从旧位置"飞"到新位置（闪烁）。
 */

/** 气泡与锚点之间的间距 */
const GAP = 8
/** 与视口边缘的最小留白 */
const EDGE = 6
/** 文本最大宽度，超过则换行 */
const MAX_WIDTH = 320

export function AppTooltip() {
  /*
   * 订阅：tipHolder 是响应式 store，showTip/hideTip 的每次写入都要
   * 触发本组件重渲染 —— 不订阅的话气泡永远停在初始 invisible 状态
   * （React 不会像 Vue 模板那样自动收集依赖）。
   */
  useObservable(tipHolder)
  const tip = tipHolder.store
  const ref = useRef<HTMLDivElement | null>(null)
  /** 计算前的临时位置：定位在视口外，避免未定位时出现在左上角 */
  const [pos, setPos] = useState({ top: -9999, left: -9999 })
  /** 真正可以显示时才置 true —— 先量后定位，防止首帧跳位 */
  const [placed, setPlaced] = useState(false)

  /**
   * 计算并写入坐标。
   *
   * 翻转规则：优先使用传入的 placement；若该方向空间不足，
   * 则尝试相反方向；两侧都不足时仍用原方向（此时会贴近边缘，
   * 由 EDGE 保证不完全出界）。
   */
  function place(): void {
    const el = ref.current
    const anchor = tip.anchor
    if (!el || !anchor) return

    // 元素已从 DOM 摘除（v-if / 条件渲染更新）时没有可用坐标
    if (!anchor.isConnected) {
      setPlaced(false)
      return
    }

    const rect = anchor.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    /** 各方向可用的剩余空间 */
    const space = {
      top: rect.top - EDGE,
      bottom: vh - rect.bottom - EDGE,
      left: rect.left - EDGE,
      right: vw - rect.right - EDGE,
    }

    /** 该方向能否完整容纳气泡 */
    const fits: Record<TipPlacement, boolean> = {
      top: space.top >= box.height + GAP,
      bottom: space.bottom >= box.height + GAP,
      left: space.left >= box.width + GAP,
      right: space.right >= box.width + GAP,
    }

    const opposite: Record<TipPlacement, TipPlacement> = {
      top: 'bottom',
      bottom: 'top',
      left: 'right',
      right: 'left',
    }

    const preferred = tip.placement
    const finalPlacement =
      fits[preferred] || !fits[opposite[preferred]] ? preferred : opposite[preferred]

    let top = 0
    let left = 0

    if (finalPlacement === 'top' || finalPlacement === 'bottom') {
      // 水平居中于锚点，再钳制进视口
      left = rect.left + rect.width / 2 - box.width / 2
      left = Math.max(EDGE, Math.min(left, vw - box.width - EDGE))
      top = finalPlacement === 'top' ? rect.top - box.height - GAP : rect.bottom + GAP
    } else {
      // 垂直居中于锚点，再钳制进视口
      top = rect.top + rect.height / 2 - box.height / 2
      top = Math.max(EDGE, Math.min(top, vh - box.height - EDGE))
      left = finalPlacement === 'left' ? rect.left - box.width - GAP : rect.right + GAP
    }

    setPos({ top: Math.round(top), left: Math.round(left) })
    setPlaced(true)
  }

  /*
   * 内容或锚点变化时重新定位。
   *
   * 必须等 DOM 提交后再量尺寸：effect 内 ref 上已经是新文本，
   * 但浏览器尚未完成布局，需要下一帧（rAF）才能量到正确高度。
   * 量出旧高度会导致位置偏移（表现为气泡与图标错开半行）。
   */
  useEffect(() => {
    if (!tip.visible) {
      setPlaced(false)
      return
    }
    // 先隐藏再量，避免旧位置闪现
    setPlaced(false)
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(place)
    })
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tip.visible, tip.text, tip.anchor, tip.placement, tip.nowrap])

  if (!tip.visible || !tip.text) return null

  return createPortal(
    <div
      ref={ref}
      className={`app-tip${tip.visible && placed ? ' is-visible' : ''}${!tip.nowrap ? ' is-multiline' : ''} s-app-tooltip`}
      style={{ top: `${pos.top}px`, left: `${pos.left}px`, maxWidth: `${MAX_WIDTH}px` }}
      role="tooltip"
    >
      {tip.text}
    </div>,
    document.body,
  )
}

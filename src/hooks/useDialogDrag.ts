import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 弹窗拖动。
 *
 * 用法：把 `style` 绑到 `.dialog`，把 `onDragStart` 绑到标题栏的 `onMouseDown`。
 *
 * 设计要点：
 * - **位移用 transform 而非 top/left**：不影响文档流、不触发重排，
 *   且不会与 `.dialog` 已有的居中方式（flex 居中）冲突。
 * - **只由标题栏触发**：内容区常有输入框与文本选择，全局拖动会让它们无法用鼠标划过。
 * - **限制在视口内**：把窗口拖出屏幕后按钮就点不到了，因此按弹窗尺寸钳制位移范围。
 * - **拖动中给 body 加类**：锁定全局光标并禁用文字选中（否则拖太快会选中文字）。
 */
export interface DialogDrag {
  /** 绑到 .dialog 的 style */
  style: Record<string, string>
  /** 绑到 .dialog-head 的 onMouseDown */
  onDragStart: (event: React.MouseEvent) => void
  /** 复位位置（弹窗重新打开时调用，避免沿用上次的位移） */
  resetDrag: () => void
  /** 当前是否正在拖动（可用于切换光标样式） */
  dragging: boolean
}

export function useDialogDrag(): DialogDrag {
  /** 累积位移：从弹窗初始居中位置起的偏移量 */
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)

  /** 拖动上下文：起点与起始位移 */
  const start = useRef<{ x: number; y: number; baseX: number; baseY: number } | null>(null)
  /** 被拖动的弹窗元素，用于读取实际尺寸做边界钳制 */
  const dialogEl = useRef<HTMLElement | null>(null)
  const offsetRef = useRef({ x: 0, y: 0 })
  offsetRef.current = offset

  const onMove = useCallback((event: MouseEvent) => {
    const ctx = start.current
    if (!ctx) return

    let nextX = ctx.baseX + (event.clientX - ctx.x)
    let nextY = ctx.baseY + (event.clientY - ctx.y)

    // 边界钳制：保证弹窗始终有足够区域留在视口内可被操作。
    // 以「初始居中位置」为基准计算允许的位移范围，因此需要先知道弹窗尺寸。
    const el = dialogEl.current
    if (el) {
      const rect = el.getBoundingClientRect()
      /*
       * rect 已包含当前 transform，所以「未位移时的位置」= rect - 当前位移。
       * 由该基准位置反推：位移多少会让弹窗的左/右/上/下边缘越界。
       * 留 8px 余量，避免贴边后边框被判为不可见。
       */
      const baseLeft = rect.left - offsetRef.current.x
      const baseTop = rect.top - offsetRef.current.y
      const margin = 8
      const minX = margin - baseLeft
      const maxX = window.innerWidth - margin - (baseLeft + rect.width)
      const minY = margin - baseTop
      const maxY = window.innerHeight - margin - (baseTop + rect.height)
      // 弹窗比视口还大时不钳制（否则 min > max 会让它跳位）
      if (minX <= maxX) nextX = Math.min(maxX, Math.max(minX, nextX))
      if (minY <= maxY) nextY = Math.min(maxY, Math.max(minY, nextY))
    }

    setOffset({ x: nextX, y: nextY })
  }, [])

  const onUp = useCallback(() => {
    start.current = null
    setDragging(false)
    document.body.classList.remove('dialog-dragging')
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }, [onMove])

  function onDragStart(event: React.MouseEvent): void {
    // 只响应左键；右键与中键不参与拖动
    if (event.button !== 0) return

    // 从标题栏上的按钮（关闭 ✕）或输入控件按下时不拖动，否则点关闭会变成拖窗口
    const target = event.target as HTMLElement | null
    if (target?.closest('button, input, select, textarea, a')) return

    dialogEl.current = (event.currentTarget as HTMLElement)?.closest('.dialog') ?? null

    // 阻止默认行为：否则拖动中文本会被整片选中（标题栏文字、弹窗内文字）
    event.preventDefault()
    start.current = { x: event.clientX, y: event.clientY, baseX: offset.x, baseY: offset.y }
    document.body.classList.add('dialog-dragging')
    setDragging(true)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const resetDrag = useCallback(() => setOffset({ x: 0, y: 0 }), [])

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('dialog-dragging')
    }
  }, [onMove, onUp])

  /* 与 Vue 版一致：始终输出 transform（零位移时也写 0px），
     避免某些浏览器下 flex 居中与 transform 交替导致亚像素抖动 */
  const style = { transform: `translate(${offset.x}px, ${offset.y}px)` }

  return { style, onDragStart, resetDrag, dragging }
}

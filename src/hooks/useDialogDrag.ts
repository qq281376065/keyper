import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 弹窗拖动。
 *
 * 用法：把 `style` 绑到 `.dialog`，把 `onDragStart` 绑到标题栏的 `onMouseDown`。
 *
 * 设计要点：
 * - **位移用 transform 而非 top/left**：不影响文档流、不触发重排，
 *   且不会与 `.dialog` 已有的居中方式（translate -50%/-50%）冲突。
 * - **拖动中不走 React 渲染**：mousemove 频率可达 120Hz，经 setState → 重渲染
 *   → 提交 DOM 至少丢 1-2 帧；这里直接写元素 style，松手时才同步回 state。
 *   这是"拖动跟手"的关键 —— 实测原先一次拖动会落后指针约 30-60ms。
 * - **拖动结束后去掉过渡**：`DialogContent` 自带 `duration-200`（transition-all），
 *   若不清掉，拖动时每次 transform 变化都要缓动 200ms，表现为明显的拖尾。
 * - **只由标题栏触发**：内容区常有输入框与文本选择，全局拖动会让它们无法用鼠标划过。
 * - **限制在视口内**：把窗口拖出屏幕后按钮就点不到了，因此按弹窗尺寸钳制位移范围。
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
  /** 累积位移：从弹窗初始居中位置起的偏移量。仅在拖动结束时同步一次 */
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)

  /** 拖动上下文：起点与起始位移 */
  const start = useRef<{ x: number; y: number; baseX: number; baseY: number } | null>(null)
  /** 被拖动的弹窗元素 */
  const dialogEl = useRef<HTMLElement | null>(null)
  /** 当前位移的即时值（不依赖 state，避免拖动中的读取错位） */
  const offsetRef = useRef({ x: 0, y: 0 })
  /**
   * 该弹窗是否靠 translate(-50%,-50%) 居中。
   * 拖动开始时探测一次并缓存：拖动过程中我们自己会改 translate，
   * 再探测就测不出来了。
   */
  const centeredRef = useRef(false)

  /**
   * 直接写 transform 到元素。
   *
   * 同时关掉 transition：DialogContent 带 `duration-200`，那是给开合动画用的；
   * 拖动是"指针跟随"操作，任何缓动都会被感知为延迟。
   */
  const apply = useCallback((x: number, y: number) => {
    const el = dialogEl.current
    if (!el) return
    el.style.transition = 'none'
    /*
     * 两种居中方式必须分开处理，否则会把弹窗甩出屏幕：
     *
     *   A. 新弹窗（DialogContent）：Tailwind 的 translate-x/y(-50%) 落在
     *      独立的 `translate` 属性上，居中本身就是一个 translate 值。
     *      此时必须把位移**叠加**在居中量上：calc(-50% + Npx)。
     *
     *   B. 旧弹窗（.s-xxx .dialog）：靠父级 flex 居中，自身
     *      `translate: none`。此时只能写纯位移 Npx ——
     *      若也写成 calc(-50% + Npx)，会额外再左移上移半个弹窗，
     *      实测设置弹窗直接飞出屏幕（期望 480,116 → 实际 140,-291）。
     */
    /*
     * 居中态用 CSS 变量承接位移，而不是把数值拼进 calc。
     *
     * 踩过的坑：直接拼 `calc(-50% + ${y}px)`，当 y=0 时浏览器把
     * `calc(-50% + 0px)` 规范化成裸 `-50%`，整条 translate 变成
     *   `calc(-50% + 20px) -50%`
     * 两个分量类型不一致（calc 值 vs 百分比），声明被判无效，
     * y 方向完全不动 —— 实测拖三次只横移了 20px。
     *
     * 现在把位移放进 `--dx/--dy` 变量，calc 里始终是变量引用，
     * 0 也写作 `var(--dy)`，不会触发常量折叠。
     */
    el.style.setProperty('--dx', `${x}px`)
    el.style.setProperty('--dy', `${y}px`)
    el.style.translate = centeredRef.current
      ? 'calc(-50% + var(--dx)) calc(-50% + var(--dy))'
      : 'var(--dx) var(--dy)' 
  }, [])

  const onMove = useCallback(
    (event: MouseEvent) => {
      const ctx = start.current
      if (!ctx) return

      let nextX = ctx.baseX + (event.clientX - ctx.x)
      let nextY = ctx.baseY + (event.clientY - ctx.y)

      /*
       * 边界钳制：保证弹窗始终有可操作区域留在视口内。
       * 用元素当前 rect 反推"未位移时的基准位置"，再算允许的位移范围。
       * 8px 余量避免贴边后边框被判为不可见。
       */
      const el = dialogEl.current
      if (el) {
        const rect = el.getBoundingClientRect()
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

      offsetRef.current = { x: nextX, y: nextY }
      /* 关键：不 setState，直接改 DOM —— 拖动过程零重渲染 */
      apply(nextX, nextY)
    },
    [apply],
  )

  const onUp = useCallback(() => {
    start.current = null
    setDragging(false)
    document.body.classList.remove('dialog-dragging')
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    /* 松手时才把最终位移同步进 state，供下次拖动作为基准 */
    setOffset(offsetRef.current)
    /*
     * 关键：恢复过渡时**必须排除 translate**。
     *
     * DialogContent 自带 `transition: all 0.2s`（给开合动画用的）。
     * 若松手后原样恢复 `all`，那么此后弹窗因任何理由重渲染时
     * （输入一个字、切换开关、主题变化），translate 属性都会重新走一遍
     * 0.2s 缓动 —— 表现为"松手后弹窗还会自己滑一小段"，这正是拖动
     * 越改越怪的真正原因。
     *
     * 这里显式把 transition 收窄为只作用于开合相关的属性，
     * 位移永远不做过渡。
     */
    const el = dialogEl.current
    if (el) {
      el.style.transition =
        'opacity 0.2s ease, scale 0.2s ease, box-shadow 0.2s ease'
    }
  }, [onMove])

  function onDragStart(event: React.MouseEvent): void {
    // 只响应左键；右键与中键不参与拖动
    if (event.button !== 0) return

    // 从标题栏上的按钮或输入控件按下时不拖动，否则点关闭会变成拖窗口
    const target = event.target as HTMLElement | null
    if (target?.closest('button, input, select, textarea, a')) return

    const el = (event.currentTarget as HTMLElement)?.closest('.dialog') as HTMLElement | null
    if (!el) return
    dialogEl.current = el

    /*
     * 探测居中方式（只在拖动开始时做一次）。
     * 读**内联** translate：Tailwind 的 -50% 来自 class，会出现在计算值里；
     * 而旧弹窗没有 translate 值。用内联 style 判断更直接：
     * 有内联值说明是我们之前写的位移，此时沿用上次的判定结果。
     */
    const inlineTranslate = el.style.translate
    if (!inlineTranslate) {
      const computed = getComputedStyle(el).translate
      centeredRef.current = computed !== 'none' && computed.includes('-50%')
    }

    // 阻止默认行为：否则拖动中文本会被整片选中
    event.preventDefault()
    start.current = {
      x: event.clientX,
      y: event.clientY,
      baseX: offsetRef.current.x,
      baseY: offsetRef.current.y,
    }
    document.body.classList.add('dialog-dragging')
    setDragging(true)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const resetDrag = useCallback(() => {
    offsetRef.current = { x: 0, y: 0 }
    setOffset({ x: 0, y: 0 })
    const el = dialogEl.current
    if (el) {
      el.style.transition = ''
      /* 清空内联值与位移变量，回落到 Tailwind 的 translate-x/y(-50%) 居中 */
      el.style.translate = ''
      el.style.removeProperty('--dx')
      el.style.removeProperty('--dy')
    }
  }, [])

  /**
   * 极简的"延迟写回"辅助 —— 见 release() 的说明。
   * 这里不需要额外状态，位移只存在于 ref 里。
   */

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('dialog-dragging')
    }
  }, [onMove, onUp])

  /**
   * 位移落在 `translate` 属性上（与 Tailwind 的居中同一属性），
   * 零位移时不输出，让 Tailwind 的 translate-x/y(-50%) 独自负责居中。
   */
  const style: Record<string, string> =
    offset.x === 0 && offset.y === 0
      ? {}
      : {
          /* 与 apply() 同一套变量写法，避免常量折叠导致声明失效 */
          '--dx': `${offset.x}px`,
          '--dy': `${offset.y}px`,
          translate: centeredRef.current
            ? 'calc(-50% + var(--dx)) calc(-50% + var(--dy))'
            : 'var(--dx) var(--dy)',
        }

  return { style, onDragStart, resetDrag, dragging }
}

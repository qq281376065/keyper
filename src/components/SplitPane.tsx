import { useEffect, useRef, useState } from 'react'
import { useI18n } from '@/i18n'

/**
 * 竖向分隔条：拖动调整相邻两栏的宽度。
 *
 * 为什么做成独立的 flex 子元素，而不是"绝对定位贴在某一栏边缘"：
 * 绝对定位需要 right: -Npx 才能跨出栏外，这条越界部分会被父级的
 * overflow、层叠上下文裁剪或错位；更糟的是它会进入某一栏的绘制区域，
 * 那一栏的所有 :hover / 选中态都可能被指针扫过而误触发。
 *
 * 作为 .body 的直接子元素参与 flex 布局，它就是一条**真实的、有宽度的**
 * 栅格，两栏之间天然留出这条缝，拖动只影响自己的 flex-basis。
 * 不越界、不重叠、不进入任何一栏的命中测试。
 *
 * 移植说明：Vue 版是 v-model（拖拽中每帧更新父级、松手才落盘）。
 * React 版保持同样契约：value + onChange（每帧）+ onCommit（松手）。
 */
export interface SplitPaneProps {
  /** 当前受控的宽度（px），由父级持有，组件自身不维护宽度状态 */
  value: number
  /** 下限 / 上限（px） */
  min?: number
  max?: number
  /** 双击恢复到的宽度 */
  defaultValue?: number
  /** 拖动中每帧回调（写 CSS 用，不落盘） */
  onChange: (value: number) => void
  /** 松手时回调一次（用于落盘，避开每帧写文件） */
  onCommit: (value: number) => void
}

export function SplitPane({
  value,
  min = 280,
  max = 720,
  defaultValue = 450,
  onChange,
  onCommit,
}: SplitPaneProps) {
  const { t } = useI18n()
  const [dragging, setDragging] = useState(false)

  const startX = useRef(0)
  const startWidth = useRef(0)
  /** rAF 合并：指针事件可达 120Hz，逐次写父级状态会带来无谓的重渲染 */
  const raf = useRef(0)
  const pending = useRef(0)
  /** 最新回调引用：拖动期间不重建监听（避免监听器闭包读到旧 props） */
  const changeRef = useRef(onChange)
  const commitRef = useRef(onCommit)
  changeRef.current = onChange
  commitRef.current = onCommit

  function clamp(v: number): number {
    return Math.min(max, Math.max(min, Math.round(v)))
  }

  function onMove(event: PointerEvent): void {
    // 阻止原生拖选：这是"拖动分隔条却把两栏文字全选中"的根源
    event.preventDefault()

    pending.current = clamp(startWidth.current + (event.clientX - startX.current))
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      changeRef.current(pending.current)
    })
  }

  function stop(): void {
    if (raf.current) {
      cancelAnimationFrame(raf.current)
      raf.current = 0
    }
    document.body.classList.remove('col-resizing')
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
    setDragging(false)
    if (pending.current) commitRef.current(pending.current)
  }

  // Vue 的 onBeforeUnmount(stop)：卸载时移除监听，避免拖动中途关标签留下残留
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      if (raf.current) cancelAnimationFrame(raf.current)
      document.body.classList.remove('col-resizing')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function start(event: React.PointerEvent): void {
    if (event.button !== 0) return

    /*
     * 加 class 必须在 preventDefault 之前：
     * 浏览器在 pointerdown 分发完成后才决定"要不要开始拖选"，
     * 提前把光标与选择行为锁住，中间不会出现几帧可选中状态。
     */
    document.body.classList.add('col-resizing')
    event.preventDefault()
    event.stopPropagation()

    // 清掉之前（双击等）残留的选区，否则它会随拖动扩展成一大片
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) sel.removeAllRanges()

    setDragging(true)
    startX.current = event.clientX
    startWidth.current = value
    pending.current = 0

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  function reset(): void {
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) sel.removeAllRanges()
    onChange(defaultValue)
    onCommit(defaultValue)
  }

  return (
    <div
      className={`v-splitter${dragging ? ' dragging' : ''} s-split-pane`}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      title={t('拖动调整宽度（{min}–{max}px），双击恢复 {defaultValue}px', { min, max, defaultValue })}
      onPointerDown={start}
      onDoubleClick={reset}
    >
      <span className="line" />
      {/*垂直居中的三点抓手：上 / 中 / 下。这条缝只有 8px 宽，光靠一条竖线
         很难让人意识到"这里可以拖"；三个点在视觉上是通用的"可拖动手柄"语汇。*/}
      <span className="grip" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {/*拖动中的宽度提示：给了精确数值才敢调到想要的位置，否则只能靠目测*/}
      {dragging ? <span className="badge mono">{value}px</span> : null}
    </div>
  )
}

export default SplitPane

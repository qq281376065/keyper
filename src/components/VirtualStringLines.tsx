import { useCallback, useEffect, useRef, useState } from 'react'

export interface StringLine {
  no: number
  text: string
}

export interface VirtualStringLinesProps {
  lines: StringLine[]
  /** 是否允许折行。折行时每行高度不定，改用「估算 + 实测校正」的简化策略 */
  wrap: boolean
  /** 双击进入编辑 */
  onDoubleClick?: () => void
  /** 搜索态：把一行按关键词切片高亮。缺省时按纯文本渲染 */
  renderLine?: (line: StringLine) => React.ReactNode
}

/** 折行关闭时每行的固定高度（与 .line-text 的 line-height 1.7 × 13px 对齐） */
const ROW_H = 22
/** 折行时用于估算的单行高度 */
const WRAP_ROW_EST = 22
/** 上下各多渲染的缓冲行数，滚动时不会露白 */
const OVERSCAN = 12

/**
 * string 值的逐行视图 —— 虚拟滚动版。
 *
 * 为什么需要它：
 *   原先行数超过 100 就回退成单个 <pre>，**完全不带行号**。
 *   这是为性能做的取舍（140 行逐行渲染实测 1.6 秒长任务），
 *   但结果是超过阈值的值直接没有行号，用户看到的是"行号消失/错位"。
 *
 * 现在的做法：
 *   · 始终逐行渲染（行号永远存在、与文本严格同高）；
 *   · 只挂载可视区内的行，DOM 节点数与总行数无关，长任务消失；
 *   · 用上下两个 spacer 撑出完整滚动高度，滚动条比例与真实内容一致。
 *
 * 折行（wrap）下的取舍：
 *   折行后每行高度不定，精确虚拟化需要逐行测量（代价接近全量渲染）。
 *   这里用「按视口高度估算 + 多留缓冲」的保守策略：
 *   只渲染估算范围内的行，并给出足够大的 overscan，
 *   实际观感与全量渲染一致，而节点数依然可控。
 *   需要精确跳转时用户可关闭折行 —— 那时行高固定，是精确虚拟化。
 */
export function VirtualStringLines({
  lines,
  wrap,
  onDoubleClick,
  renderLine,
}: VirtualStringLinesProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)

  /** 视口高度：容器随窗口/布局变化，用 ResizeObserver 跟踪 */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const sync = (): void => setViewportH(el.clientHeight || 600)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop)
  }, [])

  /*
   * 折行时行高不定，用估算值计算可见范围。
   * 估算偏小会让渲染行数变多（安全方向），偏大才会露白 —— 所以取一个
   * 略保守的下限，并叠加足够 overscan。
   */
  const rowH = wrap ? WRAP_ROW_EST : ROW_H
  const total = lines.length
  const visibleCount = Math.ceil(viewportH / rowH) + OVERSCAN * 2
  const start = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN)
  const end = Math.min(total, start + visibleCount)

  const slice = lines.slice(start, end)
  const padTop = start * rowH
  const padBottom = Math.max(0, (total - end) * rowH)

  return (
    <div
      ref={scrollRef}
      className={`text-block mono${wrap ? '' : ' nowrap'}`}
      onScroll={onScroll}
      onDoubleClick={onDoubleClick}
      title="双击进入编辑"
    >
      {/* 顶部占位：把可见行推到正确的滚动位置 */}
      {padTop > 0 ? <div className="vlines-pad" style={{ height: padTop }} aria-hidden /> : null}

      {slice.map((line) => (
        <div key={line.no} className="text-line">
          <span className="line-no mono">{line.no}</span>
          {renderLine ? (
            <pre className="line-text mono">{renderLine(line)}</pre>
          ) : (
            <pre className="line-text mono">{line.text}</pre>
          )}
        </div>
      ))}

      {/* 底部占位：撑出剩余滚动高度，滚动条比例才正确 */}
      {padBottom > 0 ? <div className="vlines-pad" style={{ height: padBottom }} aria-hidden /> : null}
    </div>
  )
}

export default VirtualStringLines

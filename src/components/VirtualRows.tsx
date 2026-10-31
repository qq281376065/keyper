import {
  Fragment,
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react'

/** 实测行高前的估算值：接近 .pair-row 的默认单行高度 */
const DEFAULT_ESTIMATE = 35
/** 视口上下各多渲染的行数：覆盖粘性表头高度与快速滚动 */
const DEFAULT_OVERSCAN = 8
/** 少于该行数全量渲染：窗口化本身的开销大于收益 */
const DEFAULT_THRESHOLD = 40
/** 尚未测量到视口高度时的兜底，避免首帧只渲染一两行 */
const FALLBACK_VIEWPORT = 640

interface VirtualRowsProps<T> {
  rows: T[]
  /** 稳定且唯一：用于复用测量高度与 React key（list/zset 用下标，hash 用字段名） */
  rowKey: (row: T) => string | number
  /** 必须返回单个 DOM 元素（ref 会通过 cloneElement 注入到该元素上） */
  renderRow: (row: T) => ReactElement
  /** 滚动容器（.pair-table），内部自行监听滚动与尺寸变化 */
  scrollRef: RefObject<HTMLDivElement | null>
  estimateHeight?: number
  overscan?: number
  threshold?: number
}

interface Frame {
  ref: (node: HTMLElement | null) => void
}

/**
 * 通用可变行高虚拟滚动。
 *
 * 为什么自己实现：项目没有虚拟化依赖，而值区表格行高由内容决定
 * （.pair-value 允许换行），固定行高的方案会在长值上错位。
 *
 * 做法：
 *   · 每行挂 ResizeObserver 实测高度并缓存（按 rowKey），未测到的用估算值；
 *   · 前缀和 + 二分查找定位视口内的行，上下用等高占位块补足；
 *   · 上方行的实测高度变化时同步调整 scrollTop，避免内容跳动；
 *   · 行元素通过 cloneElement 注入 ref，不额外包一层 div —— 表格的
 *     flex / grid 布局与 :hover、粘性底栏等既有 CSS 完全不受影响。
 */
export function VirtualRows<T>({
  rows,
  rowKey,
  renderRow,
  scrollRef,
  estimateHeight = DEFAULT_ESTIMATE,
  overscan = DEFAULT_OVERSCAN,
  threshold = DEFAULT_THRESHOLD,
}: VirtualRowsProps<T>) {
  const [version, setVersion] = useState(0)
  const [viewport, setViewport] = useState({ top: 0, height: 0 })

  const heights = useRef(new Map<string, number>())
  const elements = useRef(new Map<string, HTMLElement>())
  const elementKeys = useRef(new WeakMap<Element, string>())
  const refCallbacks = useRef(new Map<string, (node: HTMLElement | null) => void>())
  const observerRef = useRef<ResizeObserver | null>(null)
  const scrollElRef = useRef<HTMLDivElement | null>(null)
  const offsetsRef = useRef<number[]>([])
  const indexByKeyRef = useRef(new Map<string, number>())
  const frameRef = useRef<number | null>(null)

  const scheduleFlush = useCallback(() => {
    if (frameRef.current != null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      setVersion((prev) => prev + 1)
    })
  }, [])

  /** 按 key 缓存回调：保持引用稳定，避免每次渲染让 React 重挂 ref */
  function refFor(key: string): (node: HTMLElement | null) => void {
    const cached = refCallbacks.current.get(key)
    if (cached) return cached
    const callback = (node: HTMLElement | null): void => {
      const observer = observerRef.current
      const previous = elements.current.get(key)
      if (previous && previous !== node) {
        observer?.unobserve(previous)
        elements.current.delete(key)
      }
      if (!node) {
        if (previous) observer?.unobserve(previous)
        return
      }
      elements.current.set(key, node)
      elementKeys.current.set(node, key)
      observer?.observe(node)
    }
    refCallbacks.current.set(key, callback)
    return callback
  }

  /*
   * 观察器在 layout effect 里创建：首批行的 ref 在 commit 阶段已执行完毕，
   * 这里统一 observe；之后挂载的行由 ref 回调直接 observe。
   */
  useLayoutEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const scrollEl = scrollElRef.current
      const scrollTop = scrollEl?.scrollTop ?? 0
      let changed = false
      let compensation = 0

      for (const entry of entries) {
        const el = entry.target as HTMLElement
        const key = elementKeys.current.get(el)
        if (!key) continue
        const measured = entry.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height
        if (!measured) continue
        const previous = heights.current.get(key) ?? estimateHeight
        if (Math.abs(measured - previous) < 0.5) continue

        const index = indexByKeyRef.current.get(key)
        const top = index == null ? undefined : offsetsRef.current[index]
        heights.current.set(key, measured)
        // 行顶在视口上方（含跨视口顶部的那一行）：高度变化会推移下方内容
        if (top != null && top < scrollTop) compensation += measured - previous
        changed = true
      }

      if (compensation && scrollEl) scrollEl.scrollTop += compensation
      if (changed) scheduleFlush()
    })
    observerRef.current = observer
    for (const el of elements.current.values()) observer.observe(el)

    return () => {
      observer.disconnect()
      observerRef.current = null
      if (frameRef.current != null) {
        window.cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
  }, [estimateHeight, scheduleFlush])

  /*
   * 滚动与容器尺寸：rAF 合并，逐帧最多一次 setState。
   *
   * 必须用 useEffect 而不是 useLayoutEffect：scrollRef 指向**父级**
   * .pair-table，React 的 ref 与 layout effect 都自底向上提交，
   * 子组件的 layout effect 执行时父元素 ref 还是 null —— 监听会挂到空值上，
   * 之后依赖 [scrollRef] 不变也不会重跑（表现为滚动时行不更新）。
   * 被动 effect 在整棵树提交后执行，此时父级 ref 必然已就绪。
   */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    scrollElRef.current = el

    const sync = (): void => {
      const top = el.scrollTop
      const height = el.clientHeight
      setViewport((prev) => (prev.top === top && prev.height === height ? prev : { top, height }))
    }

    let frame: number | null = null
    const onScroll = (): void => {
      if (frame != null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        sync()
      })
    }

    sync()
    el.addEventListener('scroll', onScroll, { passive: true })
    const resizeObserver = new ResizeObserver(sync)
    resizeObserver.observe(el)

    return () => {
      el.removeEventListener('scroll', onScroll)
      resizeObserver.disconnect()
      if (frame != null) window.cancelAnimationFrame(frame)
    }
  }, [scrollRef])

  /** 前缀和 + 行 key 索引；version 变化（实测高度回填）时重算 */
  const layout = useMemo(() => {
    const count = rows.length
    const offsets = new Array<number>(count + 1)
    const indexByKey = new Map<string, number>()
    offsets[0] = 0
    for (let i = 0; i < count; i++) {
      const key = String(rowKey(rows[i]))
      indexByKey.set(key, i)
      const measured = heights.current.get(key)
      offsets[i + 1] = offsets[i] + (measured && measured > 0 ? measured : estimateHeight)
    }
    return { offsets, total: offsets[count] ?? 0, indexByKey }
    // version 仅用于触发实测高度回填后的重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, rowKey, estimateHeight, version])

  useLayoutEffect(() => {
    offsetsRef.current = layout.offsets
    indexByKeyRef.current = layout.indexByKey
  }, [layout])

  const virtualized = rows.length > threshold
  let start = 0
  let end = rows.length
  if (virtualized) {
    const top = viewport.top
    const bottom = top + (viewport.height || FALLBACK_VIEWPORT)
    const offsets = layout.offsets
    const count = rows.length

    // 第一个「底边越过视口顶部」的行
    let lo = 0
    let hi = count
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid + 1] <= top) lo = mid + 1
      else hi = mid
    }
    start = Math.max(0, lo - overscan)

    // 第一个「顶边越过视口底部」的行（不含）
    lo = 0
    hi = count
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid] < bottom) lo = mid + 1
      else hi = mid
    }
    end = Math.min(count, lo + overscan)
  }

  const visible: ReactElement[] = []
  for (let i = start; i < end; i++) {
    const row = rows[i]
    const key = String(rowKey(row))
    const element = renderRow(row) as ReactElement<Frame>
    visible.push(
      <Fragment key={key}>
        {cloneElement(element, { ref: refFor(key) })}
      </Fragment>,
    )
  }

  if (!virtualized) return <>{visible}</>

  return (
    <>
      {start > 0 ? (
        <div className="vrow-gap" style={{ height: layout.offsets[start] }} aria-hidden="true" />
      ) : null}
      {visible}
      {end < rows.length ? (
        <div
          className="vrow-gap"
          style={{ height: Math.max(layout.total - layout.offsets[end], 0) }}
          aria-hidden="true"
        />
      ) : null}
    </>
  )
}

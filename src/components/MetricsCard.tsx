import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
import type { MsgKey } from '@shared/i18n'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { useSessionStore } from '@/hooks/useSessionStore'
import type { MetricsSample } from '@shared/types'

/** 数据源引擎：Memcached 复用采样与绘图骨架，只是 stats 字段名不同 */
type Engine = 'redis' | 'memcached'

/**
 * 监控页签：内存主图 + 五张指标迷你卡 + 高频采样。
 *
 * 采样默认不开启：每 2 秒一次 INFO 是持续成本（连接占用、实例侧开销、电池），
 * 打开概览看一眼时不该在后台无声跑起来。三态区分「从未开启」与「开启后暂停」。
 *
 * 采样只在「页签激活 + 连接可用 + 处于 running」三者同时成立时进行；
 * 组件本身常驻（页签用 display 切换），切走再切回不丢历史点。
 */

const SAMPLE_INTERVAL_MS = 2000
/** 15 分钟 × 每 2 秒一个点；超出后丢弃最旧的 */
const MAX_SAMPLES = 450
const DELTA_WINDOW_MS = 60_000
const HERO_HEIGHT = 208
const HERO_PAD = { l: 46, r: 14, t: 14, b: 24 }
const MINI_HEIGHT = 38
const MINI_PAD = 4

type RangeKey = '1m' | '5m' | '15m'
type SamplingState = 'idle' | 'running' | 'paused'

const RANGES: Array<{ key: RangeKey; samples: number; label: MsgKey }> = [
  { key: '1m', samples: 30, label: 'metricsCard.range1m' },
  { key: '5m', samples: 150, label: 'metricsCard.range5m' },
  { key: '15m', samples: 450, label: 'metricsCard.range15m' },
]

function splitBytes(value: number): { value: string; unit: string } {
  const abs = Math.abs(value)
  if (abs >= 1024 ** 3) return { value: (value / 1024 ** 3).toFixed(2), unit: 'GB' }
  if (abs >= 1024 ** 2) return { value: (value / 1024 ** 2).toFixed(1), unit: 'MB' }
  if (abs >= 1024) return { value: (value / 1024).toFixed(1), unit: 'KB' }
  return { value: String(Math.round(value)), unit: 'B' }
}

function formatMemory(value: number): string {
  const parts = splitBytes(value)
  return `${parts.value} ${parts.unit}`
}

/** 峰值标签空间紧张，单位紧贴数字（219.6MB），不再插空格 */
function formatMemoryCompact(value: number): string {
  const parts = splitBytes(value)
  return `${parts.value}${parts.unit}`
}

function byteScale(value: number): { divisor: number; unit: string } {
  const abs = Math.abs(value)
  if (abs >= 1024 ** 3) return { divisor: 1024 ** 3, unit: 'GB' }
  if (abs >= 1024 ** 2) return { divisor: 1024 ** 2, unit: 'MB' }
  if (abs >= 1024) return { divisor: 1024, unit: 'KB' }
  return { divisor: 1, unit: 'B' }
}

interface MetricDef {
  id: 'ops' | 'clients' | 'hit' | 'keys' | 'evicted'
  titleKey: MsgKey
  /** 指标含义与数据来源：同名指标在不同版本 / 托管服务里口径可能不同 */
  tipKey: MsgKey
  /** Memcached 下的口径说明：stats 字段与 Redis INFO 不是同一套 */
  mcTipKey: MsgKey
  color: string
  pick: (sample: MetricsSample) => number
  /** 单位：百分号直接贴数字，其余走语言包（如 /分） */
  unit?: '%'
  unitKey?: MsgKey
  /** 累计型指标：曲线画的是「每分钟增量」，累计绝对值只会单调上升 */
  delta?: boolean
}

const MINI_METRICS: MetricDef[] = [
  {
    id: 'ops',
    titleKey: 'metricsCard.opsPerSec',
    tipKey: 'metricsCard.tipOpsPerSec',
    mcTipKey: 'memcachedMetrics.tipOpsPerSec',
    color: 'var(--blue)',
    pick: (sample) => sample.opsPerSec,
  },
  {
    id: 'clients',
    titleKey: 'metricsCard.clients',
    tipKey: 'metricsCard.tipClients',
    mcTipKey: 'memcachedMetrics.tipClients',
    color: 'var(--green)',
    pick: (sample) => sample.connectedClients,
  },
  {
    id: 'hit',
    titleKey: 'metricsCard.hitRate',
    tipKey: 'metricsCard.tipHitRate',
    mcTipKey: 'memcachedMetrics.tipHitRate',
    color: 'var(--amber)',
    pick: (sample) => sample.hitRate,
    unit: '%',
  },
  {
    id: 'keys',
    titleKey: 'metricsCard.totalKeys',
    tipKey: 'metricsCard.tipTotalKeys',
    mcTipKey: 'memcachedMetrics.tipTotalKeys',
    color: 'var(--purple)',
    pick: (sample) => sample.totalKeys,
  },
  {
    id: 'evicted',
    titleKey: 'metricsCard.evictions',
    tipKey: 'metricsCard.tipEvictions',
    mcTipKey: 'memcachedMetrics.tipEvictions',
    color: 'var(--pink)',
    pick: (sample) => sample.evictedKeys,
    unitKey: 'metricsCard.unitPerMinute',
    delta: true,
  },
]

function displayValue(def: MetricDef, value: number): string {
  if (def.id === 'hit' || def.id === 'evicted') return value.toFixed(1)
  return Math.round(value).toLocaleString('en-US')
}

function unitOf(def: MetricDef, t: (key: MsgKey, params?: Record<string, string | number>) => string): string {
  if (def.unit) return def.unit
  return def.unitKey ? t(def.unitKey) : ''
}

function formatMetricValue(
  def: MetricDef,
  value: number,
  t: (key: MsgKey, params?: Record<string, string | number>) => string,
): string {
  return `${displayValue(def, value)}${unitOf(def, t)}`
}

/** Memcached stats 的累计命令数：get / set / touch 各有独立计数，其余按命中与未命中求和 */
function mcCommandTotal(stats: Record<string, string>): number {
  const n = (key: string): number => Number(stats[key]) || 0
  return (
    n('cmd_get') +
    n('cmd_set') +
    n('cmd_touch') +
    n('delete_hits') +
    n('delete_misses') +
    n('incr_hits') +
    n('incr_misses') +
    n('decr_hits') +
    n('decr_misses') +
    n('cas_hits') +
    n('cas_misses') +
    n('cas_badval')
  )
}

interface CommandMark {
  at: number
  total: number
}

/**
 * Memcached 没有 instantaneous_ops_per_sec：
 * 用两次采样的累计命令数差值除以真实间隔换算每秒速率。
 * 首次采样没有参照点，ops 记为 0，第二个点起才画得出曲线。
 */
function memcachedSample(
  stats: Record<string, string>,
  at: number,
  mark: CommandMark | null,
): { sample: MetricsSample; mark: CommandMark } {
  const n = (key: string): number => Number(stats[key]) || 0
  const hits = n('get_hits')
  const misses = n('get_misses')
  const total = hits + misses
  const commands = mcCommandTotal(stats)
  const elapsed = mark ? (at - mark.at) / 1000 : 0
  return {
    mark: { at, total: commands },
    sample: {
      at,
      usedMemory: n('bytes'),
      usedMemoryPeak: n('bytes'),
      maxMemory: n('limit_maxbytes'),
      opsPerSec: mark && elapsed > 0 ? Math.max(0, (commands - mark.total) / elapsed) : 0,
      connectedClients: n('curr_connections'),
      blockedClients: 0,
      totalKeys: n('curr_items'),
      hitRate: total > 0 ? Math.round((hits / total) * 1000) / 10 : 0,
      keyspaceHits: hits,
      keyspaceMisses: misses,
      evictedKeys: n('evictions'),
      expiredKeys: n('expired_unfetched'),
      totalCommands: commands,
      netInputBytes: n('bytes_read'),
      netOutputBytes: n('bytes_written'),
    },
  }
}

/**
 * 累计值 → 每分钟增量。
 *
 * 用最长 60 秒的滑动窗口而不是相邻两点：计数器是阶梯增长的，
 * 按相邻点算会把「20 秒涨 1」放大成「30/分钟」的尖刺。
 */
function seriesOf(def: MetricDef, samples: MetricsSample[]): number[] {
  const raw = samples.map((sample) => ({ at: sample.at, value: def.pick(sample) }))
  if (!def.delta) return raw.map((point) => point.value)
  return raw.map((point, index) => {
    let back = index
    while (back > 0 && point.at - raw[back - 1].at <= DELTA_WINDOW_MS) back -= 1
    const prev = raw[back]
    const minutes = (point.at - prev.at) / 60000
    return minutes > 0 ? Math.max(0, (point.value - prev.value) / minutes) : 0
  })
}

function formatClock(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Catmull-Rom → 三次贝塞尔，折线在视觉上不会出现生硬折角 */
function smoothPath(points: Array<readonly [number, number]>): string {
  if (points.length < 2) return ''
  let d = `M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
  }
  return d
}

function niceScale(min: number, max: number, count = 4): { lo: number; hi: number; step: number } {
  if (min === max) {
    min -= 1
    max += 1
  }
  const raw = (max - min) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
  return { lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step, step }
}

function axisNumber(value: number, step: number): string {
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0
  return value.toFixed(decimals)
}

/**
 * 在轻度平滑后的曲线上找局部波峰：按幅值排序，再用「最小像素间距」抑制重叠。
 * 低于均值附近的小抖动不标注，避免动态曲线每秒刷新时标签乱跳。
 */
function pickStagePeaks(values: number[], minGap: number, count: number, exclude: number): number[] {
  const n = values.length
  if (n < 5) return []
  const smooth = values.map((value, i) => (((values[i - 1] ?? value) + 2 * value + (values[i + 1] ?? value)) / 4))
  const span = Math.max(1e-9, Math.max(...values) - Math.min(...values))
  const avg = values.reduce((sum, value) => sum + value, 0) / n
  const floor = avg - span * 0.08
  const candidates: number[] = []
  for (let i = 2; i < n - 2; i += 1) {
    if (smooth[i] > smooth[i - 1] && smooth[i] >= smooth[i + 1] && values[i] >= floor) {
      const prom = smooth[i] - Math.max(Math.min(smooth[i - 1], smooth[i - 2]), Math.min(smooth[i + 1], smooth[i + 2]))
      if (prom >= span * 0.045 && Math.abs(i - exclude) >= minGap) candidates.push(i)
    }
  }
  candidates.sort((a, b) => values[b] - values[a])
  const picked: number[] = []
  for (const index of candidates) {
    if (picked.length >= count) break
    if (picked.every((other) => Math.abs(index - other) >= minGap)) picked.push(index)
  }
  return picked.sort((a, b) => a - b)
}

/** 卡片宽度决定刻度密度和小图列数；ResizeObserver 保证分栏拖动后立即重绘 */
function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const next = el.clientWidth
      setWidth((prev) => (prev === next ? prev : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

interface MemoryHeroProps {
  values: number[]
  timestamps: number[]
  maxMemory: number
  sampling: boolean
  engine: Engine
}

function MemoryHero({ values, timestamps, maxMemory, sampling, engine }: MemoryHeroProps) {
  const { t } = useI18n()
  const [chartRef, width] = useElementWidth<HTMLDivElement>()
  const gradientId = `mt-hero-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const tipRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [tipSize, setTipSize] = useState({ w: 104, h: 40 })

  const count = values.length
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const lastValue = values[count - 1]
  const avg = values.reduce((sum, value) => sum + value, 0) / count
  const delta = lastValue - values[0]

  /*
   * 数据完全水平时，给首尾补一个很小的跨度；
   * 否则 niceScale 会退化成「同一刻度重复四次」，坐标轴失去意义。
   */
  const flatPad = maxValue === minValue ? Math.max(Math.abs(maxValue) * 0.02, 1) : 0
  const loRaw = Math.max(0, minValue - flatPad)
  const hiRaw = maxValue + flatPad
  const scaleUnit = byteScale(hiRaw)
  const scale = niceScale(loRaw / scaleUnit.divisor, hiRaw / scaleUnit.divisor, 4)

  const plotW = Math.max(0, width - HERO_PAD.l - HERO_PAD.r)
  const plotH = HERO_HEIGHT - HERO_PAD.t - HERO_PAD.b
  const xOf = (index: number): number => HERO_PAD.l + (index / Math.max(1, count - 1)) * plotW
  const yOf = (value: number): number => {
    const ratio = (scale.hi - value / scaleUnit.divisor) / (scale.hi - scale.lo || 1)
    return HERO_PAD.t + Math.max(0, Math.min(1, ratio)) * plotH
  }

  const points = values.map((value, index) => [xOf(index), yOf(value)] as const)
  const line = smoothPath(points)
  const area = `${line} L${xOf(count - 1).toFixed(1)} ${(HERO_PAD.t + plotH).toFixed(1)} L${HERO_PAD.l} ${(HERO_PAD.t + plotH).toFixed(1)} Z`

  const peakIndex = values.indexOf(maxValue)
  const stepX = plotW / Math.max(1, count - 1)
  const minGap = Math.max(5, Math.ceil(76 / Math.max(1, stepX)))
  const stageCount = width >= 720 ? 3 : width >= 520 ? 2 : 1
  const stagePeaks = pickStagePeaks(values, minGap, stageCount, peakIndex)
  const peakIndexes = [peakIndex, ...stagePeaks]

  const labelCount = Math.min(width < 560 ? 3 : 5, count)
  const ticks: number[] = []
  for (let value = scale.lo; value <= scale.hi + 1e-9; value += scale.step) ticks.push(value)

  const hoverIndex = hover == null ? null : Math.max(0, Math.min(count - 1, hover))
  const hoverPoint = hoverIndex == null ? null : points[hoverIndex]
  const hoverParts = hoverIndex == null ? null : splitBytes(values[hoverIndex])

  useLayoutEffect(() => {
    if (hoverIndex == null) return
    const el = tipRef.current
    if (!el) return
    const next = { w: el.offsetWidth, h: el.offsetHeight }
    setTipSize((prev) => (prev.w === next.w && prev.h === next.h ? prev : next))
  }, [hoverIndex, width])

  let tipLeft = 2
  let tipTop = 2
  if (hoverPoint) {
    tipLeft = hoverPoint[0] + 12
    if (tipLeft + tipSize.w > width - 4) tipLeft = hoverPoint[0] - tipSize.w - 12
    tipLeft = Math.max(2, tipLeft)
    tipTop = Math.min(HERO_PAD.t + plotH - tipSize.h, Math.max(2, hoverPoint[1] - tipSize.h - 10))
  }

  const tipRect = hoverIndex == null ? null : { left: tipLeft, top: tipTop, w: tipSize.w, h: tipSize.h }

  const pickIndex = (clientX: number): number => {
    const el = chartRef.current
    if (!el || width <= 0 || count < 2) return 0
    const rect = el.getBoundingClientRect()
    const chartX = ((clientX - rect.left) / Math.max(1, rect.width)) * width
    const ratio = (chartX - HERO_PAD.l) / Math.max(1, plotW)
    return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))))
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      setHover(null)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setHover(event.key === 'Home' ? 0 : count - 1)
      return
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setHover((prev) => {
      const base = prev ?? count - 1
      const next = event.key === 'ArrowLeft' ? base - 1 : base + 1
      return Math.max(0, Math.min(count - 1, next))
    })
  }

  const quota = maxMemory > 0 ? (lastValue / maxMemory) * 100 : null
  const quotaClass = quota == null ? '' : quota >= 90 ? ' bad' : quota >= 70 ? ' warn' : ''
  const lastParts = splitBytes(lastValue)

  const labelPositions: Array<{ index: number; left: number; top: number; above: boolean; global: boolean }> = []
  let lastLeft = -1e9
  for (const index of [...peakIndexes].sort((a, b) => a - b)) {
    if (index < 2 || index > count - 3) continue
    const global = index === peakIndex
    const edge = HERO_PAD.l + (global ? 44 : 34)
    const left = Math.max(edge, Math.min(width - edge, xOf(index)))
    if (left - lastLeft < 56) continue
    lastLeft = left
    const top = yOf(values[index])
    labelPositions.push({ index, left, top: top > 40 ? top - 7 : top + 7, above: top > 40, global })
  }

  return (
    <section className="mt-hero">
      <header className="mt-hero-head">
        <span
          className="mt-hero-id"
          {...tipProps(t(engine === 'memcached' ? 'memcachedMetrics.tipMemory' : 'metricsCard.tipMemory'))}
        >
          <i className="mt-square-dot" />
          {t('metricsCard.memory')}
          <code>{engine === 'memcached' ? 'bytes' : 'usedMemory'}</code>
        </span>
        <span className="mt-hero-meta">
          <span className="mt-chip mt-chip-arrow">
            <i>{t('metricsCard.rangeDelta')}</i>
            {delta === 0 ? '—' : `${delta > 0 ? '▲' : '▼'} ${formatMemoryCompact(Math.abs(delta))}`}
          </span>
          {quota != null ? (
            <span className={`mt-chip mt-chip-quota${quotaClass}`}>
              {t('metricsCard.quota', { percent: quota.toFixed(1) })}
            </span>
          ) : null}
        </span>
        <span className="mt-hero-read">
          <span className="mt-hero-value">{lastParts.value}</span>
          <span className="mt-hero-unit">{lastParts.unit}</span>
        </span>
      </header>

      <div
        className="mt-chart-wrap"
        ref={chartRef}
        tabIndex={0}
        role="group"
        aria-label={t('metricsCard.chartAria')}
        onPointerMove={(event) => {
          const next = pickIndex(event.clientX)
          setHover((prev) => (prev === next ? prev : next))
        }}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover((prev) => prev ?? count - 1)}
        onBlur={() => setHover(null)}
        onKeyDown={handleKeyDown}
      >
        {width > 0 ? (
          <svg
            className="mt-chart-svg"
            viewBox={`0 0 ${width} ${HERO_HEIGHT}`}
            role="img"
            aria-label={t('metricsCard.chartAria')}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.22 }} />
                <stop offset="100%" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
              </linearGradient>
            </defs>
            {ticks.map((value) => {
              const py = yOf(value * scaleUnit.divisor)
              return (
                <g key={value}>
                  <line x1={HERO_PAD.l} y1={py} x2={width - HERO_PAD.r} y2={py} className="mt-grid-line" />
                  <text
                    x={HERO_PAD.l - 8}
                    y={py}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="mt-axis-text"
                  >
                    {axisNumber(value, scale.step)}
                    {scaleUnit.unit}
                  </text>
                </g>
              )
            })}
            {Array.from({ length: labelCount }, (_, k) => {
              const frac = labelCount === 1 ? 0 : k / (labelCount - 1)
              const px = HERO_PAD.l + frac * plotW
              const time = timestamps[0] + frac * (timestamps[count - 1] - timestamps[0])
              const anchor = k === 0 ? 'start' : k === labelCount - 1 ? 'end' : 'middle'
              return (
                <text
                  key={k}
                  x={px}
                  y={HERO_HEIGHT - 6}
                  textAnchor={anchor}
                  className="mt-axis-text"
                >
                  {formatClock(time)}
                </text>
              )
            })}
            <line
              x1={HERO_PAD.l}
              y1={yOf(avg)}
              x2={width - HERO_PAD.r}
              y2={yOf(avg)}
              className="mt-baseline-line"
            />
            <path d={area} fill={`url(#${gradientId})`} />
            <path d={line} className="mt-hero-line" vectorEffect="non-scaling-stroke" />
            {peakIndexes.map((index) => {
              const global = index === peakIndex
              const [cx, cy] = points[index]
              return (
                <g key={`peak-${index}`}>
                  <circle cx={cx} cy={cy} r={global ? 8 : 5} className={global ? 'mt-peak-halo' : 'mt-peak-halo stage'} />
                  <circle cx={cx} cy={cy} r={global ? 3.6 : 2.6} className={global ? 'mt-peak-dot' : 'mt-peak-dot stage'} />
                </g>
              )
            })}
            {hoverPoint ? (
              <g className="mt-hover-g">
                <line
                  x1={hoverPoint[0]}
                  y1={HERO_PAD.t}
                  x2={hoverPoint[0]}
                  y2={HERO_PAD.t + plotH}
                  className="mt-hover-line"
                />
                <line
                  x1={HERO_PAD.l}
                  y1={hoverPoint[1]}
                  x2={width - HERO_PAD.r}
                  y2={hoverPoint[1]}
                  className="mt-hover-line mt-hover-line-h"
                />
                <circle cx={hoverPoint[0]} cy={hoverPoint[1]} r={3.6} className="mt-hover-dot" />
              </g>
            ) : null}
          </svg>
        ) : null}

        {width > 0 && points.length > 0 ? (
          <span
            className={`mt-end-dot${sampling ? '' : ' off'}`}
            style={{ left: `${points[count - 1][0]}px`, top: `${points[count - 1][1]}px` }}
          />
        ) : null}

        <div className="mt-peak-layer" aria-hidden="true">
          {labelPositions.map((label) => {
            const chipW = label.global ? 68 : 46
            const chipH = 16
            const chipLeft = label.left - chipW / 2
            const chipTop = label.above ? label.top - chipH : label.top
            const covered =
              tipRect != null &&
              !(
                chipLeft + chipW < tipRect.left - 3 ||
                chipLeft > tipRect.left + tipRect.w + 3 ||
                chipTop + chipH < tipRect.top - 3 ||
                chipTop > tipRect.top + tipRect.h + 3
              )
            return (
              <span
                key={`label-${label.index}`}
                className={`mt-peak-chip${label.global ? '' : ' stage'}`}
                style={{
                  left: `${label.left}px`,
                  top: `${label.top}px`,
                  transform: `translate(-50%, ${label.above ? '-100%' : '0'})`,
                  opacity: covered ? 0 : 1,
                }}
              >
                {label.global ? `${t('metricsCard.peakGlobal')} ` : <i>{t('metricsCard.peakStage')}</i>}
                <b>{formatMemoryCompact(values[label.index])}</b>
              </span>
            )
          })}
        </div>

        {hoverIndex != null && hoverParts && hoverPoint ? (
          <div ref={tipRef} className="mt-chart-tip" style={{ left: `${tipLeft}px`, top: `${tipTop}px` }}>
            <span className="mt-tip-time">{formatClock(timestamps[hoverIndex])}</span>
            <span className="mt-tip-value">
              {hoverParts.value}
              <em>{hoverParts.unit}</em>
            </span>
          </div>
        ) : null}
      </div>

      <footer className="mt-hero-foot">
        <div className="mt-stats">
          <span>
            {t('metricsCard.statMin')} <b>{formatMemory(minValue)}</b>
          </span>
          <span>
            {t('metricsCard.statAvg')} <b>{formatMemory(avg)}</b>
          </span>
          <span>
            {t('metricsCard.statPeak')} <b>{formatMemory(maxValue)}</b>
          </span>
          {maxMemory > 0 ? (
            <span>
              {t('metricsCard.statLimit')} <b>{formatMemory(maxMemory)}</b>
            </span>
          ) : null}
        </div>
        <span className="mt-baseline-key">
          <i />
          {t('metricsCard.baseline')} <b>{formatMemory(avg)}</b>
        </span>
      </footer>
    </section>
  )
}

interface MiniMetricProps {
  def: MetricDef
  values: number[]
  timestamps: number[]
  engine: Engine
}

function MiniMetric({ def, values, timestamps, engine }: MiniMetricProps) {
  const { t } = useI18n()
  const [sparkRef, width] = useElementWidth<HTMLDivElement>()
  const gradientId = `mt-mini-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [hover, setHover] = useState<number | null>(null)

  const count = values.length
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const lastValue = values[count - 1]
  const avg = values.reduce((sum, value) => sum + value, 0) / count
  const delta = lastValue - values[0]
  const unit = unitOf(def, t)

  const span = maxValue - minValue
  const innerW = Math.max(0, width - MINI_PAD * 2)
  const innerH = MINI_HEIGHT - MINI_PAD * 2
  const xOf = (index: number): number => MINI_PAD + (index / Math.max(1, count - 1)) * innerW
  const yOf = (value: number): number =>
    MINI_PAD + (span === 0 ? 0.5 : 1 - (value - minValue) / span) * innerH

  const points = values.map((value, index) => [xOf(index), yOf(value)] as const)
  const line = smoothPath(points)
  const area = `${line} L${(width - MINI_PAD).toFixed(1)} ${MINI_HEIGHT} L${MINI_PAD} ${MINI_HEIGHT} Z`
  const hoverIndex = hover == null ? null : Math.max(0, Math.min(count - 1, hover))
  const hoverPoint = hoverIndex == null ? null : points[hoverIndex]
  let tipLeft = 0
  if (hoverPoint) tipLeft = Math.max(44, Math.min(width - 44, hoverPoint[0]))

  const pickIndex = (clientX: number, target: HTMLElement): number => {
    const rect = target.getBoundingClientRect()
    const ratio = (clientX - rect.left) / Math.max(1, rect.width)
    return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))))
  }

  return (
    <article className="mt-mini">
      <header className="mt-mini-head">
        <i className="mt-mini-dot" style={{ background: def.color }} />
        <span
          className="mt-mini-name"
          {...tipProps(t(engine === 'memcached' ? def.mcTipKey : def.tipKey))}
        >
          {t(def.titleKey)}
        </span>
        <span className="mt-mini-delta">
          {delta >= 0 ? '▲' : '▼'} {displayValue(def, Math.abs(delta))}
        </span>
      </header>
      <div className="mt-mini-value">
        <b>{displayValue(def, lastValue)}</b>
        {unit ? <span>{unit}</span> : null}
      </div>
      <div
        ref={sparkRef}
        className="mt-mini-spark"
        role="img"
        aria-label={t('metricsCard.miniChartAria', { name: t(def.titleKey) })}
        onPointerMove={(event) => {
          const next = pickIndex(event.clientX, event.currentTarget)
          setHover((prev) => (prev === next ? prev : next))
        }}
        onPointerLeave={() => setHover(null)}
      >
        {width > 0 ? (
          <svg className="mt-mini-svg" viewBox={`0 0 ${width} ${MINI_HEIGHT}`} aria-hidden="true">
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: def.color, stopOpacity: 0.24 }} />
                <stop offset="100%" style={{ stopColor: def.color, stopOpacity: 0 }} />
              </linearGradient>
            </defs>
            <line
              x1={MINI_PAD}
              y1={yOf(avg)}
              x2={width - MINI_PAD}
              y2={yOf(avg)}
              className="mt-mini-baseline"
            />
            <path d={area} fill={`url(#${gradientId})`} />
            <path
              d={line}
              className="mt-mini-line"
              style={{ stroke: def.color }}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={width - MINI_PAD}
              cy={yOf(lastValue)}
              r={2.6}
              className="mt-mini-end"
              style={{ fill: def.color }}
            />
          </svg>
        ) : null}
        {hoverPoint && hoverIndex != null ? (
          <>
            <span className="mt-mini-cross" style={{ left: `${hoverPoint[0]}px` }} />
            <span className="mt-mini-hcross" style={{ top: `${hoverPoint[1]}px` }} />
            <span
              className="mt-mini-hdot"
              style={{ left: `${hoverPoint[0]}px`, top: `${hoverPoint[1]}px`, background: def.color }}
            />
            <span className="mt-mini-tip" style={{ left: `${tipLeft}px` }}>
              <span>{formatClock(timestamps[hoverIndex])}</span>
              <b style={{ color: def.color }}>
                {displayValue(def, values[hoverIndex])}
                {unit ? <em>{unit}</em> : null}
              </b>
            </span>
          </>
        ) : null}
      </div>
      <footer className="mt-mini-foot">
        <span>
          {t('metricsCard.shortMin')} <b>{formatMetricValue(def, minValue, t)}</b>
        </span>
        <span>
          {t('metricsCard.shortMax')} <b>{formatMetricValue(def, maxValue, t)}</b>
        </span>
      </footer>
    </article>
  )
}

interface MetricsCardProps {
  /** 监控页签是否处于激活状态；非激活时不采样（组件仍常驻保留历史） */
  active: boolean
  /** 数据源引擎，默认 Redis；Memcached 只换 stats 映射，采样节奏与绘图完全共用 */
  engine?: Engine
}

export function MetricsCard({ active, engine = 'redis' }: MetricsCardProps) {
  const { t } = useI18n()
  const { state, activeConnection } = useRedis()
  useObservable(useSessionStore())

  const activeId = state.activeId
  const connected = activeConnection?.status === 'connected'

  const [samples, setSamples] = useState<MetricsSample[]>([])
  const [samplingState, setSamplingState] = useState<SamplingState>('idle')
  const [cleared, setCleared] = useState(false)
  const sampling = samplingState === 'running'
  const [range, setRange] = useState<RangeKey>('5m')
  const [error, setError] = useState<string | null>(null)

  /* 回调注册一次，需要读到最新的连接 id */
  const idRef = useRef(activeId)
  idRef.current = activeId

  /* Memcached 的 ops/sec 靠相邻采样的累计命令差值换算，需要保存上一次的参照点 */
  const commandMarkRef = useRef<CommandMark | null>(null)

  /*
   * 换连接 / 断开：旧实例的采样不能挂到新连接上。
   * 同时把状态拉回 idle —— 否则会停在「已暂停」，而新连接其实一个点都没采过。
   */
  useEffect(() => {
    setSamples([])
    setError(null)
    setCleared(false)
    commandMarkRef.current = null
    setSamplingState('idle')
  }, [activeId, connected])

  useEffect(() => {
    if (!active || !connected || !sampling) return
    let cancelled = false
    /* 暂停或切走期间计数仍在增长，恢复后按旧参照点算会把速率摊平 */
    commandMarkRef.current = null

    async function sample(): Promise<void> {
      const id = idRef.current
      if (!id) return
      try {
        let next: MetricsSample
        if (engine === 'memcached') {
          const res = await api.memcached.overview(id)
          if (!res.ok) throw new Error(res.error)
          const mapped = memcachedSample(res.data.stats, Date.now(), commandMarkRef.current)
          if (cancelled) return
          commandMarkRef.current = mapped.mark
          next = mapped.sample
        } else {
          const res = await api.redis.metrics(id)
          if (!res.ok) throw new Error(res.error)
          if (cancelled) return
          next = res.data
        }
        setError(null)
        setSamples((prev) => {
          const merged = [...prev, next]
          return merged.length > MAX_SAMPLES ? merged.slice(merged.length - MAX_SAMPLES) : merged
        })
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('metricsCard.loadFailed'))
        }
      }
    }

    void sample()
    const timer = setInterval(() => void sample(), SAMPLE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, connected, sampling, activeId, engine])

  const windowSize = RANGES.find((item) => item.key === range)?.samples ?? 150
  const windowSamples = samples.slice(Math.max(0, samples.length - windowSize))
  const ready = windowSamples.length >= 2
  const timestamps = windowSamples.map((sample) => sample.at)
  const lastSample = windowSamples[windowSamples.length - 1]

  const emptyKind = !connected ? 'disconnected' : cleared ? 'cleared' : samplingState === 'idle' ? 'idle' : samplingState === 'paused' ? 'paused' : 'waiting'
  const emptyCopy =
    emptyKind === 'disconnected'
      ? { title: t('metricsCard.waitingConnection'), desc: t('metricsCard.emptyDisconnectedDesc') }
      : emptyKind === 'cleared'
        ? { title: t('metricsCard.emptyClearedTitle'), desc: t('metricsCard.emptyClearedDesc') }
        : emptyKind === 'idle'
          ? { title: t('metricsCard.emptyIdleTitle'), desc: t('metricsCard.emptyIdleDesc') }
          : emptyKind === 'paused'
            ? {
                title: t('metricsCard.emptyPausedTitle'),
                desc: t('metricsCard.emptyPausedDesc', { count: samples.length }),
              }
            : { title: t('metricsCard.waitingFirstSample'), desc: t('metricsCard.emptyWaitingDesc') }

  const showEmptyAction = connected && samplingState !== 'running'
  const liveText = !connected
    ? t('metricsCard.waitingConnection')
    : cleared
      ? t('metricsCard.cleared')
      : sampling
        ? t('metricsCard.sampling', { count: windowSamples.length })
        : samplingState === 'paused'
          ? t('metricsCard.pausedCount', { count: samples.length })
          : t('metricsCard.idle')

  const toggleSampling = (): void => {
    setCleared(false)
    setSamplingState((prev) => (prev === 'running' ? 'paused' : 'running'))
  }

  const clearSamples = (): void => {
    setSamples([])
    /* 回到 idle 而不是 paused：数据已经清空，按钮与空状态文案都应是「开启」 */
    setSamplingState('idle')
    setCleared(true)
    setError(null)
  }

  return (
    <section className="mt-card s-metrics-card">
      <header className="mt-head">
        <h3 className="mt-title">
          <DialogIcon name="chart" size={14} className="ov-card-icon" />
          <span>{t('metricsCard.title')}</span>
        </h3>
        <span className={`mt-live${!sampling || !connected ? ' off' : ''}`}>
          <i className="mt-dot" />
          {liveText}
        </span>
        <div className="mt-controls">
          <div className="mt-seg" role="group" aria-label={t('metricsCard.title')}>
            {RANGES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`mt-seg-btn${range === item.key ? ' active' : ''}`}
                aria-pressed={range === item.key}
                onClick={() => setRange(item.key)}
              >
                {t(item.label)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="mt-btn primary"
            disabled={!connected}
            {...tipProps(
              t(
                sampling
                  ? 'metricsCard.pauseTip'
                  : samplingState === 'paused'
                    ? 'metricsCard.resumeTip'
                    : 'metricsCard.startTip',
              ),
            )}
            onClick={toggleSampling}
          >
            <DialogIcon name={sampling ? 'pause' : 'play'} size={11} className="ti" />
            {sampling
              ? t('metricsCard.pause')
              : samplingState === 'paused'
                ? t('metricsCard.resume')
                : t('metricsCard.start')}
          </button>
          <button
            type="button"
            className="mt-btn"
            disabled={!samples.length}
            {...tipProps(t('metricsCard.clearSamples'))}
            onClick={clearSamples}
          >
            <DialogIcon name="clear" size={11} className="ti" />
            {t('common.clear')}
          </button>
        </div>
      </header>

      {error ? (
        <p className="mt-error" role="alert">
          <DialogIcon name="warning" size={12} className="ti" />
          {error}
        </p>
      ) : null}

      {ready ? (
        <>
          <MemoryHero
            values={windowSamples.map((sample) => sample.usedMemory)}
            timestamps={timestamps}
            maxMemory={lastSample.maxMemory}
            sampling={sampling && active && connected}
            engine={engine}
          />
          <section className="mt-minis" aria-label={t('metricsCard.title')}>
            {MINI_METRICS.map((def) => (
              <MiniMetric
                key={def.id}
                def={def}
                values={seriesOf(def, windowSamples)}
                timestamps={timestamps}
                engine={engine}
              />
            ))}
          </section>
        </>
      ) : (
        <div className="mt-empty">
          <DialogIcon name="chart" size={30} className="mt-empty-icon" />
          <b className="mt-empty-title">{emptyCopy.title}</b>
          <p className="mt-empty-desc">{emptyCopy.desc}</p>
          {showEmptyAction ? (
            <button type="button" className="mt-btn primary" onClick={toggleSampling}>
              <DialogIcon name="play" size={11} className="ti" />
              {samplingState === 'paused' ? t('metricsCard.resume') : t('metricsCard.start')}
            </button>
          ) : null}
        </div>
      )}

      <p className="mt-hint">{t(engine === 'memcached' ? 'memcachedMetrics.hint' : 'metricsCard.hint')}</p>
    </section>
  )
}

export default MetricsCard

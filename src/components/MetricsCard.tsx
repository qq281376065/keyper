import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
import type { MsgKey } from '@shared/i18n'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { useSessionStore } from '@/hooks/useSessionStore'
import { formatBytes } from '@/utils/format'
import type { MetricsSample } from '@shared/types'

/** 数据源引擎：Memcached 复用采样与绘图骨架，只是 stats 字段名不同 */
type Engine = 'redis' | 'memcached'

/**
 * 监控页签：高频采样 + 自绘 SVG 曲线。
 *
 * 为什么不用图表库：项目没有图表依赖，为六条 sparkline 引入轻则几十 KB、
 * 重则上百 KB 的库并不划算；这里只需要折线 + 面积，SVG path 足够。
 *
 * 采样默认 **不开启**，需要用户点「开启」才开始：
 * 每 2 秒一次 INFO 是持续成本（连接占用、实例侧开销、电池），
 * 打开概览看一眼时不该在后台无声跑起来。
 *
 * 三种状态（三态而非布尔，文案才不会混）：
 *   idle    → 从未开启，按钮「开启」，状态「未开启采样」
 *   running → 采样中，按钮「暂停」
 *   paused  → 开启后暂停，按钮「继续」，已采集的点保留
 *
 * 采样只在「页签激活 + 连接可用 + 处于 running」三者同时成立时进行；
 * 组件本身常驻（页签用 display 切换），因此切走再切回不丢历史点。
 */

const SAMPLE_INTERVAL_MS = 2000
/** 15 分钟 × 每 2 秒一个点；超出后丢弃最旧的 */
const MAX_SAMPLES = 450

type RangeKey = '1m' | '5m' | '15m'

const RANGES: Array<{ key: RangeKey; samples: number; label: MsgKey }> = [
  { key: '1m', samples: 30, label: 'metricsCard.range1m' },
  { key: '5m', samples: 150, label: 'metricsCard.range5m' },
  { key: '15m', samples: 450, label: 'metricsCard.range15m' },
]

/** 字节数：监控里常见 GB 级（maxmemory），formatBytes 只到 MB，这里补一档 */
function formatMetricBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`
  return formatBytes(value)
}

interface MetricDef {
  id: string
  titleKey: MsgKey
  /** 指标含义与数据来源：同名指标在不同版本 / 托管服务里口径可能不同 */
  tipKey: MsgKey
  /** Memcached 下的口径说明：stats 字段与 Redis INFO 不是同一套 */
  mcTipKey: MsgKey
  color: string
  pick: (sample: MetricsSample) => number
  format: (value: number) => string
  /** 累计型指标：曲线画的是「每分钟增量」，累计绝对值只会单调上升 */
  delta?: boolean
}

const METRICS: MetricDef[] = [
  {
    id: 'memory',
    titleKey: 'metricsCard.memory',
    tipKey: 'metricsCard.tipMemory',
    mcTipKey: 'memcachedMetrics.tipMemory',
    color: 'var(--accent)',
    pick: (sample) => sample.usedMemory,
    format: formatMetricBytes,
  },
  {
    id: 'ops',
    titleKey: 'metricsCard.opsPerSec',
    tipKey: 'metricsCard.tipOpsPerSec',
    mcTipKey: 'memcachedMetrics.tipOpsPerSec',
    color: 'var(--blue)',
    pick: (sample) => sample.opsPerSec,
    format: (value) => String(Math.round(value)),
  },
  {
    id: 'clients',
    titleKey: 'metricsCard.clients',
    tipKey: 'metricsCard.tipClients',
    mcTipKey: 'memcachedMetrics.tipClients',
    color: 'var(--green)',
    pick: (sample) => sample.connectedClients,
    format: (value) => String(Math.round(value)),
  },
  {
    id: 'hit',
    titleKey: 'metricsCard.hitRate',
    tipKey: 'metricsCard.tipHitRate',
    mcTipKey: 'memcachedMetrics.tipHitRate',
    color: 'var(--amber)',
    pick: (sample) => sample.hitRate,
    format: (value) => `${value.toFixed(1)}%`,
  },
  {
    id: 'keys',
    titleKey: 'metricsCard.totalKeys',
    tipKey: 'metricsCard.tipTotalKeys',
    mcTipKey: 'memcachedMetrics.tipTotalKeys',
    color: 'var(--purple)',
    pick: (sample) => sample.totalKeys,
    format: (value) => String(Math.round(value)),
  },
  {
    id: 'evicted',
    titleKey: 'metricsCard.evictions',
    tipKey: 'metricsCard.tipEvictions',
    mcTipKey: 'memcachedMetrics.tipEvictions',
    color: 'var(--pink)',
    pick: (sample) => sample.evictedKeys,
    format: (value) => value.toFixed(1),
    delta: true,
  },
]

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
 * 用最长 60 秒的滑动窗口而不是相邻两点：
 * 计数器是阶梯增长的（一次淘汰会让计数器 +1），按相邻点算会把
 * 「20 秒涨 1」放大成「30/分钟」的尖刺。窗口内差值除以真实时长，
 * 曲线反映的是近一分钟的变化速度，和直觉一致。
 */
const DELTA_WINDOW_MS = 60_000

function seriesOf(def: MetricDef, samples: MetricsSample[]): number[] {
  const raw = samples.map((sample) => ({ at: sample.at, value: def.pick(sample) }))
  if (!def.delta) return raw.map((point) => point.value)
  return raw.map((point, index) => {
    let back = index
    while (back > 0 && point.at - raw[back - 1]!.at <= DELTA_WINDOW_MS) back -= 1
    const prev = raw[back]!
    const minutes = (point.at - prev.at) / 60000
    return minutes > 0 ? Math.max(0, (point.value - prev.value) / minutes) : 0
  })
}

function formatClock(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

interface SparklineProps {
  values: number[]
}

/** 折线 + 面积；纵轴按窗口内极值自适应，不画刻度（数值由卡片头部给出） */
function Sparkline({ values }: SparklineProps) {
  const width = 300
  const height = 64
  if (values.length < 2) return <div className="mt-chart-empty" />

  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = width / (values.length - 1)
  const points = values.map((value, index) => {
    const x = index * step
    /* 上下各留 3px，极值点不会被裁掉 */
    const y = height - 3 - ((value - min) / span) * (height - 6)
    return [x, y] as const
  })
  const line = points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(' ')
  const area = `${line} L${width} ${height} L0 ${height} Z`

  return (
    <svg className="mt-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={area} className="mt-spark-area" />
      <path d={line} className="mt-spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
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
  /*
   * 采样默认不开启。
   *
   * 监控每 2 秒打一次 Redis，是持续的成本：连接池占用、实例侧
   * INFO 命令开销、笔记本电池消耗。用户只是打开概览看一眼时，
   * 不该在后台无声地跑起来 —— 这里改为显式「开启」才采样。
   *
   * 三态而非布尔：要区分「从未开启」与「开启后暂停」——
   * 前者按钮应写「开启」，后者写「继续」，文案不能混用。
   */
  const [samplingState, setSamplingState] = useState<'idle' | 'running' | 'paused'>('idle')
  const sampling = samplingState === 'running'
  const [range, setRange] = useState<RangeKey>('5m')
  const [error, setError] = useState<string | null>(null)

  /* 回调注册一次，需要读到最新的连接 id 与暂停态 */
  const idRef = useRef(activeId)
  idRef.current = activeId

  /* Memcached 的 ops/sec 靠相邻采样的累计命令差值换算，需要保存上一次的参照点 */
  const commandMarkRef = useRef<CommandMark | null>(null)

  /*
   * 换连接 / 断开：旧实例的采样不能挂到新连接上。
   *
   * 同时把状态拉回 idle —— 否则换到新连接后会停在「已暂停」，
   * 而新连接其实一个点都没采过，文案与实际不符。
   * 断开同理：重新连上时应回到「开启」，由用户决定要不要采。
   */
  useEffect(() => {
    setSamples([])
    setError(null)
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
  const hiddenCount = samples.length - windowSamples.length

  const firstAt = windowSamples[0]?.at
  const lastAt = windowSamples[windowSamples.length - 1]?.at

  return (
    <section className="mt-card s-metrics-card">
      <header className="mt-head">
        <h3 className="mt-title">
          <DialogIcon name="chart" size={14} className="ov-card-icon" />
          <span>{t('metricsCard.title')}</span>
        </h3>
        <span className={`mt-live${!sampling || !active || !connected ? ' off' : ''}`}>
          <i className="mt-dot" />
          {!connected
            ? t('metricsCard.waitingConnection')
            : samplingState === 'idle'
              ? t('metricsCard.idle')
              : samplingState === 'paused'
                ? t('metricsCard.paused')
                : t('metricsCard.sampling', { count: samples.length })}
        </span>
        <span className="spacer" />
        <div className="mt-ranges" role="group" aria-label={t('metricsCard.title')}>
          {RANGES.map((item) => (
            <button
              key={item.key}
              className={`mt-range-btn${range === item.key ? ' active' : ''}`}
              onClick={() => setRange(item.key)}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
        <button
          className="mt-toggle-btn"
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
          onClick={() =>
            setSamplingState((prev) => (prev === 'running' ? 'paused' : 'running'))
          }
        >
          <DialogIcon name={sampling ? 'stop' : 'play'} size={12} className="ti" />
          {sampling
            ? t('metricsCard.pause')
            : samplingState === 'paused'
              ? t('metricsCard.resume')
              : t('metricsCard.start')}
        </button>
        <button
          className="mt-clear-btn"
          disabled={!samples.length}
          {...tipProps(t('metricsCard.clearSamples'))}
          onClick={() => setSamples([])}
        >
          <DialogIcon name="clear" size={12} className="ti" />
          {t('common.clear')}
        </button>
      </header>

      {error ? (
        <p className="mt-error">
          <DialogIcon name="warning" size={12} className="ti" />
          {error}
        </p>
      ) : null}

      <div className="mt-grid">
        {METRICS.map((def) => {
          const values = seriesOf(def, windowSamples)
          const current = values.length ? values[values.length - 1]! : null
          const min = values.length ? Math.min(...values) : null
          const max = values.length ? Math.max(...values) : null

          return (
            <article key={def.id} className="mt-tile" style={{ color: def.color }}>
              <header className="mt-tile-head">
                <span className="mt-tile-title" {...tipProps(t(engine === 'memcached' ? def.mcTipKey : def.tipKey))}>
                  {t(def.titleKey)}
                </span>
                <span className="mt-tile-now mono">{current == null ? '—' : def.format(current)}</span>
              </header>
              <div className="mt-tile-chart">
                {values.length >= 2 ? (
                  <Sparkline values={values} />
                ) : (
                  <span className="mt-tile-waiting">
                    {t(sampling ? 'metricsCard.waitingFirstSample' : 'metricsCard.clickToStart')}
                  </span>
                )}
              </div>
              <footer className="mt-tile-foot mono">
                <span {...tipProps(t('metricsCard.min'))}>
                  {t('metricsCard.shortMin')} {min == null ? '—' : def.format(min)}
                </span>
                <span {...tipProps(t('metricsCard.max'))}>
                  {t('metricsCard.shortMax')} {max == null ? '—' : def.format(max)}
                </span>
                <span className="spacer" />
                {firstAt && lastAt ? (
                  <span className="mt-tile-ago" {...tipProps(`${formatClock(firstAt)} — ${formatClock(lastAt)}`)}>
                    {t('metricsCard.points', { count: windowSamples.length })}
                    {hiddenCount > 0 ? ` · ${t('metricsCard.olderHidden', { count: hiddenCount })}` : ''}
                  </span>
                ) : null}
              </footer>
            </article>
          )
        })}
      </div>

      <p className="mt-hint">{t(engine === 'memcached' ? 'memcachedMetrics.hint' : 'metricsCard.hint')}</p>
    </section>
  )
}

export default MetricsCard

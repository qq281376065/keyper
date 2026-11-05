import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { FilterBox } from '@/components/FilterBox'
import { VirtualRows } from '@/components/VirtualRows'
import { tipProps } from '@/components/tip'
import { useI18n, type MsgKey } from '@/i18n'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { useSessionStore } from '@/hooks/useSessionStore'
import { copyText } from '@/utils/clipboard'
import type { SlowlogEntry, SlowlogOverview } from '@shared/types'

/** 窗口取最近 100 条：筛选、分组、分页都在这个窗口内完成 */
const SLOWLOG_WINDOW = 100
const AUTO_INTERVAL_MS = 15_000
const PAGE_SIZE = 6
/** 明细首批展示 50 条，之后每次再取 50 条（客户端侧展开，不是分页） */
const DETAIL_PAGE_STEP = 50
/** 超过该条数的明细启用虚拟滚动 */
const VIRTUAL_THRESHOLD = 40

type RangeKey = '1h' | '6h' | '24h' | 'all'
type GroupMode = 'fingerprint' | 'client'
type AutoState = 'off' | 'running' | 'paused'
type Tone = 'crit' | 'warn' | 'norm'

const RANGE_SECONDS: Record<RangeKey, number> = {
  '1h': 3600,
  '6h': 6 * 3600,
  '24h': 24 * 3600,
  all: Number.POSITIVE_INFINITY,
}

/** 最小耗时档位（微秒）；0 表示不限 */
const MIN_DURATIONS = [0, 10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000]

type Translate = (key: MsgKey, params?: Record<string, string | number>) => string

interface SlowGroup {
  key: string
  title: string
  subtitle: string
  entries: SlowlogEntry[]
  count: number
  max: number
  sum: number
  avg: number
  last: number
  tone: Tone
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function formatClock(ts: number): string {
  const date = new Date(ts * 1000)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

function formatDateTime(ts: number): string {
  const date = new Date(ts * 1000)
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatClock(ts)}`
}

/** 耗时：微秒起步（SLOWLOG 原始单位），ms / s 两档展示 */
function formatDuration(micros: number): string {
  if (micros < 1000) return `${Math.round(micros)}μs`
  if (micros < 1_000_000) return `${(micros / 1000).toFixed(micros < 100_000 ? 1 : 0)}ms`
  return `${(micros / 1_000_000).toFixed(2)}s`
}

/** <100ms 正常、100ms–1s 警示、≥1s 告警：与右栏分布同一口径 */
function durationTone(micros: number): Tone {
  if (micros >= 1_000_000) return 'crit'
  if (micros >= 100_000) return 'warn'
  return 'norm'
}

function commandHead(command: string[]): string {
  return (command[0] || '').toUpperCase()
}

function clientLabel(entry: SlowlogEntry, t: Translate): string {
  return entry.clientName || entry.client || t('slowlogCard.unknownClient')
}

function displayTime(ts: number, nowSec: number, t: Translate): string {
  const diff = Math.max(0, nowSec - ts)
  if (diff < 60) return t('slowlogCard.justNow')
  if (diff < 3600) return t('slowlogCard.countMinutesAgo', { count: Math.floor(diff / 60) })
  if (diff < 86_400) return t('slowlogCard.countHoursAgo', { count: Math.floor(diff / 3600) })
  return t('slowlogCard.countDaysAgo', { count: Math.floor(diff / 86_400) })
}

/**
 * 分组口径：
 *   · 指纹 = 命令首词（GET / KEYS / EVAL…），与慢日志排障的直觉一致；
 *   · 客户端 = CLIENT SETNAME 的名字，没有名字时用地址。
 * 两种视图共用同一套汇总字段，切换只换聚合键，不重取数据。
 */
function buildGroups(entries: SlowlogEntry[], mode: GroupMode, t: Translate): SlowGroup[] {
  const buckets = new Map<string, SlowlogEntry[]>()
  for (const entry of entries) {
    const key =
      mode === 'fingerprint'
        ? commandHead(entry.command) || t('slowlogCard.unknownCommand')
        : clientLabel(entry, t)
    const list = buckets.get(key)
    if (list) list.push(entry)
    else buckets.set(key, [entry])
  }

  const groups: SlowGroup[] = []
  for (const [key, list] of buckets) {
    const sorted = [...list].sort((a, b) => b.timestamp - a.timestamp)
    let sum = 0
    let max = 0
    for (const entry of list) {
      sum += entry.duration
      if (entry.duration > max) max = entry.duration
    }

    let title = key
    let subtitle = ''
    if (mode === 'fingerprint') {
      const commands = new Set(list.map((entry) => entry.command.join(' ')))
      title = commands.size === 1 ? [...commands][0] : `${key} …`
      const clients = new Set(list.map((entry) => clientLabel(entry, t)))
      subtitle = `${key || t('slowlogCard.unknownCommand')} · ${t('slowlogCard.clientCount', {
        count: clients.size,
      })} · ${t('slowlogCard.timesCount', { count: list.length })}`
    } else {
      const fingerprints = new Set(list.map((entry) => commandHead(entry.command)))
      const address = sorted[0]?.client || '-'
      subtitle = `${address} · ${t('slowlogCard.fingerprintCount', { count: fingerprints.size })}`
    }

    groups.push({
      key,
      title,
      subtitle,
      entries: sorted,
      count: list.length,
      max,
      sum,
      avg: Math.round(sum / list.length),
      last: sorted[0]?.timestamp ?? 0,
      tone: durationTone(max),
    })
  }

  groups.sort((a, b) => b.count - a.count || b.max - a.max || a.key.localeCompare(b.key))
  return groups
}

/** 页码窗口：总页数多时只保留首页、末页和当前页附近，避免按钮溢出 */
function pageItems(page: number, total: number): Array<number | 'gap'> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1)
  const result: Array<number | 'gap'> = [1]
  const start = Math.max(2, Math.min(page - 1, total - 4))
  const end = Math.min(total - 1, Math.max(page + 1, 5))
  if (start > 2) result.push('gap')
  for (let n = start; n <= end; n++) result.push(n)
  if (end < total - 1) result.push('gap')
  result.push(total)
  return result
}

function Sparkline({ group }: { group: SlowGroup }) {
  const entries = [...group.entries].sort((a, b) => a.timestamp - b.timestamp)
  const count = Math.min(8, entries.length)
  const points: string[] = []
  for (let i = 0; i < count; i++) {
    const index = Math.round((i * (entries.length - 1)) / Math.max(1, count - 1))
    const ratio = group.max > 0 ? entries[index].duration / group.max : 0
    const y = 17 - Math.round(ratio * 15)
    points.push(`${Math.round((i * 120) / Math.max(1, count - 1))},${y}`)
  }
  if (count === 1) points.push(`120,${points[0].split(',')[1]}`)

  const stroke =
    group.tone === 'crit' ? 'var(--red)' : group.tone === 'warn' ? 'var(--amber)' : 'var(--blue)'
  return (
    <svg className="sl-spark" viewBox="0 0 120 18" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points.join(' ')} fill="none" stroke={stroke} strokeWidth="1.5" />
    </svg>
  )
}

/** 明细里的一行：时间 / 耗时占比 / 命令 + 复制 / 客户端 */
function OccurrenceRow({
  entry,
  mode,
  peak,
  nowSec,
}: {
  entry: SlowlogEntry
  mode: GroupMode
  peak: number
  nowSec: number
}) {
  const { t } = useI18n()
  const duration = formatDuration(entry.duration)
  const percent = peak > 0 ? Math.max(1, Math.round((entry.duration / peak) * 100)) : 1
  const tone = durationTone(entry.duration)
  const command = entry.command.join(' ')
  const head = entry.command[0] || t('slowlogCard.unknownCommand')
  const rest = entry.command.slice(1).join(' ')

  return (
    <div className="sl-occrow">
      <span className="sl-when" {...tipProps(formatDateTime(entry.timestamp))}>
        <span className="sl-when-main mono">{formatClock(entry.timestamp)}</span>
        <small>{displayTime(entry.timestamp, nowSec, t)}</small>
      </span>
      <span
        className={`sl-dur ${tone}`}
        {...tipProps(t('slowlogCard.durationShareTip', { duration, percent }))}
      >
        <span className="sl-dur-track">
          <i style={{ width: `${percent}%` }} />
        </span>
      </span>
      <span className="sl-cmd">
        <span className="sl-cmd-text mono" {...tipProps(command)}>
          <b>{head}</b>
          {rest ? <span className="arg"> {rest}</span> : null}
        </span>
        <CopyCommandButton command={command} />
      </span>
      <span className="sl-client">
        {mode === 'client' ? (
          <>
            <span className="sl-client-main mono">{entry.client || '-'}</span>
            <small>{entry.clientName || '-'}</small>
          </>
        ) : (
          <>
            <span className="sl-client-main">{clientLabel(entry, t)}</span>
            <small className="mono">{entry.client}</small>
          </>
        )}
      </span>
    </div>
  )
}

function CopyCommandButton({ command }: { command: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current)
    },
    [],
  )

  async function handleCopy(): Promise<void> {
    const ok = await copyText(command)
    if (!ok) return
    setCopied(true)
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      setCopied(false)
      timer.current = null
    }, 1400)
  }

  const label = copied ? t('slowlogCard.copied') : t('slowlogCard.copyCommand')

  return (
    <button
      type="button"
      className={`sl-copy${copied ? ' copied' : ''}`}
      aria-label={label}
      {...tipProps(label)}
      onClick={() => void handleCopy()}
    >
      <DialogIcon name={copied ? 'check' : 'copy'} size={11} />
    </button>
  )
}

function SlowGroupCard({
  group,
  mode,
  open,
  hidden,
  peak,
  nowSec,
  onToggle,
}: {
  group: SlowGroup
  mode: GroupMode
  open: boolean
  hidden: boolean
  peak: number
  nowSec: number
  onToggle: () => void
}) {
  const { t } = useI18n()
  const [visibleCount, setVisibleCount] = useState(Math.min(group.entries.length, DETAIL_PAGE_STEP))
  const [loadingMore, setLoadingMore] = useState(false)
  const timer = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setVisibleCount((current) =>
      Math.min(
        group.entries.length,
        Math.max(current, Math.min(DETAIL_PAGE_STEP, group.entries.length)),
      ),
    )
  }, [group.entries.length])

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current)
    },
    [],
  )

  const total = group.entries.length
  const visibleEntries = useMemo(
    () => group.entries.slice(0, visibleCount),
    [group.entries, visibleCount],
  )
  const virtual = total > VIRTUAL_THRESHOLD
  const hasMore = total > DETAIL_PAGE_STEP

  function loadMore(): void {
    if (loadingMore || visibleCount >= total) return
    setLoadingMore(true)
    timer.current = window.setTimeout(() => {
      setVisibleCount((current) => Math.min(current + DETAIL_PAGE_STEP, total))
      setLoadingMore(false)
      timer.current = null
    }, 320)
  }

  const row = (entry: SlowlogEntry) => (
    <OccurrenceRow entry={entry} mode={mode} peak={peak} nowSec={nowSec} />
  )
  // VirtualRows 通过 cloneElement 注入 ref 测量行高，宿主必须是 DOM 元素
  const virtualRow = (entry: SlowlogEntry) => (
    <div className="sl-row-host">
      <OccurrenceRow entry={entry} mode={mode} peak={peak} nowSec={nowSec} />
    </div>
  )

  return (
    <div className={`sl-grp${open ? ' open' : ''}`} hidden={hidden}>
      <button type="button" className="sl-sum" aria-expanded={open} onClick={onToggle}>
        <span className="sl-name">
          <b {...tipProps(group.title)}>{group.title}</b>
          <span>{group.subtitle}</span>
        </span>
        <span className="sl-count mono">{t('slowlogCard.timesCount', { count: group.count })}</span>
        <span className={`sl-max ${group.tone}`}>{formatDuration(group.max)}</span>
        <span className="sl-avg mono">
          {t('slowlogCard.averageShort', { duration: formatDuration(group.avg) })}
        </span>
        <Sparkline group={group} />
        <span className="sl-last mono">
          <span>{formatClock(group.last)}</span>
          <em>
            {t('slowlogCard.lastOccurred')} · {displayTime(group.last, nowSec, t)}
          </em>
        </span>
        <DialogIcon name="chevron-down" size={12} className="sl-chev" />
      </button>

      <div className={`sl-occ${virtual ? ' sl-occ-virtual' : ''}`} ref={scrollRef} hidden={!open}>
        {virtual ? (
          <VirtualRows
            rows={visibleEntries}
            rowKey={(entry) => `${entry.id}:${entry.timestamp}`}
            renderRow={virtualRow}
            scrollRef={scrollRef}
          />
        ) : (
          visibleEntries.map((entry) => (
            <div key={`${entry.id}:${entry.timestamp}`}>{row(entry)}</div>
          ))
        )}
      </div>

      {hasMore ? (
        <div className="sl-more" hidden={!open}>
          <span className="sl-more-count">
            {t('slowlogCard.loadedCount', { loaded: visibleCount, total })}
          </span>
          <span className="spacer" />
          <button
            type="button"
            className={`sl-more-btn${loadingMore ? ' loading' : ''}`}
            disabled={loadingMore || visibleCount >= total}
            onClick={loadMore}
          >
            <DialogIcon
              name={visibleCount >= total ? 'check' : loadingMore ? 'refresh' : 'chevron-down'}
              size={10}
            />
            <span>
              {visibleCount >= total
                ? t('slowlogCard.allLoaded')
                : loadingMore
                  ? t('common.loading')
                  : t('slowlogCard.loadMore')}
            </span>
          </button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 服务端慢查询工作台（SLOWLOG GET 100）。
 *
 * 数据只取一次窗口，筛选 / 分组 / 分页全部在本地完成：
 * 每次切换条件都重新 SLOWLOG GET 会把「同一窗口」打散，右栏统计也随之漂移。
 * 自动查询默认关闭，开启后只刷新同一个窗口，不改动任何筛选状态。
 */
export function SlowlogCard({
  registerRefresh,
  active = true,
}: {
  registerRefresh?: (fn: () => Promise<void>) => void
  active?: boolean
}) {
  const { t } = useI18n()
  const { state, activeConnection, notify } = useRedis()
  useObservable(useSessionStore())

  const [overview, setOverview] = useState<SlowlogOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [search, setSearch] = useState('')
  const [minIndex, setMinIndex] = useState(0)
  const [clientFilter, setClientFilter] = useState('')
  const [rangeKey, setRangeKey] = useState<RangeKey>('1h')
  const [mode, setMode] = useState<GroupMode>('fingerprint')
  const [pages, setPages] = useState<Record<GroupMode, number>>({ fingerprint: 1, client: 1 })
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set())
  const [autoState, setAutoState] = useState<AutoState>('off')
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [lastQueryAt, setLastQueryAt] = useState<number | null>(null)

  const activeId = state.activeId
  const connected = activeConnection?.status === 'connected'
  const requestSeq = useRef(0)
  const lastQueryRef = useRef(0)

  const loadSlowlog = useCallback(
    async (options?: { silent?: boolean }): Promise<void> => {
      if (!activeId) return
      const seq = ++requestSeq.current
      if (!options?.silent) setLoading(true)
      setError(null)
      try {
        const res = await api.redis.slowlog(activeId, SLOWLOG_WINDOW)
        if (seq !== requestSeq.current) return
        if (!res.ok) throw new Error(res.error)
        setOverview(res.data)
        const now = Date.now()
        lastQueryRef.current = now
        setLastQueryAt(now)
        setNowMs(now)
      } catch (err) {
        if (seq !== requestSeq.current) return
        setError(err instanceof Error ? err.message : t('slowlogCard.failedLoadSlowQueryLog'))
      } finally {
        if (seq === requestSeq.current) setLoading(false)
      }
    },
    [activeId, t],
  )

  /* 供父组件（概览页统一刷新）调用 */
  useEffect(() => {
    registerRefresh?.(() => loadSlowlog())
  }, [registerRefresh, loadSlowlog])

  /* 连接维度双判定：防「串实例」与「恢复态误拉」 */
  useEffect(() => {
    requestSeq.current++
    setOverview(null)
    setError(null)
    setPages({ fingerprint: 1, client: 1 })
    setOpenGroups(new Set())
    setAutoState('off')
    setLastQueryAt(null)
    lastQueryRef.current = 0
    setNowMs(Date.now())
    if (activeId && connected) void loadSlowlog()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, connected])

  /* 相对时间每秒刷新；页签不在前台时停表，避免隐藏面板持续重渲染 */
  useEffect(() => {
    if (!active) return
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])

  /* 自动查询：只在前台页签运行；到点只刷新窗口，不重置筛选 */
  useEffect(() => {
    if (!active || !connected || !activeId || autoState !== 'running') return
    const timer = window.setInterval(() => {
      setNowMs(Date.now())
      if (Date.now() - lastQueryRef.current >= AUTO_INTERVAL_MS) {
        void loadSlowlog({ silent: true })
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [active, connected, activeId, autoState, loadSlowlog])

  const entries = overview?.entries ?? []
  const nowSec = Math.floor(nowMs / 1000)

  const rangeSeconds = RANGE_SECONDS[rangeKey]
  const rangeLabel =
    rangeKey === '1h'
      ? t('slowlogCard.range1h')
      : rangeKey === '6h'
        ? t('slowlogCard.range6h')
        : rangeKey === '24h'
          ? t('slowlogCard.range24h')
          : t('slowlogCard.windowSlowQueries')

  const rangeEntries = useMemo(
    () => entries.filter((entry) => nowSec - entry.timestamp <= rangeSeconds),
    [entries, nowSec, rangeSeconds],
  )

  const clientOptions = useMemo(() => {
    const names = new Set(entries.map((entry) => clientLabel(entry, t)))
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [entries, t])

  const filteredEntries = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    const minDuration = MIN_DURATIONS[minIndex] ?? 0
    return rangeEntries.filter((entry) => {
      if (entry.duration < minDuration) return false
      if (clientFilter && clientLabel(entry, t) !== clientFilter) return false
      if (!keyword) return true
      const commandText = entry.command.join(' ').toLowerCase()
      return (
        commandText.includes(keyword) ||
        entry.client.toLowerCase().includes(keyword) ||
        entry.clientName.toLowerCase().includes(keyword)
      )
    })
  }, [rangeEntries, search, minIndex, clientFilter, t])

  const groups = useMemo(() => buildGroups(filteredEntries, mode, t), [filteredEntries, mode, t])

  const pageCount = Math.max(1, Math.ceil(groups.length / PAGE_SIZE))
  const page = Math.min(pages[mode], pageCount)
  const pageStart = (page - 1) * PAGE_SIZE

  const peak = useMemo(
    () => rangeEntries.reduce((max, entry) => Math.max(max, entry.duration), 0),
    [rangeEntries],
  )

  const stats = useMemo(() => {
    let count = 0
    let slow = 0
    let sum = 0
    let max = 0
    let under = 0
    let mid = 0
    let crit = 0
    for (const entry of rangeEntries) {
      count++
      sum += entry.duration
      if (entry.duration > max) max = entry.duration
      if (entry.duration >= 1_000_000) {
        slow++
        crit++
      } else if (entry.duration >= 100_000) {
        mid++
      } else {
        under++
      }
    }
    return { count, slow, avg: count ? Math.round(sum / count) : 0, max, under, mid, crit }
  }, [rangeEntries])

  const advice = useMemo(() => {
    if (!rangeEntries.length) return null
    const candidates = buildGroups(rangeEntries, 'fingerprint', t)
    let top: SlowGroup | null = null
    for (const group of candidates) {
      if (!top || group.sum > top.sum) top = group
    }
    return top
  }, [rangeEntries, t])

  const heat = useMemo(() => {
    const counts = Array.from({ length: 24 }, () => [0, 0, 0])
    for (const entry of entries) {
      const age = nowSec - entry.timestamp
      if (age < 0 || age > 86_400) continue
      const date = new Date(entry.timestamp * 1000)
      const third = Math.min(2, Math.floor(date.getMinutes() / 20))
      counts[date.getHours()][third]++
    }
    let max = 0
    for (const hour of counts) {
      for (const value of hour) {
        if (value > max) max = value
      }
    }
    return { counts, peak: max }
  }, [entries, nowSec])

  const maxBucket = Math.max(stats.under, stats.mid, stats.crit, 1)
  const autoElapsed = lastQueryAt ? Math.max(0, Math.floor((nowMs - lastQueryAt) / 1000)) : 0

  function updatePage(next: number): void {
    setPages((current) => ({ ...current, [mode]: Math.min(Math.max(1, next), pageCount) }))
  }

  function toggleGroup(key: string): void {
    const id = `${mode}:${key}`
    setOpenGroups((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function startAuto(): void {
    const now = Date.now()
    lastQueryRef.current = now
    setLastQueryAt(now)
    setNowMs(now)
    setAutoState('running')
    void loadSlowlog({ silent: true })
  }

  function pauseAuto(): void {
    if (autoState === 'running') setAutoState('paused')
  }

  async function resetSlowlog(): Promise<void> {
    if (!activeId || resetting) return
    setResetting(true)
    try {
      const res = await api.redis.slowlogReset(activeId)
      if (!res.ok) throw new Error(res.error)
      await loadSlowlog()
      notify('ok', t('slowlogCard.slowQueryLogCleared'))
    } catch (err) {
      notify('err', err instanceof Error ? err.message : t('slowlogCard.failedClearSlowQueryLog'))
    } finally {
      setResetting(false)
    }
  }

  const autoLabel =
    autoState === 'running'
      ? autoElapsed < 2
        ? t('slowlogCard.autoJustUpdated')
        : t('slowlogCard.autoSecondsAgo', { count: autoElapsed })
      : autoState === 'paused'
        ? t('slowlogCard.autoPaused')
        : t('slowlogCard.autoOff')

  const autoFooter =
    autoState === 'running'
      ? t('slowlogCard.autoFooterRunning', {
          time: lastQueryAt ? formatClock(lastQueryAt / 1000) : '--:--:--',
        })
      : autoState === 'paused'
        ? t('slowlogCard.autoFooterPaused', {
            time: lastQueryAt ? formatClock(lastQueryAt / 1000) : '--:--:--',
          })
        : t('slowlogCard.autoFooterOff')

  return (
    <section className="s-slowlog-card">
      <header className="sl-head">
        <div className="sl-head-main">
          <h3 className="sl-title">
            <DialogIcon name="clock" size={14} className="sl-title-icon" />
            <span>{t('slowlogCard.workbenchTitle')}</span>
          </h3>
          <p className="sl-sub" {...tipProps(t('slowlogCard.commandsSlowerThanSlowlogLog'))}>
            {t('slowlogCard.workbenchSubtitle')}
          </p>
        </div>

        <div className="sl-actions">
          <span className="sl-auto" data-state={autoState}>
            <span className="sl-auto-label">
              <span className="dot" />
              {t('slowlogCard.autoQuery')} <span className="mono">15s</span>
            </span>
            <button
              type="button"
              className="sl-auto-btn sl-auto-start"
              disabled={!connected || autoState === 'running'}
              onClick={startAuto}
            >
              <DialogIcon name="play" size={10} />
              <span>
                {autoState === 'running'
                  ? t('slowlogCard.autoOn')
                  : autoState === 'paused'
                    ? t('slowlogCard.resume')
                    : t('slowlogCard.start')}
              </span>
            </button>
            <button
              type="button"
              className="sl-auto-btn sl-auto-pause"
              disabled={!connected || autoState !== 'running'}
              onClick={pauseAuto}
            >
              <DialogIcon name="pause" size={10} />
              <span>{t('slowlogCard.pause')}</span>
            </button>
            <span className="sl-auto-last mono">{autoLabel}</span>
          </span>

          <button
            type="button"
            className="sl-btn"
            disabled={!connected || loading || resetting}
            onClick={() => void loadSlowlog()}
          >
            <DialogIcon name="refresh" size={12} className={loading ? 'sl-spin' : undefined} />
            {t('common.refresh')}
          </button>
          <button
            type="button"
            className="sl-btn danger"
            disabled={!connected || resetting}
            {...tipProps(t('slowlogCard.clearServerSideSlowQuery'))}
            onClick={() => void resetSlowlog()}
          >
            <DialogIcon name="clear" size={12} />
            {t('common.clear')}
          </button>
        </div>
      </header>

      {error ? (
        <p className="sl-error">{error}</p>
      ) : !connected ? (
        <p className="sl-empty">{t('cliConsole.notConnected')}</p>
      ) : !overview ? (
        <p className="sl-empty">{t('slowlogCard.readingSlowQueryLog')}</p>
      ) : (
        <>
          <div className="sl-filters">
            <div className="sl-field">
              <label>{t('slowlogCard.search')}</label>
              <FilterBox
                value={search}
                onChange={setSearch}
                placeholder={t('slowlogCard.searchPlaceholder')}
                className="sl-search"
              />
            </div>
            <div className="sl-field">
              <label>{t('slowlogCard.minDuration')}</label>
              <div className="sl-slider">
                <input
                  type="range"
                  min={0}
                  max={MIN_DURATIONS.length - 1}
                  step={1}
                  value={minIndex}
                  aria-label={t('slowlogCard.minDuration')}
                  style={
                    {
                      '--fill': `${(minIndex / (MIN_DURATIONS.length - 1)) * 100}%`,
                    } as CSSProperties
                  }
                  onChange={(event) => setMinIndex(Number(event.target.value))}
                />
                <span className="val mono">
                  {minIndex === 0
                    ? t('slowlogCard.minDurationAny')
                    : formatDuration(MIN_DURATIONS[minIndex])}
                </span>
              </div>
            </div>
            <div className="sl-field">
              <label>{t('serverOverview.client')}</label>
              <select
                className="sl-select mono"
                value={clientFilter}
                onChange={(event) => setClientFilter(event.target.value)}
              >
                <option value="">{t('slowlogCard.allClients')}</option>
                {clientOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="sl-field">
              <label>{t('slowlogCard.timeRange')}</label>
              <select
                className="sl-select mono"
                value={rangeKey}
                onChange={(event) => setRangeKey(event.target.value as RangeKey)}
              >
                <option value="1h">{t('slowlogCard.range1h')}</option>
                <option value="6h">{t('slowlogCard.range6h')}</option>
                <option value="24h">{t('slowlogCard.range24h')}</option>
                <option value="all">{t('slowlogCard.rangeAll')}</option>
              </select>
            </div>
            <span className="sl-filter-spacer" />
            <div className="sl-field">
              <label>{t('slowlogCard.match')}</label>
              <span className="sl-match mono">
                {t('slowlogCard.matchSummary', {
                  entries: filteredEntries.length,
                  groups: groups.length,
                })}
              </span>
            </div>
          </div>

          <div className="sl-body">
            <div className="sl-main">
              <div className="sl-ph">
                <DialogIcon name="list" size={12} />
                <span>
                  {mode === 'fingerprint'
                    ? t('slowlogCard.byFingerprint')
                    : t('slowlogCard.byClient')}
                </span>
                <span className="spacer" />
                <div className="sl-toggle" role="group" aria-label={t('slowlogCard.groupingMode')}>
                  <button
                    type="button"
                    className={mode === 'fingerprint' ? 'on' : undefined}
                    aria-pressed={mode === 'fingerprint'}
                    onClick={() => setMode('fingerprint')}
                  >
                    {t('slowlogCard.byFingerprint')}
                  </button>
                  <button
                    type="button"
                    className={mode === 'client' ? 'on' : undefined}
                    aria-pressed={mode === 'client'}
                    onClick={() => setMode('client')}
                  >
                    {t('slowlogCard.byClient')}
                  </button>
                </div>
              </div>

              <div className="sl-list">
                {!entries.length ? (
                  <p className="sl-empty">{t('slowlogCard.noCommandsExceededThresholdRecently')}</p>
                ) : !groups.length ? (
                  <p className="sl-empty">{t('slowlogCard.noMatchingEntries')}</p>
                ) : (
                  groups.map((group, index) => (
                    <SlowGroupCard
                      key={`${mode}:${group.key}`}
                      group={group}
                      mode={mode}
                      open={openGroups.has(`${mode}:${group.key}`)}
                      hidden={index < pageStart || index >= pageStart + PAGE_SIZE}
                      peak={peak}
                      nowSec={nowSec}
                      onToggle={() => toggleGroup(group.key)}
                    />
                  ))
                )}
              </div>

              {groups.length ? (
                <div className="sl-pager">
                  <span className="sl-range">
                    {t('slowlogCard.pagerSummary', {
                      start: pageStart + 1,
                      end: Math.min(pageStart + PAGE_SIZE, groups.length),
                      total: groups.length,
                    })}
                  </span>
                  <span className="spacer" />
                  <div className="sl-pg" role="group" aria-label={t('slowlogCard.groupPager')}>
                    <button
                      type="button"
                      className="sl-pg-btn"
                      aria-label={t('slowlogCard.previousPage')}
                      disabled={page === 1}
                      onClick={() => updatePage(page - 1)}
                    >
                      ‹
                    </button>
                    {pageItems(page, pageCount).map((item, index) =>
                      item === 'gap' ? (
                        <span key={`gap-${index}`} className="sl-pg-gap">
                          …
                        </span>
                      ) : (
                        <button
                          key={item}
                          type="button"
                          className={`sl-pg-btn${item === page ? ' on' : ''}`}
                          aria-label={t('slowlogCard.pageNumber', { page: item })}
                          aria-current={item === page ? 'page' : undefined}
                          onClick={() => updatePage(item)}
                        >
                          {item}
                        </button>
                      ),
                    )}
                    <button
                      type="button"
                      className="sl-pg-btn"
                      aria-label={t('slowlogCard.nextPage')}
                      disabled={page === pageCount}
                      onClick={() => updatePage(page + 1)}
                    >
                      ›
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <aside className="sl-rail">
              <div className="sl-rail-card">
                <h4>{rangeLabel}</h4>
                <div className="sl-rail-row">
                  <span>{t('slowlogCard.windowSlowQueries')}</span>
                  <b>{stats.count}</b>
                </div>
                <div className="sl-rail-row">
                  <span>{t('slowlogCard.oneSecondOrMore')}</span>
                  <b className={stats.slow ? 'crit' : undefined}>{stats.slow}</b>
                </div>
                <div className="sl-rail-row">
                  <span>{t('slowlogCard.averageDuration')}</span>
                  <b>{formatDuration(stats.avg)}</b>
                </div>
                <div className="sl-rail-row">
                  <span>{t('slowlogCard.peakDuration')}</span>
                  <b className={stats.max >= 1_000_000 ? 'crit' : undefined}>
                    {formatDuration(stats.max)}
                  </b>
                </div>
              </div>

              <div className="sl-rail-card">
                <h4>{t('slowlogCard.durationDistribution')}</h4>
                <div className="sl-rail-bars">
                  <div className="sl-rb">
                    <span>{t('slowlogCard.under100ms')}</span>
                    <i className="norm" style={{ width: `${(stats.under / maxBucket) * 100}%` }} />
                    <em>{stats.under}</em>
                  </div>
                  <div className="sl-rb">
                    <span>{t('slowlogCard.between100msAnd1s')}</span>
                    <i style={{ width: `${(stats.mid / maxBucket) * 100}%` }} />
                    <em>{stats.mid}</em>
                  </div>
                  <div className="sl-rb">
                    <span>{t('slowlogCard.oneSecondOrMore')}</span>
                    <i className="crit" style={{ width: `${(stats.crit / maxBucket) * 100}%` }} />
                    <em>{stats.crit}</em>
                  </div>
                </div>
              </div>

              {advice ? (
                <div className="sl-tip">
                  <b>{advice.title}</b>{' '}
                  {t('slowlogCard.railAdviceTail', {
                    count: advice.count,
                    total: formatDuration(advice.sum),
                    range: rangeKey === 'all' ? t('slowlogCard.windowSlowQueries') : rangeLabel,
                  })}
                </div>
              ) : null}

              <div className="sl-rail-card">
                <h4>{t('slowlogCard.autoQuery')}</h4>
                <div className="sl-rail-row">
                  <span>{t('slowlogCard.interval')}</span>
                  <b className="mono">15s</b>
                </div>
                <div className="sl-rail-row">
                  <span>{t('slowlogCard.lastQuery')}</span>
                  <b className="mono">
                    {lastQueryAt ? formatClock(lastQueryAt / 1000) : '--:--:--'}
                  </b>
                </div>
                <div className="sl-rail-row">
                  <span>{t('common.status')}</span>
                  <b
                    className={
                      autoState === 'running' ? 'ok' : autoState === 'paused' ? 'warn' : 'muted'
                    }
                  >
                    {autoState === 'running'
                      ? t('slowlogCard.autoStatusRunning')
                      : autoState === 'paused'
                        ? t('slowlogCard.autoStatusPaused')
                        : t('slowlogCard.autoStatusOff')}
                  </b>
                </div>
              </div>
            </aside>
          </div>

          <div
            className="sl-foot"
            {...tipProps(t('slowlogCard.serverRecordedCountEntriesTotal', { count: overview.len }))}
          >
            <span>{t('slowlogCard.windowFooter', { count: SLOWLOG_WINDOW })}</span>
            <span className="right">{autoFooter}</span>
          </div>

          <div className="sl-density" aria-label={t('slowlogCard.densityTitle')}>
            <div className="sl-density-head">
              <DialogIcon name="clock" size={12} />
              <b>{t('slowlogCard.densityTitle')}</b>
              <span className="muted">{t('slowlogCard.densitySummary', { peak: heat.peak })}</span>
              <span className="sl-legend">
                <span>{t('slowlogCard.legendLess')}</span>
                <i />
                <i className="l1" />
                <i className="l2" />
                <i className="l3" />
                <i className="l4" />
                <span>{t('slowlogCard.legendMore')}</span>
              </span>
            </div>
            <div className="sl-heat">
              {heat.counts.map((rows, hour) => (
                <div className="sl-heat-col" key={hour}>
                  {rows.map((value, third) => {
                    const level =
                      value === 0
                        ? 0
                        : heat.peak > 0 && value / heat.peak <= 0.25
                          ? 1
                          : heat.peak > 0 && value / heat.peak <= 0.5
                            ? 2
                            : heat.peak > 0 && value / heat.peak <= 0.75
                              ? 3
                              : 4
                    const startMin = hour * 60 + third * 20
                    const endMin = startMin + 20
                    const start = `${pad2(Math.floor(startMin / 60))}:${pad2(startMin % 60)}`
                    const end =
                      endMin >= 1440
                        ? '24:00'
                        : `${pad2(Math.floor(endMin / 60))}:${pad2(endMin % 60)}`
                    return (
                      <i
                        key={third}
                        className={`sl-heat-cell l${level}`}
                        {...tipProps(t('slowlogCard.densityCellTip', { start, end, count: value }))}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
            <div className="sl-hours">
              {heat.counts.map((_, hour) => (
                <span key={hour}>{hour % 3 === 0 ? pad2(hour) : ''}</span>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

export default SlowlogCard

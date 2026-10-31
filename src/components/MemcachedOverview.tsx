import { useCallback, useEffect, useRef, useState } from 'react'
import { DialogIcon, type DialogIconName } from '@/components/DialogIcon'
import { MetricsCard } from '@/components/MetricsCard'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
import { api } from '@/api'
import { useRedis } from '@/store/useRedis'
import { formatBytes } from '@/utils/format'
import { emitMcKeysChanged } from '@/utils/memcachedEvents'
import type { MsgKey, TFunction } from '@shared/i18n'
import type { MemcachedOverview, MemcachedSlab } from '@shared/types'

/**
 * Memcached 服务端信息面板。
 *
 * 与 Redis 的 ServerOverview 是**两个独立组件**，不做成"一个组件里两套分支"：
 *   · 两者的页签语义完全不同（Redis 是 9 段落 INFO / 慢查询 / 内存 / Pub-Sub；
 *     Memcached 是 统计 / 设置）；
 *   · 合并会让单个文件膨胀到难以维护，且任一侧改动都要重新理解另一侧；
 *   · 隔离之后，Memcached 面板出错不会波及 Redis 面板的渲染路径。
 *
 * 设计取舍：
 *   1. Memcached 没有"库"的概念，因此不出现任何 db 相关 UI；
 *   2. 键浏览统一走左侧键栏（含 slab 分组、搜索、删除），详情页不再重复一份；
 *   3. 服务、内存、状态三组关键数字放在顶部卡片；
 *   4. 所有数值都可能因为服务端禁用而未提供，一律显示 `—` 而不是 0 ——
 *      0 会被读成"确实是零"，而 `—` 表示"没拿到"。
 */

type Tab = 'stats' | 'settings' | 'monitor'

const TABS: Array<{ key: Tab; label: MsgKey; icon: DialogIconName }> = [
  { key: 'stats', label: 'memcachedOverview.stats', icon: 'info' },
  { key: 'settings', label: 'memcachedOverview.settings', icon: 'settings' },
  { key: 'monitor', label: 'metricsCard.title', icon: 'chart' },
]

/** 取数值，缺失时给 undefined 而不是 0 —— 让界面能区分"零"与"没数据" */
function num(stats: Record<string, string>, key: string): number | undefined {
  const raw = stats[key]
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** 百分比：命中率这类指标缺失分母时返回 undefined */
function pct(hit: number | undefined, total: number | undefined): number | undefined {
  if (hit === undefined || total === undefined || total <= 0) return undefined
  return (hit / total) * 100
}

export function MemcachedOverview() {
  const { t } = useI18n()
  const { state, activateAndRefresh, askConfirm, notify } = useRedis()
  const connection = state.connections.find((item) => item.id === state.activeId)
  const id = state.activeId

  const [tab, setTab] = useState<Tab>('stats')
  const [overview, setOverview] = useState<MemcachedOverview | null>(null)
  const [slabs, setSlabs] = useState<MemcachedSlab[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  /** 统计项筛选：与左栏键筛选分开 —— 这里筛的是 stats 的字段名 */
  const [statFilter, setStatFilter] = useState('')
  /** 统计项的精确匹配（全等）；关闭时为子串匹配 */
  const [statExact, setStatExact] = useState(false)

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const load = useCallback(
    async (silent = false) => {
      if (!id) return
      if (!silent) setLoading(true)
      setError(null)
      try {
        const res = await api.memcached.overview(id)
        if (!aliveRef.current) return
        if (!res.ok) throw new Error(res.error)
        setOverview(res.data)
        const slabRes = await api.memcached.slabs(id)
        if (!aliveRef.current) return
        if (slabRes.ok) setSlabs(slabRes.data)
      } catch (err) {
        if (aliveRef.current) setError(err instanceof Error ? err.message : t('common.loadFailed'))
      } finally {
        if (aliveRef.current) setLoading(false)
      }
    },
    [id],
  )

  useEffect(() => {
    void load()
  }, [id, load])

  async function refreshAll(): Promise<void> {
    setRefreshing(true)
    try {
      await load(true)
      await activateAndRefresh(state.activeId ?? '')
    } finally {
      if (aliveRef.current) setRefreshing(false)
    }
  }

  async function flushAll(): Promise<void> {
    if (!id) return
    const ok = await askConfirm({
      title: t('memcachedOverview.clearAllData'),
      message: t('memcachedOverview.flushAllRunClearCached'),
      details: [
        { label: t('memcachedOverview.instance'), value: `${connection?.host ?? ''}:${connection?.port ?? ''}`, mono: true },
        { label: t('memcachedOverview.currentEntry'), value: String(num(overview?.stats ?? {}, 'curr_items') ?? '—'), mono: true },
      ],
      warning: t('memcachedOverview.irreversibleAllEncompassing'),
      confirmText: t('common.clear'),
      danger: true,
      force: true,
    })
    if (!ok) return
    const res = await api.memcached.flush(id)
    if (res.ok && res.data.ok) {
      notify('ok', res.data.message ?? t('memcachedOverview.cleared'))
      await load()
      emitMcKeysChanged()
    } else {
      notify('err', res.ok ? (res.data.message ?? t('memcachedOverview.clearFailed')) : res.error)
    }
  }

  const stats = overview?.stats ?? {}
  const currItems = num(stats, 'curr_items')
  const usedBytes = num(stats, 'bytes')
  const limitBytes = num(stats, 'limit_maxbytes')
  const usage = pct(usedBytes, limitBytes)
  const evictions = num(stats, 'evictions')
  const currConn = num(stats, 'curr_connections')
  const version = overview?.version || connection?.version || '—'
  const uptime = num(stats, 'uptime')

  const cards: Array<{ title: string; icon: DialogIconName; rows: Array<{ label: string; value: string; tone?: 'warn' | 'bad' }> }> = [
    {
      title: t('memcachedOverview.service'),
      icon: 'info',
      rows: [
        { label: t('memcachedOverview.version'), value: version },
        { label: t('memcachedOverview.threads'), value: stats.threads ?? '—' },
        { label: t('memcachedOverview.uptime'), value: uptime === undefined ? '—' : formatUptime(uptime, t) },
      ],
    },
    {
      title: t('common.memory'),
      icon: 'memory',
      rows: [
        {
          label: t('memcachedOverview.used'),
          value: usedBytes === undefined ? '—' : formatBytes(usedBytes),
        },
        {
          label: t('memcachedOverview.limit'),
          value: limitBytes === undefined ? '—' : formatBytes(limitBytes),
          tone: usage !== undefined && usage > 90 ? 'warn' : undefined,
        },
        { label: t('memcachedOverview.usage'), value: usage === undefined ? '—' : `${usage.toFixed(1)}%` },
      ],
    },
    {
      title: t('common.status'),
      icon: 'activity',
      rows: [
        { label: t('memcachedOverview.currentConnection'), value: currConn === undefined ? '—' : String(currConn) },
        {
          label: t('memcachedOverview.evictions'),
          value: evictions === undefined ? '—' : String(evictions),
          /* 有淘汰说明内存不够，是要处理的信号 */
          tone: evictions !== undefined && evictions > 0 ? 'bad' : undefined,
        },
        { label: t('memcachedOverview.totalEntries'), value: stats.total_items ?? '—' },
      ],
    },
  ]

  /**
   * 统计项筛选结果。
   *
   * 模糊：子串、不区分大小写（找 "evict" 能命中 evictions / evicted_unfetched）；
   * 精确：字段名全等、区分大小写（stats 的键名有 `curr_items` 与 `curr_connections`
   * 这种前缀相同的一族，精确模式用来精确锁定其中一个）。
   *
   * 精确模式区分大小写是有意的：stats 的字段名本身就区分大小写敏感信息
   * （如 `pid` 与 `PID` 在不同实现里含义不同），模糊时放宽、精确时严格，
   * 与搜索框的语义一致。
   */
  const statRows = (() => {
    const all = Object.entries(stats)
    const kw = statFilter.trim()
    if (!kw) return all
    return statExact
      ? all.filter(([key]) => key === kw)
      : all.filter(([key]) => key.toLowerCase().includes(kw.toLowerCase()))
  })()

  return (
    <div className="overview s-mc-overview">
      <header className="ov-head">
        <div className="ov-ident">
          <span className="ov-name">{connection?.name ?? t('memcachedOverview.currentInstance')}</span>
          <span className="ov-endpoint mono">
            {connection ? `${connection.host}:${connection.port}` : ''}
          </span>
          <span className="engine-chip engine-memcached" {...tipProps('Memcached')}>
            M
          </span>
          {/* 经隧道连接时标出跳板机：同样的实例地址可能走不同跳板，连不通时先看这里 */}
          {connection?.sshEnabled ? (
            <span className="ov-ssh">{connection.sshHost ? `SSH · ${connection.sshHost}` : 'SSH'}</span>
          ) : null}
        </div>
        <button
          className="ov-refresh"
          disabled={refreshing}
          {...tipProps(t('memcachedOverview.refreshStatistics'))}
          onClick={() => void refreshAll()}
        >
          <DialogIcon name="refresh" size={13} className={`ti${refreshing ? ' spin' : ''}`} />
          {refreshing ? t('memcachedOverview.refreshing') : t('common.refresh')}
        </button>
      </header>

      {error ? (
        <div className="mc-error">
          <DialogIcon name="warning" size={14} />
          <span>{error}</span>
          <button className="mc-retry" onClick={() => void load()}>
            {t('memcachedOverview.retry')}
          </button>
        </div>
      ) : null}

      {loading && !overview ? (
        <div className="ov-loading">
          <span className="ov-badge">Memcached</span>
          <p>{t('memcachedOverview.readingStatistics')}</p>
          <p className="ov-hint">{t('memcachedOverview.ifThereNoResponseFor')}</p>
        </div>
      ) : (
        <>
          {/* 四张概览卡：运维先看这四组，再看明细 */}
          <div className="mc-cards">
            {cards.map((card) => (
              <section key={card.title} className="mc-card">
                <h3 className="mc-card-title">
                  <DialogIcon name={card.icon} size={12} className="mc-card-icon" />
                  {card.title}
                </h3>
                <dl className="mc-rows">
                  {card.rows.map((row) => (
                    <div key={row.label} className="mc-row">
                      <dt>{row.label}</dt>
                      <dd className={`${row.tone ?? ''}`.trim()}>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>

          <nav className="ov-tabs mc-tabs">
            {TABS.map((item) => (
              <button
                key={item.key}
                className={`ov-tab${tab === item.key ? ' active' : ''}`}
                onClick={() => setTab(item.key)}
              >
                <DialogIcon name={item.icon} size={13} className="ov-tab-ico" />
                {t(item.label)}
              </button>
            ))}
          </nav>

          {/* 页签常驻、display 切换：监控采样历史与统计筛选状态都靠组件存活保留 */}
          <div className="ov-tab-pane" style={tab === 'stats' ? undefined : { display: 'none' }}>
            <section className="mc-pane-card">
              <header className="mc-pane-head">
                <h4 className="mc-pane-title">{t('memcachedOverview.allStats')}</h4>
                <span className="mc-pane-count mono">
                  {statRows.length === Object.keys(stats).length
                    ? t('memcachedOverview.countItems', { count: statRows.length })
                    : `${statRows.length} / ${Object.keys(stats).length}`}
                </span>
                <span className="spacer" />
                {/*
                  统计项搜索：胶囊输入 + 精确开关。
                  Memcached 的 stats 有近百项（slab 越多越多），
                  没有筛选时想找一个具体字段只能靠肉眼扫。
                */}
                <div className={`mc-search${statExact ? ' exact' : ''}`}>
                  <DialogIcon name="search" size={11} className="mc-search-icon" />
                  <input
                    value={statFilter}
                    onChange={(event) => setStatFilter(event.target.value)}
                    className="mc-search-input mono"
                    placeholder={statExact ? t('memcachedOverview.fullFieldName') : t('memcachedOverview.searchFieldNames')}
                    spellCheck={false}
                  />
                  {statFilter ? (
                    <button
                      className="mc-search-clear"
                      {...tipProps(t('memcachedOverview.clear'))}
                      onClick={() => setStatFilter('')}
                    >
                      <DialogIcon name="cancel" size={10} />
                    </button>
                  ) : null}
                  <button
                    className={`mc-search-exact${statExact ? ' on' : ''}`}
                    role="checkbox"
                    aria-checked={statExact}
                    {...tipProps(statExact ? t('memcachedOverview.exactMatch') : t('memcachedOverview.fuzzyMatch'))}
                    onClick={() => setStatExact((v) => !v)}
                  >
                    Aa
                  </button>
                </div>
              </header>
              {statRows.length ? (
                <div className="mc-stat-grid">
                  {statRows.map(([key, value]) => (
                    <div key={key} className="mc-stat">
                      <span className="mc-stat-key mono" {...tipProps(key)}>
                        {key}
                      </span>
                      <span className="mc-stat-val mono" {...tipProps(value)}>
                        {value}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mc-empty">
                  {t('memcachedOverview.noStatsItemsMatchFilter', { filter: statFilter })}
                  {statExact ? t('memcachedOverview.exactMatchHint') : ''}
                </p>
              )}
            </section>

            <section className="mc-pane-card">
              <header className="mc-pane-head">
                <h4 className="mc-pane-title">{t('memcachedOverview.slabDistribution')}</h4>
                <span className="mc-pane-count mono">{t('memcachedOverview.countClasses', { count: slabs.length })}</span>
              </header>
              {slabs.length ? (
                <table className="mc-table">
                  <thead>
                    <tr>
                      <th>slab</th>
                      <th>{t('memcachedOverview.entries')}</th>
                      <th>{t('memcachedOverview.oldestEntry')}</th>
                      <th>{t('memcachedOverview.evictions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slabs.map((slab) => (
                      <tr key={slab.slab}>
                        <td className="mono">{slab.slab}</td>
                        <td className="mono">{slab.count}</td>
                        <td className="mono">{formatUptime(slab.age, t)}</td>
                        <td className={`mono${slab.evicted > 0 ? ' bad' : ''}`.trim()}>{slab.evicted}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="mc-empty">{t('memcachedOverview.currentInstanceNoCached')}</p>
              )}
            </section>
          </div>

          <div className="ov-tab-pane" style={tab === 'settings' ? undefined : { display: 'none' }}>
            <section className="mc-pane-card">
              <header className="mc-pane-head">
                <h4 className="mc-pane-title">{t('memcachedOverview.runtimeParameters')}</h4>
                <span className="mc-pane-count mono">{t('memcachedOverview.countItems', { count: Object.keys(overview?.settings ?? {}).length })}</span>
                <span className="spacer" />
                <button className="mc-run danger" onClick={() => void flushAll()}>
                  <DialogIcon name="trash" size={12} className="ti" />
                  {t('memcachedOverview.clearAllData')}
                </button>
              </header>
              {Object.keys(overview?.settings ?? {}).length ? (
                <div className="mc-stat-grid">
                  {Object.entries(overview!.settings).map(([key, value]) => (
                    <div key={key} className="mc-stat">
                      <span className="mc-stat-key mono">{key}</span>
                      <span className="mc-stat-val mono">{value}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mc-empty">
                  {t('memcachedOverview.instanceNotReturnSettings')}
                </p>
              )}
            </section>
          </div>

          <div className="ov-tab-pane" style={tab === 'monitor' ? undefined : { display: 'none' }}>
            <MetricsCard active={tab === 'monitor'} engine="memcached" />
          </div>
        </>
      )}
    </div>
  )
}

/** 运行时长：86400 这类秒数对人类不直观，转成「1 天 2 小时」 */
function formatUptime(seconds: number, t: TFunction): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 60) return t('bulkOpsPanel.seconds', { seconds: Math.floor(seconds) })
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return t('memcachedOverview.daysHours', { days, hours })
  if (hours > 0) return t('memcachedOverview.hoursMinutes', { hours, minutes })
  return t('memcachedOverview.minutes', { minutes })
}

export default MemcachedOverview

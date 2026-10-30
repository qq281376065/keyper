import { useCallback, useEffect, useRef, useState } from 'react'
import { DialogIcon, type DialogIconName } from '@/components/DialogIcon'
import { SearchFilterBox } from '@/components/SearchFilterBox'
import { tipProps } from '@/components/tip'
import { api } from '@/api'
import { useRedis } from '@/store/useRedis'
import type { ConfirmRequest } from '@/store/session'
import { formatBytes } from '@/utils/format'
import { emitMcKeysChanged } from '@/utils/memcachedEvents'
import type { MemcachedKeyList, MemcachedOverview, MemcachedSlab } from '@shared/types'

/**
 * Memcached 服务端信息面板。
 *
 * 与 Redis 的 ServerOverview 是**两个独立组件**，不做成"一个组件里两套分支"：
 *   · 两者的页签语义完全不同（Redis 是 9 段落 INFO / 慢查询 / 内存 / Pub-Sub；
 *     Memcached 是 统计 / 键浏览 / 设置）；
 *   · 合并会让单个文件膨胀到难以维护，且任一侧改动都要重新理解另一侧；
 *   · 隔离之后，Memcached 面板出错不会波及 Redis 面板的渲染路径。
 *
 * 设计取舍：
 *   1. Memcached 没有"库"的概念，因此不出现任何 db 相关 UI；
 *   2. 键浏览依赖 `stats cachedump`（调试命令），界面必须如实标注其限制，
 *      否则用户会以为"键就只有这些"；
 *   3. 命中率、淘汰数是 Memcached 运维最关心的两个数，放在顶部卡片；
 *   4. 所有数值都可能因为服务端禁用而未提供，一律显示 `—` 而不是 0 ——
 *      0 会被读成"确实是零"，而 `—` 表示"没拿到"。
 */

type Tab = 'stats' | 'keys' | 'settings'

const TABS: Array<{ key: Tab; label: string; icon: DialogIconName }> = [
  { key: 'stats', label: '统计', icon: 'info' },
  { key: 'keys', label: '键浏览', icon: 'tree' },
  { key: 'settings', label: '设置', icon: 'settings' },
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
  const { state, activateAndRefresh, askConfirm, notify } = useRedis()
  const connection = state.connections.find((item) => item.id === state.activeId)
  const id = state.activeId

  const [tab, setTab] = useState<Tab>('stats')
  const [overview, setOverview] = useState<MemcachedOverview | null>(null)
  const [slabs, setSlabs] = useState<MemcachedSlab[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  /** 键浏览：显式触发，避免大实例上一进面板就扫全库 */
  const [keys, setKeys] = useState<MemcachedKeyList | null>(null)
  const [keysLoading, setKeysLoading] = useState(false)
  const [keysError, setKeysError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ key: string; data: string; bytes: number; flags: number } | null>(null)
  const [keyFilter, setKeyFilter] = useState('')
  /** 键筛选的精确匹配：开启后按键名全等（区别于子串） */
  const [keyExact, setKeyExact] = useState(false)
  /** 统计项筛选：与键筛选分开 —— 一个筛 stats 的 key，一个筛缓存键名 */
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
        if (aliveRef.current) setError(err instanceof Error ? err.message : '读取失败')
      } finally {
        if (aliveRef.current) setLoading(false)
      }
    },
    [id],
  )

  useEffect(() => {
    setKeys(null)
    setSelected(null)
    setKeyFilter('')
    setKeyExact(false)
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

  async function loadKeys(): Promise<void> {
    if (!id) return
    setKeysLoading(true)
    setKeysError(null)
    try {
      const res = await api.memcached.keys(id, { perSlab: 500 })
      if (!aliveRef.current) return
      if (!res.ok) throw new Error(res.error)
      setKeys(res.data)
    } catch (err) {
      if (aliveRef.current) setKeysError(err instanceof Error ? err.message : '读取失败')
    } finally {
      if (aliveRef.current) setKeysLoading(false)
    }
  }

  async function openKey(key: string): Promise<void> {
    if (!id) return
    try {
      const res = await api.memcached.get(id, key)
      if (!res.ok) throw new Error(res.error)
      if (!res.data.found) {
        notify('err', '键已过期或被删除')
        return
      }
      setSelected({ key, data: res.data.data, bytes: res.data.bytes, flags: res.data.flags })
    } catch (err) {
      notify('err', err instanceof Error ? err.message : '读取失败')
    }
  }

  async function removeKey(key: string): Promise<void> {
    if (!id) return
    const target = keys?.items.find((item) => item.key === key)
    const details: NonNullable<ConfirmRequest['details']> = [
      { label: '键名', value: key, mono: true },
    ]
    if (target) {
      details.push({
        label: '过期',
        value: target.expiresAt ? formatExpiry(target.expiresAt) : '永久',
        mono: true,
        tone: 'muted',
      })
      details.push({ label: '大小', value: formatBytes(target.bytes), mono: true, tone: 'muted' })
    }
    const ok = await askConfirm({
      title: '删除键',
      message: '即将从当前实例中移除该键：',
      details,
      warning: '此操作不可撤销，键及其全部数据将被立即删除；依赖该缓存的请求会回源。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    const res = await api.memcached.remove(id, key)
    if (res.ok && res.data.ok) {
      notify('ok', res.data.message ?? '已删除')
      setSelected(null)
      await loadKeys()
      emitMcKeysChanged()
    } else {
      notify('err', res.ok ? (res.data.message ?? '删除失败') : res.error)
    }
  }

  async function flushAll(): Promise<void> {
    if (!id) return
    const ok = await askConfirm({
      title: '清空全部数据',
      message: '即将执行 flush_all，清空该 Memcached 实例的所有缓存项：',
      details: [
        { label: '实例', value: `${connection?.host ?? ''}:${connection?.port ?? ''}`, mono: true },
        { label: '当前条目', value: String(num(overview?.stats ?? {}, 'curr_items') ?? '—'), mono: true },
      ],
      warning: '这是不可撤销的整体操作，所有业务缓存会同时失效。',
      confirmText: '清空',
      danger: true,
      force: true,
    })
    if (!ok) return
    const res = await api.memcached.flush(id)
    if (res.ok && res.data.ok) {
      notify('ok', res.data.message ?? '已清空')
      setKeys(null)
      setSelected(null)
      await load()
      emitMcKeysChanged()
    } else {
      notify('err', res.ok ? (res.data.message ?? '清空失败') : res.error)
    }
  }

  const stats = overview?.stats ?? {}
  const currItems = num(stats, 'curr_items')
  const getHits = num(stats, 'get_hits')
  const getMisses = num(stats, 'get_misses')
  const hitRate = pct(getHits, (getHits ?? 0) + (getMisses ?? 0))
  const usedBytes = num(stats, 'bytes')
  const limitBytes = num(stats, 'limit_maxbytes')
  const usage = pct(usedBytes, limitBytes)
  const evictions = num(stats, 'evictions')
  const currConn = num(stats, 'curr_connections')
  const version = overview?.version || connection?.version || '—'
  const uptime = num(stats, 'uptime')

  const cards: Array<{ title: string; icon: DialogIconName; rows: Array<{ label: string; value: string; tone?: 'warn' | 'bad' }> }> = [
    {
      title: '服务',
      icon: 'info',
      rows: [
        { label: '版本', value: version },
        { label: '线程数', value: stats.threads ?? '—' },
        { label: '运行时长', value: uptime === undefined ? '—' : formatUptime(uptime) },
      ],
    },
    {
      title: '内存',
      icon: 'memory',
      rows: [
        {
          label: '已用',
          value: usedBytes === undefined ? '—' : formatBytes(usedBytes),
        },
        {
          label: '上限',
          value: limitBytes === undefined ? '—' : formatBytes(limitBytes),
          tone: usage !== undefined && usage > 90 ? 'warn' : undefined,
        },
        { label: '占用率', value: usage === undefined ? '—' : `${usage.toFixed(1)}%` },
      ],
    },
    {
      title: '命中',
      icon: 'bolt',
      rows: [
        {
          label: '命中率',
          value: hitRate === undefined ? '—' : `${hitRate.toFixed(1)}%`,
          /* 低于 90% 用琥珀提醒：通常意味着缓存没起作用 */
          tone: hitRate !== undefined && hitRate < 90 ? 'warn' : undefined,
        },
        { label: '命中/未中', value: getHits === undefined && getMisses === undefined ? '—' : `${getHits ?? 0} / ${getMisses ?? 0}` },
        { label: '条目数', value: currItems === undefined ? '—' : String(currItems) },
      ],
    },
    {
      title: '状态',
      icon: 'activity',
      rows: [
        { label: '当前连接', value: currConn === undefined ? '—' : String(currConn) },
        {
          label: '淘汰数',
          value: evictions === undefined ? '—' : String(evictions),
          /* 有淘汰说明内存不够，是要处理的信号 */
          tone: evictions !== undefined && evictions > 0 ? 'bad' : undefined,
        },
        { label: '总条目', value: stats.total_items ?? '—' },
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

  /**
   * 键筛选：模糊为子串、不区分大小写；精确为键名全等、区分大小写 ——
   * 与左栏键浏览器的筛选语义保持一致，两处给出的结果不会互相矛盾。
   */
  const keyKw = keyFilter.trim()
  const filteredKeys = (keys?.items ?? []).filter((item) =>
    !keyKw ? true : keyExact ? item.key === keyKw : item.key.toLowerCase().includes(keyKw.toLowerCase()),
  )

  return (
    <div className="overview s-mc-overview">
      <header className="ov-head">
        <div className="ov-ident">
          <span className="ov-name">{connection?.name ?? '当前实例'}</span>
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
          {...tipProps('刷新统计信息')}
          onClick={() => void refreshAll()}
        >
          <DialogIcon name="refresh" size={13} className={`ti${refreshing ? ' spin' : ''}`} />
          {refreshing ? '刷新中…' : '刷新'}
        </button>
      </header>

      {error ? (
        <div className="mc-error">
          <DialogIcon name="warning" size={14} />
          <span>{error}</span>
          <button className="mc-retry" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}

      {loading && !overview ? (
        <div className="ov-loading">
          <span className="ov-badge">Memcached</span>
          <p>正在读取统计信息…</p>
          <p className="ov-hint">若长时间无响应，请检查实例是否仍然可用</p>
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
                {item.label}
              </button>
            ))}
          </nav>

          {tab === 'stats' ? (
            <div className="ov-tab-pane">
              <section className="mc-pane-card">
                <header className="mc-pane-head">
                  <h4 className="mc-pane-title">全部统计项</h4>
                  <span className="mc-pane-count mono">
                    {statRows.length === Object.keys(stats).length
                      ? `${statRows.length} 项`
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
                      placeholder={statExact ? '完整字段名' : '搜索字段名'}
                      spellCheck={false}
                    />
                    {statFilter ? (
                      <button
                        className="mc-search-clear"
                        {...tipProps('清除')}
                        onClick={() => setStatFilter('')}
                      >
                        <DialogIcon name="cancel" size={10} />
                      </button>
                    ) : null}
                    <button
                      className={`mc-search-exact${statExact ? ' on' : ''}`}
                      role="checkbox"
                      aria-checked={statExact}
                      {...tipProps(statExact ? '精确匹配（点击切换为模糊）' : '模糊匹配（点击切换为精确）')}
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
                    没有匹配「{statFilter}」的统计项
                    {statExact ? '（当前为精确匹配，试试切换为模糊）' : ''}
                  </p>
                )}
              </section>

              <section className="mc-pane-card">
                <header className="mc-pane-head">
                  <h4 className="mc-pane-title">slab 分布</h4>
                  <span className="mc-pane-count mono">{slabs.length} 个 class</span>
                </header>
                {slabs.length ? (
                  <table className="mc-table">
                    <thead>
                      <tr>
                        <th>slab</th>
                        <th>条目数</th>
                        <th>最老条目</th>
                        <th>淘汰数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {slabs.map((slab) => (
                        <tr key={slab.slab}>
                          <td className="mono">{slab.slab}</td>
                          <td className="mono">{slab.count}</td>
                          <td className="mono">{formatUptime(slab.age)}</td>
                          <td className={`mono${slab.evicted > 0 ? ' bad' : ''}`.trim()}>{slab.evicted}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="mc-empty">当前实例没有缓存条目</p>
                )}
              </section>
            </div>
          ) : null}

          {tab === 'keys' ? (
            <div className="ov-tab-pane">
              <section className="mc-pane-card mc-keys-card">
                <header className="mc-pane-head">
                  <h4 className="mc-pane-title">键列表</h4>
                  <span className="spacer" />
                  <button className="mc-run" disabled={keysLoading} onClick={() => void loadKeys()}>
                    <DialogIcon name="search" size={12} className="ti" />
                    {keysLoading ? '读取中…' : keys ? '重新读取' : '读取键列表'}
                  </button>
                </header>

                {/*
                  键搜索：直接复用左栏的 SearchFilterBox（历史 + 幽灵补全 +
                  精确匹配 + 回车重读）。外面这层 s-key-browser 只是它的
                  样式作用域；历史按「连接 @ 0」分桶，与左栏搜索共用同一份记录。
                */}
                <div className="s-key-browser mc-ov-search">
                  <SearchFilterBox
                    value={keyFilter}
                    onChange={setKeyFilter}
                    exact={keyExact}
                    onToggleExact={() => setKeyExact((v) => !v)}
                    onSearch={() => void loadKeys()}
                    connectionId={id}
                    historyDb={0}
                    scopeLabel="Memcached"
                    placeholder={keyExact ? '输入完整键名' : '输入即筛，回车重新读取'}
                  />
                </div>

                {/*
                  限制说明必须常驻，而不是折叠进 tooltip：
                  cachedump 是调试命令，结果可能不完整，
                  用户拿它做"有没有这个键"的判断会出错。
                */}
                <p className="mc-warn-line">
                  <DialogIcon name="warning" size={12} className="ti" />
                  Memcached 没有 KEYS/SCAN，此处通过 <code className="mono">stats cachedump</code> 按 slab
                  取样（每个 slab 最多 500 条）。结果可能不完整，仅供排查参考；不会影响服务端数据。
                </p>

                {keysError ? <p className="mc-error-line">{keysError}</p> : null}

                {keys ? (
                  <>
                    {keys.truncated ? (
                      <p className="mc-note-line">取样已达上限，列表中可能缺少部分键。</p>
                    ) : null}
                    {keys.deniedSlabs.length ? (
                      <p className="mc-note-line">
                        以下 slab 拒绝返回数据（服务端可能禁用了 cachedump）：{keys.deniedSlabs.join('、')}
                      </p>
                    ) : null}
                    {filteredKeys.length ? (
                      <div className="mc-key-list">
                        {filteredKeys.map((item) => (
                          <div
                            key={`${item.slab}:${item.key}`}
                            className={`mc-key-row${selected?.key === item.key ? ' active' : ''}`}
                            onClick={() => void openKey(item.key)}
                          >
                            <span className="mc-key-slab mono">{item.slab}</span>
                            <span className="mc-key-name mono ellipsis">{item.key}</span>
                            <span className="mc-key-bytes mono">{formatBytes(item.bytes)}</span>
                            <span className="mc-key-exp mono">
                              {item.expiresAt ? formatExpiry(item.expiresAt) : '永久'}
                            </span>
                            <button
                              className="mc-key-del"
                              {...tipProps('删除该键')}
                              onClick={(event) => {
                                event.stopPropagation()
                                void removeKey(item.key)
                              }}
                            >
                              {/* 与键栏、值区同一个删除图标（×），三处语义一致 */}
                              <DialogIcon name="cancel" size={11} />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mc-empty">
                        {keyFilter ? '没有匹配的键' : '没有取到键。可能实例为空，或服务端禁用了 cachedump。'}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="mc-empty">点击「读取键列表」开始浏览</p>
                )}
              </section>

              {selected ? (
                <section className="mc-pane-card">
                  <header className="mc-pane-head">
                    <h4 className="mc-pane-title">值内容</h4>
                    <span className="mc-pane-count mono">
                      {formatBytes(selected.bytes)} · flags {selected.flags}
                    </span>
                    <span className="spacer" />
                    <button className="mc-run" onClick={() => setSelected(null)}>
                      关闭
                    </button>
                  </header>
                  <pre className="mc-value mono">{selected.data || '(空值)'}</pre>
                </section>
              ) : null}
            </div>
          ) : null}

          {tab === 'settings' ? (
            <div className="ov-tab-pane">
              <section className="mc-pane-card">
                <header className="mc-pane-head">
                  <h4 className="mc-pane-title">运行参数</h4>
                  <span className="mc-pane-count mono">{Object.keys(overview?.settings ?? {}).length} 项</span>
                  <span className="spacer" />
                  <button className="mc-run danger" onClick={() => void flushAll()}>
                    <DialogIcon name="trash" size={12} className="ti" />
                    清空全部数据
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
                    该实例没有返回 settings（部分托管服务会禁用该命令），因此无法展示运行参数。
                  </p>
                )}
              </section>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

/** 运行时长：86400 这类秒数对人类不直观，转成「1 天 2 小时」 */
function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 60) return `${Math.floor(seconds)} 秒`
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  return `${minutes} 分`
}

/** 过期时间：显示剩余时长，比绝对时间戳更直观 */
function formatExpiry(expiresAt: number): string {
  const remain = expiresAt - Math.floor(Date.now() / 1000)
  if (remain <= 0) return '已过期'
  if (remain < 60) return `${remain} 秒后`
  if (remain < 3600) return `${Math.floor(remain / 60)} 分后`
  if (remain < 86400) return `${Math.floor(remain / 3600)} 时后`
  return `${Math.floor(remain / 86400)} 天后`
}

export default MemcachedOverview

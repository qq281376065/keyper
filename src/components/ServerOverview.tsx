import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import { DialogIcon, type DialogIconName } from '@/components/DialogIcon'
import { MemoryCard } from '@/components/MemoryCard'
import { PubsubCard } from '@/components/PubsubCard'
import { SlowlogCard } from '@/components/SlowlogCard'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
import type { MsgKey } from '@shared/i18n'
import { useSessionStore } from '@/hooks/useSessionStore'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import type { VersionInfo } from '@shared/types'

type ServerTab = 'info' | 'slowlog' | 'memory' | 'pubsub'

/*
 * 三张概览卡片固定在页签之外，卡片之下是四个不可关闭的面板页签。
 *
 * 刻意不用卸载式切换而是常驻（display 切换）：
 * - SlowlogCard 靠注册回调联动统一刷新，卸载会让回调失效；
 * - PubsubCard 的订阅挂在组件生命周期上，切页签就断订阅属于误伤；
 * - MemoryCard 的分析结果不自动重算，切走再切回应保留上次的结论。
 */
/*
 * 页签图标：只承担「这是哪一类」的快速识别。
 * 颜色随页签文字（currentColor），激活时由 .ov-tab.active 一并加深，不单独配色。
 *   info 信息卡 / clock 耗时（慢查询）/ memory 内存条 / activity 信号波（订阅）
 */
const TABS: Array<{ key: ServerTab; label: MsgKey; icon: DialogIconName }> = [
  { key: 'info', label: 'serverOverview.redisInfoTab', icon: 'info' },
  { key: 'slowlog', label: 'common.slowQueryLog', icon: 'clock' },
  { key: 'memory', label: 'common.keyMemoryAnalysis', icon: 'memory' },
  { key: 'pubsub', label: 'common.pubSubSubscriptions', icon: 'activity' },
]

/**
 * 字段名中文化。
 * INFO 的键名是下划线英文，直接列出来对不熟悉 Redis 的人不友好；
 * 只翻译高频字段，未收录的原样展示 —— 强行翻译生僻项反而容易译错。
 */
const FIELD_LABELS: Record<string, MsgKey> = {
  redis_version: 'memcachedOverview.version',
  redis_git_sha1: 'serverOverview.gitSha1',
  redis_git_dirty: 'serverOverview.gitChanges',
  redis_build_id: 'serverOverview.buildId',
  redis_mode: 'serverOverview.runMode',
  os: 'serverOverview.operatingSystem',
  arch_bits: 'serverOverview.architectureBits',
  process_id: 'serverOverview.processId',
  run_id: 'serverOverview.runId',
  tcp_port: 'serverOverview.listeningPort',
  uptime_in_days: 'serverOverview.uptime',
  config_file: 'serverOverview.configFile',
  executable: 'serverOverview.executable',
  connected_clients: 'serverOverview.connectedClients',
  cluster_connections: 'serverOverview.clusterConnections',
  maxclients: 'serverOverview.maxClients',
  blocked_clients: 'serverOverview.blockedClients',
  used_memory_human: 'serverOverview.usedMemory',
  used_memory_peak_human: 'serverOverview.peakMemory',
  used_memory_lua_human: 'serverOverview.luaUsage',
  maxmemory_human: 'serverOverview.maxMemory',
  maxmemory_policy: 'serverOverview.evictionPolicy',
  mem_fragmentation_ratio: 'serverOverview.memoryFragmentationRatio',
  mem_allocator: 'serverOverview.memoryAllocator',
  total_connections_received: 'serverOverview.totalConnections',
  total_commands_processed: 'serverOverview.totalCommands',
  instantaneous_ops_per_sec: 'serverOverview.operationsPerSecond',
  keyspace_hits: 'serverOverview.hitCount',
  keyspace_misses: 'serverOverview.misses',
  expired_keys: 'serverOverview.expiredKeys',
  evicted_keys: 'serverOverview.evictedKeys',
  role: 'serverOverview.role',
  connected_slaves: 'serverOverview.replicas',
  repl_backlog_active: 'serverOverview.replBacklogEnabled',
  cluster_enabled: 'serverOverview.clusterMode',
}

/** 段落名中文化 */
const SECTION_LABELS: Record<string, MsgKey> = {
  Server: 'serverOverview.server',
  Clients: 'serverOverview.client',
  Memory: 'common.memory',
  Persistence: 'serverOverview.persistence',
  Stats: 'memcachedOverview.stats',
  Replication: 'common.copy',
  CPU: 'serverOverview.cpu',
  Cluster: 'serverOverview.cluster',
  Keyspace: 'serverOverview.keyspace',
}

/** 部署模式的中文说明：INFO 返回的是英文标识，直接展示不利于快速识别 */
const MODE_LABEL: Record<string, MsgKey> = {
  standalone: 'serverOverview.standalone',
  cluster: 'serverOverview.cluster',
  sentinel: 'serverOverview.sentinel',
}

interface OverviewRow {
  label: string
  value: string
  mono?: boolean
  tone?: 'ok' | 'warn' | 'idle'
}

interface OverviewCard {
  key: string
  title: string
  icon: 'server' | 'memory' | 'activity'
  rows: OverviewRow[]
}

/**
 * 命中率着色：低于 90% 通常意味着缓存策略需要调整。
 * 95% 以上算健康，90–95% 中性，90% 以下警示。
 */
function hitRateTone(rate: number): 'ok' | 'warn' | 'idle' {
  if (!Number.isFinite(rate)) return 'idle'
  if (rate >= 95) return 'ok'
  if (rate >= 90) return 'idle'
  return 'warn'
}

/**
 * 连接成功后的服务端概览。
 *
 * 只在「已连接但尚未选中任何键」时出现，作用是让用户一眼确认
 * 连到了哪台实例、负载如何 —— 而不是面对一块空白。
 */
export function ServerOverview() {
  const { t } = useI18n()

  /** 已收录的字段 / 段落走字典；INFO 里新出现的字段没有译文，原样展示 */
  const labelOf = (map: Record<string, MsgKey>, raw: string | undefined): string => {
    const key = raw ? map[raw] : undefined
    return key ? t(key) : (raw ?? '-')
  }
  const { state, activeConnection, loadServerInfo } = useRedis()
  useObservable(useSessionStore())

  const info = state.serverInfo
  const activeId = state.activeId
  const connected = activeConnection?.status === 'connected'

  /* ---------------------------------------------------------------- 详情 */

  /**
   * 详情数据按需加载，而不是随连接一起取。
   * 原因：INFO 全量输出在字段多的实例上有几十 KB（大 keyspace、多副本时更大），
   * 而大多数时间用户只是看概览。放进主连接流程会拖慢"连上就能用"的体感。
   */
  const [detail, setDetail] = useState<VersionInfo | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  async function loadDetail(): Promise<void> {
    if (!activeId) return
    setDetailLoading(true)
    setDetailError(null)
    try {
      const res = await api.redis.versionInfo(activeId)
      if (!res.ok) throw new Error(res.error)
      setDetail(res.data)
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : t('serverOverview.failedLoadDetails'))
    } finally {
      setDetailLoading(false)
    }
  }

  /*
   * 连接变化就重新拉取，避免显示上一个实例的字段 ——
   * 这类信息（run_id / config_file）与实例强绑定，串了会误导排查。
   *
   * ⚠️ 判定维度必须是 [activeId, connected] 两个，不能只看 activeId：
   * 启动时恢复上次的 activeId（只选中、未连接），值区随之渲染，
   * 若立即拉详情必然得到"连接不存在或已断开"。之后用户点连接成功，
   * activeId 不变、effect 不触发，错误就一直挂在页面上。
   */
  useEffect(() => {
    setDetail(null)
    setDetailError(null)
    if (activeId && connected) void loadDetail()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, connected])

  /* ---------------------------------------------------------------- 统一刷新 */

  const [refreshing, setRefreshing] = useState(false)
  /** 慢日志卡片自带数据管理，这里只拿它的 refresh 参与统一刷新 */
  const slowlogRefresh = useRef<(() => Promise<void>) | null>(null)

  /**
   * 刷新整个概览页。
   *
   * 页面上的数据块：概览卡片（INFO 摘要）与页签内的三个数据面板。
   * 统一从这一个入口刷新 —— 任何一块单独刷都会造成页面内数字时间点不一致。
   * 未激活页签里的面板同样要刷：面板常驻（display 切换）保证了它们的刷新入口始终有效。
   */
  async function refreshAll(): Promise<void> {
    if (refreshing) return
    setRefreshing(true)
    try {
      await Promise.all([loadServerInfo(), loadDetail(), slowlogRefresh.current?.() ?? null])
    } finally {
      setRefreshing(false)
    }
  }

  /* ---------------------------------------------------------------- 页签 */

  const [activeTab, setActiveTab] = useState<ServerTab>('info')
  const rootRef = useRef<HTMLDivElement | null>(null)

  function switchTab(key: ServerTab): void {
    setActiveTab(key)
    /*
     * 各面板内容高度差异极大（详情数百行、内存分析未运行时近乎空白），
     * 切换后保留旧滚动位置很容易落在空白区，统一回到顶部。
     */
    rootRef.current?.scrollTo({ top: 0 })
  }

  /** 段落折叠状态：默认全部展开，段落多时可单独收起 */
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())

  function toggleSection(section: string): void {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }

  /* ---------------------------------------------------------------- 概览卡片 */

  /** 卡片数据：集中定义便于统一渲染，避免模板里三段重复结构 */
  const cards: OverviewCard[] = info
    ? [
        {
          key: 'server',
          title: t('serverOverview.server'),
          icon: 'server',
          /* 版本与模式是这个实例"是什么"的身份信息，放在第一张卡片 */
          rows: [
            { label: t('serverOverview.redisVersion'), value: info.version || '-', mono: true },
            { label: t('serverOverview.runMode'), value: labelOf(MODE_LABEL, info.mode), mono: true },
            { label: t('serverOverview.processId'), value: info.processId ? String(info.processId) : '-', mono: true },
          ],
        },
        {
          key: 'memory',
          title: t('common.memory'),
          icon: 'memory',
          rows: [
            { label: t('serverOverview.usedMemory'), value: info.usedMemoryHuman || '-', mono: true },
            { label: t('serverOverview.luaUsage'), value: info.usedMemoryLua || '-', mono: true },
            { label: t('serverOverview.operationsPerSecond'), value: info.opsPerSec != null ? String(info.opsPerSec) : '-', mono: true },
          ],
        },
        {
          key: 'status',
          title: t('common.status'),
          icon: 'activity',
          rows: [
            { label: t('serverOverview.clientConnections'), value: String(info.connectedClients ?? '-'), mono: true },
            { label: t('serverOverview.totalKeys'), value: String(info.totalKeys ?? '-'), mono: true },
            /* 命中率带单位并着色 */
            { label: t('serverOverview.hitRate'), value: `${info.hitRate}%`, mono: true, tone: hitRateTone(info.hitRate) },
          ],
        },
      ]
    : []

  /**
   * 连接标识：让用户确认"这组指标属于哪台实例"。
   * 走 SSH 时额外标出跳板机 —— 同样的 Redis 地址可能经不同跳板机访问。
   */
  const endpoint = activeConnection ? `${activeConnection.host}:${activeConnection.port}` : ''
  /*
   * SSH 标注对两种引擎都成立：同样的实例地址可能经不同跳板机访问，
   * 连不通时这里就是区分「直连」与「隧道」的第一线索。
   */
  const sshLabel =
    activeConnection?.sshEnabled
      ? activeConnection.sshHost
        ? `SSH · ${activeConnection.sshHost}`
        : 'SSH'
      : null

  return (
    <div ref={rootRef} className="overview s-server-overview">
      <header className="ov-head">
        <div className="ov-ident">
          <span className="ov-name">{activeConnection?.name ?? t('memcachedOverview.currentInstance')}</span>
          <span className="ov-endpoint mono">{endpoint}</span>
          {sshLabel ? <span className="ov-ssh">{sshLabel}</span> : null}
        </div>
        <button
          className="ov-refresh"
          disabled={refreshing}
          {...tipProps(t('serverOverview.refreshEverythingPage'))}
          onClick={() => void refreshAll()}
        >
          <DialogIcon name="refresh" size={13} className={`ti${refreshing ? ' spin' : ''}`} />
          {refreshing ? t('memcachedOverview.refreshing') : t('common.refresh')}
        </button>
      </header>

      {info ? (
        <div className="ov-cards">
          {cards.map((card) => (
            <section key={card.key} className="ov-card">
              <h3 className="ov-card-title">
                <DialogIcon name={card.icon} size={12} className="ov-card-icon" />
                <span>{card.title}</span>
              </h3>
              <dl className="ov-rows">
                {card.rows.map((row) => (
                  <div key={row.label} className="ov-row">
                    <dt>{row.label}</dt>
                    <dd className={`${row.mono ? 'mono' : ''} ${row.tone ?? ''}`.trim()}>{row.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      ) : (
        <div className="ov-loading">
          <span className="ov-badge">Keyper</span>
          <p>{t('serverOverview.readingServerMetrics')}</p>
          <p className="ov-hint">{t('serverOverview.ifThereNoResponseFor')}</p>
        </div>
      )}

      {/*
        ================= 面板页签 =================
        与顶部一级连接页签（TabBar）刻意区分：那里是带边框、可关闭的卡片式标签；
        这里是嵌入式二级页签 —— 固定四项、只切换、不关闭，也不做溢出处理。
      */}
      <nav className="ov-tabs">
        {TABS.map((item) => (
          <button
            key={item.key}
            className={`ov-tab${activeTab === item.key ? ' active' : ''}`}
            onClick={() => switchTab(item.key)}
          >
            <DialogIcon name={item.icon} size={13} className="ov-tab-ico" />
            {t(item.label)}
          </button>
        ))}
      </nav>

      {/* ================= 页签：Redis 信息详情 ================= */}
      <div className="ov-tab-pane" style={activeTab === 'info' ? undefined : { display: 'none' }}>
        <section className="ov-detail-card">
          <header className="ov-detail-head">
            <h3 className="ov-detail-title">
              <DialogIcon name="document" size={14} className="ov-card-icon" />
              <span>{t('serverOverview.redisInfoDetails')}</span>
            </h3>
            {detailLoading ? (
              <span className="ov-detail-state">{t('common.loading')}</span>
            ) : detail ? (
              <span className="ov-detail-state mono">{t('serverOverview.countParagraphs', { count: detail.groups.length })}</span>
            ) : null}
          </header>

          {detailError ? <p className="ov-detail-error">{detailError}</p> : null}

          {/*
            段落分栏：每段是一组键值对，用 column 多栏排布 ——
            字段长短不一，多栏比网格更能利用横向空间，窄窗口下会自动减少栏数。
          */}
          {detail ? (
            <div className="ov-sections">
              {detail.groups.map((group) => (
                <section key={group.section} className="ov-section">
                  <button className="ov-section-head" onClick={() => toggleSection(group.section)}>
                    <span className="ov-caret">{collapsedSections.has(group.section) ? '▸' : '▾'}</span>
                    <span>{labelOf(SECTION_LABELS, group.section)}</span>
                    <span className="ov-section-count mono">{group.entries.length}</span>
                  </button>
                  <dl
                    className="ov-fields"
                    style={collapsedSections.has(group.section) ? { display: 'none' } : undefined}
                  >
                    {group.entries.map((entry) => (
                      <div key={entry.key} className="ov-field">
                        <dt {...tipProps(entry.key)}>{labelOf(FIELD_LABELS, entry.key)}</dt>
                        <dd className="mono" {...tipProps(entry.value)}>
                          {entry.value || '-'}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
            </div>
          ) : !detailError ? (
            <div className="ov-detail-empty">{t('serverOverview.noDetailData')}</div>
          ) : null}
        </section>
      </div>

      {/* ================= 页签：慢查询日志 ================= */}
      <div className="ov-tab-pane" style={activeTab === 'slowlog' ? undefined : { display: 'none' }}>
        <SlowlogCard
          registerRefresh={(fn) => {
            slowlogRefresh.current = fn
          }}
        />
      </div>

      {/* ================= 页签：键内存分析 ================= */}
      <div className="ov-tab-pane" style={activeTab === 'memory' ? undefined : { display: 'none' }}>
        <MemoryCard />
      </div>

      {/* ================= 页签：Pub/Sub 订阅 ================= */}
      <div className="ov-tab-pane" style={activeTab === 'pubsub' ? undefined : { display: 'none' }}>
        <PubsubCard />
      </div>
    </div>
  )
}

export default ServerOverview

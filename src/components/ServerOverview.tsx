import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { MemoryCard } from '@/components/MemoryCard'
import { PubsubCard } from '@/components/PubsubCard'
import { SlowlogCard } from '@/components/SlowlogCard'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
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
const TABS: { key: ServerTab; label: string }[] = [
  { key: 'info', label: 'Redis 信息详情' },
  { key: 'slowlog', label: '慢查询日志' },
  { key: 'memory', label: '键内存分析' },
  { key: 'pubsub', label: 'Pub/Sub 订阅' },
]

/**
 * 字段名中文化。
 * INFO 的键名是下划线英文，直接列出来对不熟悉 Redis 的人不友好；
 * 只翻译高频字段，未收录的原样展示 —— 强行翻译生僻项反而容易译错。
 */
const FIELD_LABELS: Record<string, string> = {
  redis_version: '版本',
  redis_git_sha1: 'Git SHA1',
  redis_git_dirty: 'Git 有改动',
  redis_build_id: '构建 ID',
  redis_mode: '运行模式',
  os: '操作系统',
  arch_bits: '架构位数',
  process_id: '进程 ID',
  run_id: '运行 ID',
  tcp_port: '监听端口',
  uptime_in_days: '运行天数',
  config_file: '配置文件',
  executable: '可执行文件',
  connected_clients: '已连接客户端',
  cluster_connections: '集群连接数',
  maxclients: '最大客户端数',
  blocked_clients: '阻塞客户端数',
  used_memory_human: '已用内存',
  used_memory_peak_human: '内存峰值',
  used_memory_lua_human: 'Lua 占用',
  maxmemory_human: '最大内存',
  maxmemory_policy: '淘汰策略',
  mem_fragmentation_ratio: '内存碎片率',
  mem_allocator: '内存分配器',
  total_connections_received: '累计连接数',
  total_commands_processed: '累计命令数',
  instantaneous_ops_per_sec: '每秒操作数',
  keyspace_hits: '命中次数',
  keyspace_misses: '未命中次数',
  expired_keys: '过期键数',
  evicted_keys: '淘汰键数',
  role: '角色',
  connected_slaves: '从节点数',
  repl_backlog_active: '复制积压启用',
  cluster_enabled: '集群模式',
}

/** 段落名中文化 */
const SECTION_LABELS: Record<string, string> = {
  Server: '服务器',
  Clients: '客户端',
  Memory: '内存',
  Persistence: '持久化',
  Stats: '统计',
  Replication: '复制',
  CPU: 'CPU',
  Cluster: '集群',
  Keyspace: '键空间',
}

/** 部署模式的中文说明：INFO 返回的是英文标识，直接展示不利于快速识别 */
const MODE_LABEL: Record<string, string> = {
  standalone: '单机',
  cluster: '集群',
  sentinel: '哨兵',
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
      setDetailError(error instanceof Error ? error.message : t('读取详情失败'))
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
          title: t('服务器'),
          icon: 'server',
          /* 版本与模式是这个实例"是什么"的身份信息，放在第一张卡片 */
          rows: [
            { label: t('Redis 版本'), value: info.version || '-', mono: true },
            { label: t('运行模式'), value: t(MODE_LABEL[info.mode] ?? info.mode ?? '-'), mono: true },
            { label: t('进程 ID'), value: info.processId ? String(info.processId) : '-', mono: true },
          ],
        },
        {
          key: 'memory',
          title: t('内存'),
          icon: 'memory',
          rows: [
            { label: t('已用内存'), value: info.usedMemoryHuman || '-', mono: true },
            { label: t('Lua 占用'), value: info.usedMemoryLua || '-', mono: true },
            { label: t('每秒操作数'), value: info.opsPerSec != null ? String(info.opsPerSec) : '-', mono: true },
          ],
        },
        {
          key: 'status',
          title: t('状态'),
          icon: 'activity',
          rows: [
            { label: t('客户端连接'), value: String(info.connectedClients ?? '-'), mono: true },
            { label: t('键总数'), value: String(info.totalKeys ?? '-'), mono: true },
            /* 命中率带单位并着色 */
            { label: t('命中率'), value: `${info.hitRate}%`, mono: true, tone: hitRateTone(info.hitRate) },
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
          <span className="ov-name">{activeConnection?.name ?? t('当前实例')}</span>
          <span className="ov-endpoint mono">{endpoint}</span>
          {sshLabel ? <span className="ov-ssh">{sshLabel}</span> : null}
        </div>
        <button
          className="ov-refresh"
          disabled={refreshing}
          {...tipProps(t('刷新当前页面的全部信息（概览 + 详情）'))}
          onClick={() => void refreshAll()}
        >
          <DialogIcon name="refresh" size={13} className={`ti${refreshing ? ' spin' : ''}`} />
          {refreshing ? t('刷新中…') : t('刷新')}
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
          <p>{t('正在读取服务端指标…')}</p>
          <p className="ov-hint">{t('若长时间无响应，请检查连接是否仍然可用')}</p>
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
              <span>{t('Redis信息详情')}</span>
            </h3>
            {detailLoading ? (
              <span className="ov-detail-state">{t('读取中…')}</span>
            ) : detail ? (
              <span className="ov-detail-state mono">{t('{count} 个段落', { count: detail.groups.length })}</span>
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
                    <span>{t(SECTION_LABELS[group.section] ?? group.section)}</span>
                    <span className="ov-section-count mono">{group.entries.length}</span>
                  </button>
                  <dl
                    className="ov-fields"
                    style={collapsedSections.has(group.section) ? { display: 'none' } : undefined}
                  >
                    {group.entries.map((entry) => (
                      <div key={entry.key} className="ov-field">
                        <dt {...tipProps(entry.key)}>{t(FIELD_LABELS[entry.key] ?? entry.key)}</dt>
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
            <div className="ov-detail-empty">{t('暂无详情数据')}</div>
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

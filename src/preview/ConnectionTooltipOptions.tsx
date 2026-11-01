import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { DialogIcon } from '@/components/DialogIcon'
import { EngineGlyph } from '@/components/EngineGlyph'
import { engineMeta } from '@/utils/engine'
import '@/preview/connection-tooltip.css'

type Engine = 'redis' | 'memcached'
type Status = 'connected' | 'connecting' | 'error' | 'disconnected'
type Scheme = 'A' | 'B' | 'C' | 'D'
type Tone = 'ok' | 'warn' | 'err' | 'muted'

interface DemoHop {
  host: string
  port: number
  username: string
}

interface DemoSsh {
  host: string
  port: number
  username: string
  authMethod: 'password' | 'key'
  hops?: DemoHop[]
}

interface DemoConn {
  id: string
  name: string
  engine: Engine
  host: string
  port: number
  db?: number
  tls?: boolean
  sshEnabled?: boolean
  ssh?: DemoSsh
  poolSize?: number
  status: Status
  latency?: number
  version?: string
  mode?: string
  message?: string
  credentialError?: string
  pinned?: boolean
  username?: string
  hasPassword?: boolean
}

const ACTIVE_ID = 'prod'

const CONNECTIONS: DemoConn[] = [
  {
    id: 'prod',
    name: '生产 · 订单缓存（只读）',
    engine: 'redis',
    host: 'redis-prod.internal',
    port: 6380,
    db: 0,
    tls: true,
    sshEnabled: true,
    ssh: {
      host: 'jump.example.com',
      port: 22,
      username: 'ops',
      authMethod: 'key',
      hops: [{ host: 'edge.example.net', port: 22, username: 'ops' }],
    },
    status: 'connected',
    latency: 12,
    version: '7.4.4',
    mode: '主从',
    pinned: true,
    username: 'app_ro',
    hasPassword: true,
  },
  {
    id: 'staging',
    name: '预发 · 商品目录',
    engine: 'redis',
    host: '10.32.8.41',
    port: 6379,
    db: 3,
    status: 'connected',
    latency: 31,
    version: '7.2.5',
    mode: '集群',
    username: 'app',
    hasPassword: true,
  },
  {
    id: 'broken',
    name: '测试 · 用户会话',
    engine: 'redis',
    host: '192.168.1.45',
    port: 6379,
    db: 2,
    status: 'error',
    message: 'connect ECONNREFUSED 192.168.1.45:6379',
    hasPassword: true,
  },
  {
    id: 'local',
    name: '本地开发',
    engine: 'redis',
    host: '127.0.0.1',
    port: 6379,
    db: 0,
    status: 'disconnected',
  },
  {
    id: 'mc',
    name: '会话缓存 · 生产',
    engine: 'memcached',
    host: 'mc-session.internal',
    port: 11211,
    poolSize: 8,
    status: 'connected',
    latency: 4,
    version: '1.6.21',
  },
]

const STATUS: Record<Status, { label: string; tone: Tone }> = {
  connected: { label: '已连接', tone: 'ok' },
  connecting: { label: '连接中', tone: 'warn' },
  error: { label: '连接失败', tone: 'err' },
  disconnected: { label: '未连接', tone: 'muted' },
}

const SCHEMES: Array<{
  key: Scheme
  short: string
  title: string
  tagline: string
  width: string
  bullets: string[]
  fit: string
}> = [
  {
    key: 'A',
    short: '摘要',
    title: '状态摘要',
    tagline: '身份、端点与四项关键指标一屏读完，错误与凭据问题在底部就近提示。',
    width: '304 px',
    bullets: [
      '四列指标：延迟 / 服务端 / 模式 / 认证',
      '完整端点独立成行，长地址换行不截断',
      'SSH 跳板单独一行，失败原因就近展示',
    ],
    fit: '默认方案，日常切换连接',
  },
  {
    key: 'B',
    short: '清单',
    title: '规格清单',
    tagline: '按「连接 / 服务端 / 隧道」分组列出全部字段，信息密度最高，适合排障。',
    width: '318 px',
    bullets: [
      '分组清单，标签列严格对齐，扫读成本低',
      '配置项始终可见，运行态缺失显示 —',
      '弱化装饰，用纯数据表达，不重复磁贴语言',
    ],
    fit: '习惯看参数的高级用户',
  },
  {
    key: 'C',
    short: '链路',
    title: '身份链路',
    tagline: '强调「这是哪套环境、走哪条网络路径」，SSH 跳板以竖向链路呈现。',
    width: '332 px',
    bullets: [
      '引擎色头带 + 大图标，身份最先被识别',
      '端点独立成块，db / TLS / SSH 紧随其后',
      '本机 → 前置跳板 → 跳板机 → 目标，多级隧道一眼看清',
    ],
    fit: '多环境、堡垒机场景',
  },
  {
    key: 'D',
    short: '速览',
    title: '双栏速览',
    tagline: '左侧身份栏放引擎、状态与延迟，右侧地址与关键事实，面板高度最低。',
    width: '376 px',
    bullets: [
      '横向构图，高度最矮，适合长列表快速扫读',
      '状态与延迟在左栏用大字号呈现',
      '错误态左栏转危险色，右侧就近显示原因',
    ],
    fit: '连接很多、频繁扫列表',
  },
]

const THEMES: Array<{ value: string; label: string }> = [
  { value: 'dark', label: '暗色' },
  { value: 'light', label: '亮色' },
  { value: 'ocean', label: '深海' },
  { value: 'solarized', label: '暖纸' },
  { value: 'forest', label: '墨林' },
  { value: 'sakura', label: '樱花' },
  { value: 'mint', label: '薄荷' },
  { value: 'mist', label: '雾蓝' },
  { value: 'aurora', label: '极光' },
]

const LIGHT_THEMES = new Set(['light', 'solarized', 'sakura', 'mint', 'mist', 'aurora'])

const STATES: Array<{ key: string; label: string }> = [
  { key: 'prod', label: '已连接' },
  { key: 'broken', label: '连接失败' },
  { key: 'local', label: '未连接' },
  { key: 'mc', label: 'Memcached' },
]

function isConnected(conn: DemoConn): boolean {
  return conn.status === 'connected'
}

function authShort(conn: DemoConn): string {
  if (conn.engine === 'memcached') return '无认证'
  if (conn.credentialError) return '待修复'
  if (conn.username && conn.hasPassword) return '账号密码'
  if (conn.hasPassword) return '密码'
  return '未配置'
}

function authLong(conn: DemoConn): string {
  if (conn.engine === 'memcached') return '无认证（标准协议）'
  if (conn.credentialError) return '凭据待修复'
  if (conn.username && conn.hasPassword) return `${conn.username} · 密码`
  if (conn.hasPassword) return '密码'
  return '未配置'
}

function transportLong(conn: DemoConn): string {
  if (conn.engine === 'memcached') return 'TCP（明文）'
  return conn.tls ? 'TLS 加密' : 'TCP（明文）'
}

function transportShort(conn: DemoConn): string {
  return [conn.tls ? 'TLS' : 'TCP', conn.sshEnabled ? 'SSH' : null].filter(Boolean).join(' · ')
}

function actionHint(conn: DemoConn, active: boolean): string {
  if (conn.status === 'connected') return active ? '当前连接' : '点击切换到此连接'
  if (conn.status === 'error') return '点击重新连接'
  if (conn.status === 'connecting') return '正在建立连接…'
  return '点击连接'
}

function latencyText(conn: DemoConn): string {
  return isConnected(conn) && conn.latency != null ? `${conn.latency} ms` : '—'
}

function versionText(conn: DemoConn): string {
  return isConnected(conn) && conn.version ? conn.version : '—'
}

function poolText(conn: DemoConn): string {
  return `${conn.poolSize ?? 4} 连接`
}

function sshTarget(ssh: DemoSsh): string {
  return `${ssh.username}@${ssh.host}:${ssh.port}`
}

function railTone(conn: DemoConn): 'normal' | 'danger' | 'muted' {
  if (conn.status === 'error') return 'danger'
  if (conn.status === 'disconnected' || conn.status === 'connecting') return 'muted'
  return 'normal'
}

function StatusPill({ status }: { status: Status }) {
  const meta = STATUS[status]
  return (
    <span className={`tt-status ${meta.tone}`}>
      <span className="tt-dot" />
      {meta.label}
    </span>
  )
}

function NameLine({ conn }: { conn: DemoConn }) {
  return (
    <div className="tt-name-line">
      <span className="tt-name">{conn.name}</span>
      {conn.pinned ? <DialogIcon name="pin" size={11} className="tt-pin" /> : null}
    </div>
  )
}

function GlyphBadge({ conn, size }: { conn: DemoConn; size: number }) {
  return (
    <span className="tt-glyph" style={{ width: size, height: size }}>
      <EngineGlyph engine={conn.engine} size={Math.round(size * 0.55)} />
    </span>
  )
}

function Chips({ conn }: { conn: DemoConn }) {
  return (
    <span className="tt-chips">
      {conn.engine === 'redis' ? <span className="tt-chip mono">db{conn.db}</span> : null}
      {conn.tls ? <span className="tt-chip">TLS</span> : null}
      {conn.sshEnabled ? <span className="tt-chip accent">SSH</span> : null}
    </span>
  )
}

function Metric({
  k,
  v,
  mono,
  tone,
}: {
  k: string
  v: string
  mono?: boolean
  tone?: 'ok' | 'dim'
}) {
  return (
    <div className="tt-metric">
      <div className="k">{k}</div>
      <div className={`v${mono ? ' mono' : ''}${tone ? ` ${tone}` : ''}`}>{v}</div>
    </div>
  )
}

function Notice({
  tone,
  label,
  text,
  mono,
}: {
  tone: 'danger' | 'warn'
  label?: string
  text: string
  mono?: boolean
}) {
  return (
    <div className={`tt-notice ${tone}`}>
      <DialogIcon name={tone === 'danger' ? 'warning' : 'info'} size={12} />
      <div className="body">
        {label ? <div className="label">{label}</div> : null}
        <div className={`text${mono ? ' mono' : ''}`}>{text}</div>
      </div>
    </div>
  )
}

function Notices({ conn }: { conn: DemoConn }) {
  return (
    <>
      {conn.status === 'error' && conn.message ? (
        <Notice tone="danger" label="失败原因" text={conn.message} mono />
      ) : null}
      {conn.credentialError ? (
        <Notice tone="warn" text="凭据无法解密，请重新输入密码" />
      ) : null}
    </>
  )
}

interface PanelProps {
  conn: DemoConn
  active: boolean
}

function PanelA({ conn, active }: PanelProps) {
  const mc = conn.engine === 'memcached'
  const ssh = conn.sshEnabled && conn.ssh ? conn.ssh : null
  return (
    <div className={`tt-panel tt-panel-a engine-${conn.engine}`} role="tooltip">
      <header className="tt-a-head">
        <GlyphBadge conn={conn} size={28} />
        <div className="tt-a-id">
          <NameLine conn={conn} />
          <div className="tt-a-engine">{engineMeta(conn.engine).label}</div>
        </div>
        <StatusPill status={conn.status} />
      </header>

      <div className="tt-a-endpoint">
        <span className="addr">
          {conn.host}:{conn.port}
        </span>
        <Chips conn={conn} />
      </div>

      <div className="tt-a-metrics">
        <Metric
          k="延迟"
          v={latencyText(conn)}
          mono
          tone={isConnected(conn) ? 'ok' : 'dim'}
        />
        <Metric k="服务端" v={versionText(conn)} mono tone={isConnected(conn) ? undefined : 'dim'} />
        <Metric
          k={mc ? '连接池' : '模式'}
          v={mc ? poolText(conn) : isConnected(conn) ? (conn.mode ?? '—') : '—'}
          tone={mc || isConnected(conn) ? undefined : 'dim'}
        />
        <Metric k="认证" v={authShort(conn)} tone={conn.credentialError ? 'dim' : undefined} />
      </div>

      {ssh ? (
        <div className="tt-a-ssh">
          <span className="tt-chip accent">SSH</span>
          <span className="addr">{sshTarget(ssh)}</span>
          {ssh.hops?.length ? <span className="tt-chip">+{ssh.hops.length} 跳</span> : null}
          <span className="r">{ssh.authMethod === 'key' ? '私钥' : '密码'}</span>
        </div>
      ) : null}

      <Notices conn={conn} />

      <div className="tt-foot">
        {actionHint(conn, active)}
        <span className="r">{transportShort(conn)}</span>
      </div>
    </div>
  )
}

function PanelB({ conn, active }: PanelProps) {
  const mc = conn.engine === 'memcached'
  const ssh = conn.sshEnabled && conn.ssh ? conn.ssh : null
  const connected = isConnected(conn)
  return (
    <div className={`tt-panel tt-panel-b engine-${conn.engine}`} role="tooltip">
      <header className="tt-b-head">
        <span className="tt-b-glyph">
          <EngineGlyph engine={conn.engine} size={16} />
        </span>
        <div className="tt-b-id">
          <NameLine conn={conn} />
          <div className="tt-b-sub">{engineMeta(conn.engine).label}</div>
        </div>
        <StatusPill status={conn.status} />
      </header>

      <section className="tt-b-sec">
        <div className="tt-b-sec-head">连接</div>
        <div className="tt-b-rows">
          <div className="tt-b-row">
            <span className="k">地址</span>
            <span className="v mono">
              {conn.host}:{conn.port}
            </span>
          </div>
          {mc ? (
            <div className="tt-b-row">
              <span className="k">连接池</span>
              <span className="v mono">{poolText(conn)}</span>
            </div>
          ) : (
            <div className="tt-b-row">
              <span className="k">数据库</span>
              <span className="v mono">db{conn.db}</span>
            </div>
          )}
          <div className="tt-b-row">
            <span className="k">传输</span>
            <span className="v">{transportLong(conn)}</span>
          </div>
          <div className="tt-b-row">
            <span className="k">认证</span>
            <span className="v">{authLong(conn)}</span>
          </div>
        </div>
      </section>

      <section className="tt-b-sec">
        <div className="tt-b-sec-head">服务端</div>
        <div className="tt-b-rows">
          <div className="tt-b-row">
            <span className="k">版本</span>
            <span className={`v mono${connected ? '' : ' dim'}`}>{versionText(conn)}</span>
          </div>
          <div className="tt-b-row">
            <span className="k">延迟</span>
            <span className={`v mono${connected ? ' ok' : ' dim'}`}>{latencyText(conn)}</span>
          </div>
          {mc ? (
            <div className="tt-b-row">
              <span className="k">状态</span>
              <span className={`v${connected ? '' : ' dim'}`}>{STATUS[conn.status].label}</span>
            </div>
          ) : (
            <div className="tt-b-row">
              <span className="k">模式</span>
              <span className={`v${connected ? '' : ' dim'}`}>
                {connected ? (conn.mode ?? '—') : '—'}
              </span>
            </div>
          )}
        </div>
      </section>

      {ssh ? (
        <section className="tt-b-sec">
          <div className="tt-b-sec-head">SSH 隧道</div>
          <div className="tt-b-rows">
            {ssh.hops?.map((hop, index) => (
              <div className="tt-b-row" key={`${hop.host}-${index}`}>
                <span className="k">前置跳板</span>
                <span className="v mono">
                  {hop.username}@{hop.host}:{hop.port}
                </span>
              </div>
            ))}
            <div className="tt-b-row">
              <span className="k">跳板机</span>
              <span className="v mono">{sshTarget(ssh)}</span>
            </div>
            <div className="tt-b-row">
              <span className="k">认证方式</span>
              <span className="v">{ssh.authMethod === 'key' ? '私钥' : '密码'}</span>
            </div>
          </div>
        </section>
      ) : null}

      <Notices conn={conn} />

      <div className="tt-foot">
        {actionHint(conn, active)}
        <span className="r">{transportShort(conn)}</span>
      </div>
    </div>
  )
}

function PanelC({ conn, active }: PanelProps) {
  const mc = conn.engine === 'memcached'
  const ssh = conn.sshEnabled && conn.ssh ? conn.ssh : null
  const connected = isConnected(conn)
  const sub = [
    engineMeta(conn.engine).label.toUpperCase(),
    !mc && connected && conn.mode ? conn.mode : null,
    connected && conn.version ? `v${conn.version}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const nodes: Array<{ kind: 'local' | 'hop' | 'target'; text: string; chip?: string }> = [
    { kind: 'local', text: '本机' },
    ...(ssh?.hops ?? []).map((hop) => ({
      kind: 'hop' as const,
      text: `${hop.username}@${hop.host}:${hop.port}`,
      chip: '前置跳板',
    })),
    ...(ssh
      ? [{ kind: 'hop' as const, text: sshTarget(ssh), chip: '跳板机' }]
      : []),
    { kind: 'target', text: `${conn.host}:${conn.port}`, chip: '目标' },
  ]

  return (
    <div className={`tt-panel tt-panel-c engine-${conn.engine}`} role="tooltip">
      <header className="tt-c-band">
        <div className="tt-c-top">
          <GlyphBadge conn={conn} size={34} />
          <div className="tt-c-id">
            <NameLine conn={conn} />
            <div className="tt-c-sub">{sub}</div>
          </div>
          <StatusPill status={conn.status} />
        </div>
      </header>

      <div className="tt-c-body">
        <div className="tt-c-endpoint">
          <div className="k">地址</div>
          <div className="v">
            {conn.host}:{conn.port}
          </div>
          <Chips conn={conn} />
        </div>

        <div className="tt-c-metrics">
          <Metric
            k="延迟"
            v={latencyText(conn)}
            mono
            tone={connected ? 'ok' : 'dim'}
          />
          <Metric
            k={mc ? '连接池' : '模式'}
            v={mc ? poolText(conn) : connected ? (conn.mode ?? '—') : '—'}
            tone={mc || connected ? undefined : 'dim'}
          />
          <Metric k="认证" v={authShort(conn)} />
        </div>

        <Notices conn={conn} />

        <div className="tt-c-route">
          <div className="tt-c-route-head">
            <DialogIcon name="link" size={11} />
            {ssh ? 'SSH 隧道' : '网络路径'}
            <span className="r">
              {ssh ? (ssh.authMethod === 'key' ? '私钥认证' : '密码认证') : '直连'}
            </span>
          </div>
          <div className="tt-c-nodes">
            {nodes.map((node, index) => (
              <div
                className={`tt-c-node is-${node.kind}`}
                key={`${node.kind}-${node.text}-${index}`}
              >
                <span className="tt-c-dot" />
                <span className={`txt${node.kind === 'local' ? ' plain' : ''}`}>{node.text}</span>
                {node.chip ? <span className="tt-chip">{node.chip}</span> : null}
              </div>
            ))}
          </div>
        </div>
      </div>

      <footer className="tt-c-foot">
        {actionHint(conn, active)}
        <span className="r">{transportShort(conn)}</span>
      </footer>
    </div>
  )
}

function Fact({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="tt-d-fact">
      <span className="k">{k}</span>
      <span className={`v${mono ? ' mono' : ''}`}>{v}</span>
    </div>
  )
}

function PanelD({ conn, active }: PanelProps) {
  const mc = conn.engine === 'memcached'
  const ssh = conn.sshEnabled && conn.ssh ? conn.ssh : null
  const connected = isConnected(conn)
  const tone = railTone(conn)
  const stateTone = STATUS[conn.status].tone
  return (
    <div className={`tt-panel tt-panel-d engine-${conn.engine}`} role="tooltip">
      <div className="tt-d-main">
        <aside className="tt-d-rail" data-tone={tone}>
          <GlyphBadge conn={conn} size={34} />
          <div className="tt-d-engine">{engineMeta(conn.engine).label.toUpperCase()}</div>
          <div className="tt-d-state">
            <span className={`tt-dot ${stateTone}`} />
            {STATUS[conn.status].label}
          </div>
          <div className={`tt-d-lat${connected ? '' : tone === 'danger' ? ' err' : ' dim'}`}>
            <span className="tt-d-lat-k">延迟</span>
            <span className="tt-d-lat-val">
              <b>{connected && conn.latency != null ? conn.latency : '—'}</b>
              {connected ? <small>ms</small> : null}
            </span>
          </div>
          {conn.pinned ? (
            <span className="tt-d-pin">
              <DialogIcon name="pin" size={10} /> 置顶
            </span>
          ) : null}
        </aside>

        <div className="tt-d-body">
          <NameLine conn={conn} />
          <div className="tt-d-addr">
            {conn.host}:{conn.port}
          </div>
          <Chips conn={conn} />

          {conn.status === 'error' && conn.message ? (
            <Notice tone="danger" label="失败原因" text={conn.message} mono />
          ) : (
            <>
              <div className="tt-d-div" />
              <div className="tt-d-facts">
                <Fact
                  k="服务端"
                  v={
                    connected && conn.version
                      ? `${conn.version}${!mc && conn.mode ? ` · ${conn.mode}` : ''}`
                      : '—'
                  }
                />
                <Fact k={mc ? '连接池' : '认证'} v={mc ? poolText(conn) : authShort(conn)} />
                <Fact
                  k="隧道"
                  v={ssh ? sshTarget(ssh) : '直连'}
                  mono={Boolean(ssh)}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <footer className="tt-d-foot">
        {actionHint(conn, active)}
        <span className="r">{transportShort(conn)}</span>
      </footer>
    </div>
  )
}

function FloatingPanel({
  anchorRef,
  scheme,
  conn,
  active,
}: {
  anchorRef: RefObject<HTMLDivElement | null>
  scheme: Scheme
  conn: DemoConn
  active: boolean
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; caret: number } | null>(null)

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return

    const update = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const width = panel.offsetWidth
      const height = panel.offsetHeight
      const margin = 12

      // 面板顶边与磁贴顶边对齐：高面板居中会一路顶到标题栏上，遮住窗口控件。
      const top = Math.max(margin, Math.min(rect.top, window.innerHeight - height - margin))
      const maxLeft = window.innerWidth - width - margin
      const left = Math.min(rect.right + margin, Math.max(margin, maxLeft))
      const caret = Math.max(16, Math.min(rect.top + rect.height / 2 - top, height - 16))

      setPos({ left, top, caret })
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(panel)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchorRef, conn, scheme])

  const style = {
    left: pos ? pos.left : -9999,
    top: pos ? pos.top : -9999,
    visibility: pos ? ('visible' as const) : ('hidden' as const),
  }

  return createPortal(
    <div
      className={`tt-float engine-${conn.engine}`}
      data-scheme={scheme}
      data-tone={railTone(conn)}
      style={style}
    >
      <span className="tt-caret" style={{ top: pos ? pos.caret - 4.5 : 0 }} />
      <div ref={panelRef}>
        {scheme === 'A' ? <PanelA conn={conn} active={active} /> : null}
        {scheme === 'B' ? <PanelB conn={conn} active={active} /> : null}
        {scheme === 'C' ? <PanelC conn={conn} active={active} /> : null}
        {scheme === 'D' ? <PanelD conn={conn} active={active} /> : null}
      </div>
    </div>,
    document.body,
  )
}

function Tile({
  conn,
  inspected,
  scheme,
  onInspect,
}: {
  conn: DemoConn
  inspected: boolean
  scheme: Scheme
  onInspect: (id: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const active = conn.id === ACTIVE_ID
  return (
    <>
      <div
        ref={ref}
        className={`conn-item is-${conn.status}${active ? ' active' : ''}${
          inspected ? ' is-inspected' : ''
        }`}
        onMouseEnter={() => onInspect(conn.id)}
        onClick={() => onInspect(conn.id)}
      >
        <span className="rail" />
        <div className="conn-body">
          <div className="conn-line">
            <span className={`engine-glyph engine-${conn.engine}`}>
              <EngineGlyph engine={conn.engine} size={15} />
            </span>
            <span className="conn-name ellipsis">{conn.name}</span>
            {conn.pinned ? <DialogIcon name="pin" size={12} className="pin-mark" /> : null}
            {conn.status === 'connected' ? (
              <span className="conn-tag ok">{conn.latency != null ? `${conn.latency}ms` : 'ok'}</span>
            ) : null}
          </div>
          <div className="conn-line sub">
            <span className="mono ellipsis">
              {conn.host}:{conn.port}
            </span>
            {conn.sshEnabled ? <span className="ssh-chip">SSH</span> : null}
            {conn.engine === 'redis' ? <span className="db-chip mono">db{conn.db}</span> : null}
          </div>
          {conn.status === 'error' && conn.message ? (
            <div className="conn-error ellipsis">{conn.message}</div>
          ) : null}
        </div>
        <span className="tt-more">
          <DialogIcon name="more" size={13} />
        </span>
      </div>
      {inspected ? (
        <FloatingPanel anchorRef={ref} scheme={scheme} conn={conn} active={active} />
      ) : null}
    </>
  )
}

export function ConnectionTooltipOptions() {
  const [scheme, setScheme] = useState<Scheme>('A')
  const [inspectedId, setInspectedId] = useState<string>('prod')
  const [theme, setTheme] = useState('dark')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = LIGHT_THEMES.has(theme) ? 'light' : 'dark'
  }, [theme])

  const schemeMeta = SCHEMES.find((item) => item.key === scheme) ?? SCHEMES[0]
  const connectedCount = CONNECTIONS.filter((conn) => conn.status === 'connected').length
  const inspected = CONNECTIONS.find((conn) => conn.id === inspectedId) ?? CONNECTIONS[0]
  const activeState =
    inspected.engine === 'memcached'
      ? 'mc'
      : inspected.status === 'error'
        ? 'broken'
        : inspected.status === 'disconnected'
          ? 'local'
          : 'prod'

  return (
    <div className="tt-page">
      <header className="tt-top">
        <div className="tt-brand">
          <span className="tt-mark">K</span>
          <div>
            <div className="tt-brand-name">连接项悬浮面板</div>
            <div className="tt-brand-sub">Keyper · 交互设计方案预览</div>
          </div>
        </div>

        <div className="tt-controls">
          <div className="tt-group" role="group" aria-label="面板方案">
            {SCHEMES.map((item) => (
              <button
                key={item.key}
                className={`tt-seg${scheme === item.key ? ' on' : ''}`}
                onClick={() => setScheme(item.key)}
              >
                <span className="tt-seg-key">{item.key}</span>
                {item.short}
              </button>
            ))}
          </div>

          <div className="tt-group" role="group" aria-label="连接状态">
            {STATES.map((item) => (
              <button
                key={item.key}
                className={`tt-seg${activeState === item.key ? ' on' : ''}`}
                onClick={() => setInspectedId(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <label className="tt-theme">
            <select value={theme} onChange={(event) => setTheme(event.target.value)}>
              {THEMES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <div className="tt-meta">
        <b>
          方案 {schemeMeta.key} · {schemeMeta.title}
        </b>
        <span>{schemeMeta.tagline}</span>
        <span className="tt-meta-spec">
          {schemeMeta.width} · 推荐：{schemeMeta.fit}
        </span>
      </div>

      <main className="tt-stage">
        <div className="tt-side-wrap">
          <div className="tt-sidebar s-connection-sidebar">
            <div className="tt-side-head">
              <span className="tt-side-title">连接</span>
              <span className="tt-side-count">{CONNECTIONS.length}</span>
              <span className="tt-side-actions">
                <span>
                  <DialogIcon name="add" size={13} />
                </span>
                <span>
                  <DialogIcon name="more" size={13} />
                </span>
                <span>
                  <DialogIcon name="sidebar-collapse" size={13} />
                </span>
              </span>
            </div>

            <div className="conn-list">
              {CONNECTIONS.map((conn) => (
                <Tile
                  key={conn.id}
                  conn={conn}
                  scheme={scheme}
                  inspected={conn.id === inspectedId}
                  onInspect={setInspectedId}
                />
              ))}
            </div>

            <div className="tt-side-foot">
              <span className="tt-env-dot" />
              已连接 {connectedCount} / {CONNECTIONS.length}
            </div>
          </div>
          <p className="tt-stage-hint">悬停任意连接项 · 面板固定出现在条目右侧</p>
        </div>

        <aside className="tt-info">
          <div className="tt-info-kicker">SCHEME {schemeMeta.key}</div>
          <h2>{schemeMeta.title}</h2>
          <p className="tt-info-tagline">{schemeMeta.tagline}</p>
          <ul>
            {schemeMeta.bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
          <div className="tt-info-foot">
            <b>预览行为：</b>面板常驻，悬停或点击其它条目即可切换；正式接入建议
            悬停 300–400 ms 后出现、移出隐藏。面板为 fixed 浮层并按视口夹取，
            不会被连接栏的滚动容器裁切。
          </div>
        </aside>
      </main>

      <footer className="tt-cards">
        {SCHEMES.map((item) => (
          <button
            key={item.key}
            className={`tt-card${scheme === item.key ? ' on' : ''}`}
            onClick={() => setScheme(item.key)}
          >
            <span className="tt-card-top">
              <span className="tt-card-key">{item.key}</span>
              <span className="tt-card-title">{item.title}</span>
              <span className="tt-card-width">{item.width}</span>
            </span>
            <p>{item.tagline}</p>
          </button>
        ))}
      </footer>
    </div>
  )
}

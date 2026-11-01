import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SshConfig } from '@shared/types'
import { DialogIcon } from '@/components/DialogIcon'
import { EngineGlyph } from '@/components/EngineGlyph'
import { engineMeta } from '@/utils/engine'
import type { ConnectionItem } from '@/store/useRedis'
import { useI18n } from '@/i18n'

/**
 * 连接项悬浮面板（方案 C · 身份链路）。
 *
 * 挂在连接磁贴右侧的富信息浮层：
 *   · 身份头带用引擎色区分 Redis / Memcached，名称与运行态同屏；
 *   · 端点独立成块，db / TLS / SSH 徽标紧随其后；
 *   · SSH 隧道按「本机 → 前置跳板 → 跳板机 → 目标」竖向展开，
 *     多级堡垒机场景不必再翻编辑对话框；
 *   · 失败原因与凭据问题就近提示，底部给出点击后的动作预期。
 *
 * 为什么不用全局 AppTooltip：那套是纯文本气泡（max-width 320、单行/换行），
 * 放不下分组、链路与指标；且本面板只在连接列表使用，独立组件更好收敛。
 *
 * 定位约定（与设计预览一致）：
 *   · portal 到 body + position: fixed —— 连接栏的 .conn-list 是滚动容器，
 *     面板挂在里面会被 overflow 裁掉；
 *   · 顶边与磁贴顶边对齐，而不是垂直居中 —— 高面板居中会一路顶到
 *     标题栏，遮住窗口控件；
 *   · pointer-events: none —— 面板不参与命中测试，鼠标移出磁贴即消失，
 *     不会出现「鼠标移到面板上算不算离开磁贴」的抖动。
 *
 * 安全约定：只展示「是否配置了凭据 / 认证方式」，密码、SSH 密码、
 * 私钥与口令一律不进入面板文本。
 */

interface ConnectionTooltipProps {
  conn: ConnectionItem
  /** 磁贴元素，用于取锚点矩形 */
  anchor: HTMLElement
  /** 是否为当前会话选中的连接（决定底部动作提示） */
  active: boolean
}

/** 面板与磁贴的水平间距 */
const GAP = 12
/** 与视口边缘的最小留白 */
const EDGE = 12

type Tone = 'ok' | 'warn' | 'err' | 'muted'

interface RouteNode {
  kind: 'local' | 'hop' | 'target'
  text: string
  chip?: string
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
    <div className="conn-tip-metric">
      <div className="k">{k}</div>
      <div className={`v${mono ? ' mono' : ''}${tone ? ` ${tone}` : ''}`}>{v}</div>
    </div>
  )
}

export function ConnectionTooltip({ conn, anchor, active }: ConnectionTooltipProps) {
  const { t } = useI18n()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; caret: number } | null>(null)

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return

    const update = (): void => {
      if (!anchor.isConnected) return
      const rect = anchor.getBoundingClientRect()
      const width = panel.offsetWidth
      const height = panel.offsetHeight

      // 顶边对齐磁贴；底部放不下时整体上移，保证窗口控件不被遮住
      const top = Math.max(
        EDGE,
        Math.min(rect.top, window.innerHeight - height - EDGE),
      )
      const maxLeft = window.innerWidth - width - EDGE
      const left = Math.min(rect.right + GAP, Math.max(EDGE, maxLeft))
      // 小箭头对准磁贴垂直中心，并夹在面板圆角以内
      const caret = Math.max(16, Math.min(rect.top + rect.height / 2 - top, height - 16))

      setPos({ left, top, caret })
    }

    update()
    /* 面板内容随状态变化（连接中 → 已连接）会改高度，磁贴自身也会变高 */
    const observer = new ResizeObserver(update)
    observer.observe(panel)
    observer.observe(anchor)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor, conn])

  const mc = conn.engine === 'memcached'
  const tls = conn.engine === 'redis' && conn.tls === true
  const ssh: SshConfig | null = conn.sshEnabled && conn.ssh ? conn.ssh : null
  const connected = conn.status === 'connected'

  const status: { tone: Tone; label: string } =
    conn.status === 'connected'
      ? { tone: 'ok', label: t('connectionTooltip.statusConnected') }
      : conn.status === 'connecting'
        ? { tone: 'warn', label: t('connectionTooltip.statusConnecting') }
        : conn.status === 'error'
          ? { tone: 'err', label: t('connectionTooltip.statusError') }
          : { tone: 'muted', label: t('connectionTooltip.statusDisconnected') }

  const sub = [
    engineMeta(conn.engine).label.toUpperCase(),
    !mc && connected && conn.mode ? conn.mode : null,
    connected && conn.version ? `v${conn.version}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const latency = connected && conn.latency != null ? `${conn.latency} ms` : '—'
  const modeValue = mc ? String(conn.poolSize ?? 4) : connected ? (conn.mode ?? '—') : '—'
  const auth = mc
    ? t('connectionTooltip.authNone')
    : conn.credentialError
      ? t('connectionTooltip.authBroken')
      : conn.username && conn.password
        ? t('connectionTooltip.authUsernamePassword')
        : conn.password
          ? t('connectionTooltip.authPassword')
          : t('connectionTooltip.authNotConfigured')

  const nodes: RouteNode[] = [
    { kind: 'local', text: t('connectionTooltip.nodeLocal') },
    ...(ssh?.hops ?? []).map((hop) => ({
      kind: 'hop' as const,
      text: `${hop.username}@${hop.host}:${hop.port}`,
      chip: t('connectionTooltip.hopPrefix'),
    })),
    ...(ssh
      ? [
          {
            kind: 'hop' as const,
            text: `${ssh.username}@${ssh.host}:${ssh.port}`,
            chip: t('connectionTooltip.jumpHost'),
          },
        ]
      : []),
    { kind: 'target', text: `${conn.host}:${conn.port}`, chip: t('connectionTooltip.target') },
  ]

  const action =
    conn.status === 'connected'
      ? active
        ? t('connectionTooltip.actionCurrent')
        : t('connectionTooltip.actionSwitch')
      : conn.status === 'error'
        ? t('connectionTooltip.actionReconnect')
        : conn.status === 'connecting'
          ? t('connectionTooltip.actionConnecting')
          : t('connectionTooltip.actionConnect')

  const transport = [tls ? 'TLS' : 'TCP', conn.sshEnabled ? 'SSH' : null]
    .filter(Boolean)
    .join(' · ')

  return createPortal(
    <div
      className={`conn-tip-float s-connection-tooltip engine-${conn.engine}`}
      style={{
        left: pos ? pos.left : -9999,
        top: pos ? pos.top : -9999,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      <span className="conn-tip-caret" style={{ top: pos ? pos.caret - 4.5 : 0 }} />

      <div ref={panelRef} className={`conn-tip-panel engine-${conn.engine}`} role="tooltip">
        <header className="conn-tip-band">
          <div className="conn-tip-top">
            <span className="conn-tip-glyph">
              <EngineGlyph engine={conn.engine} size={19} />
            </span>
            <div className="conn-tip-id">
              <div className="conn-tip-name-line">
                <span className="conn-tip-name">{conn.name}</span>
                {conn.pinned ? <DialogIcon name="pin" size={11} className="conn-tip-pin" /> : null}
              </div>
              <div className="conn-tip-sub">{sub}</div>
            </div>
            <span className={`conn-tip-status ${status.tone}`}>
              <span className="conn-tip-status-dot" />
              {status.label}
            </span>
          </div>
        </header>

        <div className="conn-tip-body">
          <div className="conn-tip-endpoint">
            <div className="k">{t('connectionActions.address')}</div>
            <div className="v">
              {conn.host}:{conn.port}
            </div>
            <span className="conn-tip-chips">
              {mc ? null : <span className="conn-tip-chip mono">db{conn.db}</span>}
              {tls ? <span className="conn-tip-chip">TLS</span> : null}
              {conn.sshEnabled ? <span className="conn-tip-chip accent">SSH</span> : null}
            </span>
          </div>

          <div className="conn-tip-metrics">
            <Metric k={t('connectionTooltip.latency')} v={latency} mono tone={connected ? 'ok' : 'dim'} />
            <Metric
              k={mc ? t('connectionActions.connectionPool') : t('connectionTooltip.mode')}
              v={modeValue}
              tone={mc || connected ? undefined : 'dim'}
            />
            <Metric k={t('connectionTooltip.auth')} v={auth} />
          </div>

          {conn.status === 'error' && conn.message ? (
            <div className="conn-tip-notice danger">
              <DialogIcon name="warning" size={12} />
              <div className="body">
                <div className="label">{t('connectionTooltip.failureReason')}</div>
                <div className="text mono">{conn.message}</div>
              </div>
            </div>
          ) : null}

          {conn.credentialError ? (
            <div className="conn-tip-notice warn">
              <DialogIcon name="info" size={12} />
              <div className="body">
                <div className="text">{t('connectionTooltip.credentialUnreadable')}</div>
              </div>
            </div>
          ) : null}

          <div className="conn-tip-route">
            <div className="conn-tip-route-head">
              <DialogIcon name="link" size={11} />
              <span>{ssh ? t('connectionActions.sshTunnel') : t('connectionTooltip.routeDirect')}</span>
              <span className="r">
                {ssh
                  ? ssh.authMethod === 'key'
                    ? t('connectionTooltip.sshAuthKey')
                    : t('connectionTooltip.sshAuthPassword')
                  : t('connectionTooltip.direct')}
              </span>
            </div>
            <div className="conn-tip-nodes">
              {nodes.map((node, index) => (
                <div className={`conn-tip-node is-${node.kind}`} key={`${node.kind}-${node.text}-${index}`}>
                  <span className="conn-tip-node-dot" />
                  <span className={`txt${node.kind === 'local' ? ' plain' : ''}`}>{node.text}</span>
                  {node.chip ? <span className="conn-tip-chip">{node.chip}</span> : null}
                </div>
              ))}
            </div>
          </div>
        </div>

        <footer className="conn-tip-foot">
          {action}
          <span className="r">{transport}</span>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

export default ConnectionTooltip

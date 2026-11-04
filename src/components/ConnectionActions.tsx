import { useRef, useState } from 'react'
import { api } from '@/api'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { ConnectionItem, useRedis } from '@/store/useRedis'
import { copyText } from '@/utils/clipboard'
import { toConfig } from '@/utils/engine'
import { useI18n } from '@/i18n'

export interface ConnectionActionsProps {
  connection: ConnectionItem
  onEdit: (connection: ConnectionItem) => void
  onVersion: (connection: ConnectionItem) => void
  onRunLua: (connection: ConnectionItem) => void
}

const MENU_WIDTH = 196

/** 连接项右侧「更多操作」菜单（建立/断开、刷新指标、版本、测试、置顶、编辑、克隆、复制地址、删除） */
export function ConnectionActions({ connection, onEdit, onVersion, onRunLua }: ConnectionActionsProps) {
  const {
    connect,
    disconnect,
    selectConnection,
    cloneConnection,
    removeConnection,
    pinConnection,
    activateAndRefresh,
    askConfirm,
    notify,
  } = useRedis()

  const { t } = useI18n()

  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })

  const isConnected = connection.status === 'connected'

  /**
   * 可复制的连接串。
   *
   * Redis 用标准 URI（redis://[user][:password]@host:port/db）；
   * Memcached 没有公认的 URI 方案，硬套 redis:// 会误导用户，
   * 因此退化为 `host:port`，这也是运维日常粘贴的形式。
   */
  const connectionUrl = (() => {
    if (connection.engine === 'memcached') {
      return `${connection.host}:${connection.port}`
    }
    const { host, port, db, username, password } = connection
    let auth = ''
    if (username) auth = `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
    else if (password) auth = `:${encodeURIComponent(password)}@`
    return `redis://${auth}${host}:${port}/${db}`
  })()

  function toggleOpen(event: React.MouseEvent): void {
    event.stopPropagation()
    if (open) {
      setOpen(false)
      return
    }
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect) {
      /*
       * 先按「向下展开」放个初始位置让菜单挂载，下一帧再用**实际高度**落位。
       * 菜单项数随连接状态变化（已连接多一项「刷新服务端指标」），
       * 固定估算值永远有时偏出：偏大 → 底部锚点向上展开时菜单与锚点之间
       * 悬空一大截；偏小 → 底边溢出窗口。
       */
      setPosition({
        top: rect.bottom + 4,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
      })
      setOpen(true)
      requestAnimationFrame(() => place(rect))
    } else {
      setOpen(true)
    }
  }

  /** 按菜单实际尺寸落位。rAF 在首次 paint 前执行，用户看不到「先向下再跳上去」的中间帧。 */
  function place(rect: DOMRect): void {
    const el = menuRef.current
    if (!el) return
    const height = el.offsetHeight
    let top = rect.bottom + 4
    if (top + height > window.innerHeight - 8) {
      // 下方放不下：菜单底边贴锚点顶边，向上展开
      top = rect.top - height - 4
    }
    // 上下都放不下（窗口本身比菜单矮）：贴顶，余下交给内部滚动
    setPosition({
      top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
    })
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setOpen(false)
    try {
      await action()
    } catch (error) {
      notify('err', error instanceof Error ? error.message : t('connectionActions.operationFailed'))
    }
  }

  function handleToggleStatus(): void {
    void run(async () => {
      if (isConnected) await disconnect(connection.id)
      else await connect(toConfig(connection))
    })
  }

  function handleRefreshMetrics(): void {
    void run(async () => {
      await activateAndRefresh(connection.id)
      notify('ok', t('connectionActions.serverMetricsRefreshed'))
    })
  }

  function handleTest(): void {
    void run(async () => {
      const res = await api.connection.test(connection)
      if (res.ok) notify(res.data.ok ? 'ok' : 'err', res.data.message ?? t('connectionActions.testComplete'))
      else notify('err', res.error)
    })
  }

  function handleEdit(): void {
    setOpen(false)
    onEdit(connection)
  }

  /** 置顶 / 取消置顶：文字随当前状态切换，便于确认下一步操作的方向 */
  function handlePin(): void {
    void run(() => pinConnection(connection.id, !connection.pinned))
  }

  /** 查看版本信息：需先有会话，未连接时提示用户先连接 */
  function handleVersion(): void {
    setOpen(false)
    if (!isConnected) {
      notify('err', t('connectionActions.connectFirstViewVersionInfo'))
      return
    }
    onVersion(connection)
  }

  /** Lua 编辑器依赖已建立的会话：先激活该连接标签，再打开控制台 */
  function handleLua(): void {
    setOpen(false)
    if (!isConnected) {
      notify('err', t('connectionActions.connectFirstRunLuaScript'))
      return
    }
    selectConnection(connection.id)
    onRunLua(connection)
  }

  function handleClone(): void {
    void run(() => cloneConnection(connection))
  }

  function handleCopy(): void {
    void run(async () => {
      const done = await copyText(connectionUrl)
      if (!done) {
        notify('err', t('common.copyFailedCheckClipboardPermissions'))
        return
      }
      const withSecret = connection.engine === 'redis' && !!connection.password
      notify('ok', withSecret ? t('connectionActions.copiedAddressWithPassword') : t('connectionActions.copiedConnectionAddress'))
    })
  }

  function handleDelete(): void {
    void run(async () => {
      /*
       * 删除连接必须二次确认（force：不受「删除键前确认」设置影响 ——
       * 这个开关是为高频的键删除设计的，连接删除低频且删的是整套配置，
       * SSH、密码全都要重填，误删代价远高于多点一次确认）。
       */
      const confirmed = await askConfirm({
        title: t('connectionActions.deleteConnection'),
        message: t('connectionActions.connectionNameDeleted', { name: connection.name }),
        /*
         * 明细按引擎给字段：Memcached 没有 db，硬写 db0 会让用户
         * 以为删的是某个库，而实际删的是整台实例的配置；SSH 两者共用。
         */
        details:
          connection.engine === 'memcached'
            ? [
                { label: t('connectionActions.address'), value: `${connection.host}:${connection.port}`, mono: true },
                { label: t('connectionActions.engine'), value: 'Memcached', mono: false },
                { label: t('connectionActions.connectionPool'), value: t('connectionActions.countConnections', { count: connection.poolSize ?? 4 }), mono: true },
                ...(connection.sshEnabled && connection.ssh
                  ? [{ label: t('connectionActions.sshTunnel'), value: `${connection.ssh.host}:${connection.ssh.port}`, mono: true }]
                  : []),
              ]
            : [
                { label: t('connectionActions.address'), value: `${connection.host}:${connection.port}`, mono: true },
                { label: t('common.defaultDatabase'), value: `db${connection.db}`, mono: true },
                ...(connection.sshEnabled && connection.ssh
                  ? [{ label: t('connectionActions.sshTunnel'), value: `${connection.ssh.host}:${connection.ssh.port}`, mono: true }]
                  : []),
              ],
        warning:
          connection.engine === 'memcached'
            ? t('connectionActions.deleteWarningCredentials')
            : t('connectionActions.deleteWarningPassword'),
        confirmText: t('common.delete'),
        danger: true,
        force: true,
      })
      if (!confirmed) return
      await removeConnection(connection.id)
    })
  }

  return (
    <div ref={anchorRef} className="conn-actions s-connection-actions" onClick={(event) => event.stopPropagation()}>
      {/* 实心三点（more）+ 常显主色：描线 menu 在弱色下几乎不可见 */}
      <button className="more-btn" {...tipProps(t('common.moreActions'))} onClick={toggleOpen}>
        <DialogIcon name="more" size={15} />
      </button>

      {open ? (
        <>
          <div className="popover-mask" onClick={() => setOpen(false)} />
          <div
            ref={menuRef}
            className="menu"
            style={{ top: `${position.top}px`, left: `${position.left}px`, width: `${MENU_WIDTH}px` }}
          >
            <button className="menu-item" onClick={handleToggleStatus}>
              <DialogIcon name="power" size={13} className="mi-icon" />
              <span>{isConnected ? t('connectionActions.disconnect') : t('connectionActions.connect')}</span>
            </button>

            {isConnected ? (
              <button className="menu-item" onClick={handleRefreshMetrics}>
                <DialogIcon name="refresh" size={13} className="mi-icon" />
                <span>{t('connectionActions.refreshServerMetrics')}</span>
              </button>
            ) : null}

            <button className="menu-item" onClick={handleVersion}>
              <DialogIcon name="info" size={13} className="mi-icon" />
              <span>{t('connectionActions.versionInfo')}</span>
              {!isConnected ? <span className="shortcut">{t('connectionActions.requiresConnection')}</span> : null}
            </button>

            <button className="menu-item" onClick={handleTest}>
              <DialogIcon name="bolt" size={13} className="mi-icon" />
              <span>{t('connectionActions.testConnection')}</span>
            </button>

            {connection.engine === 'redis' ? (
              <button className="menu-item" onClick={handleLua}>
                <DialogIcon name="code" size={13} className="mi-icon" />
                <span>{t('connectionActions.runLuaScript')}</span>
                {!isConnected ? (
                  <span className="shortcut">{t('connectionActions.requiresConnection')}</span>
                ) : null}
              </button>
            ) : null}

            <div className="menu-sep" />

            <button className="menu-item" onClick={handlePin}>
              <DialogIcon name="pin" size={13} className="mi-icon" />
              <span>{connection.pinned ? t('connectionActions.unpin') : t('connectionActions.pin')}</span>
            </button>

            <button className="menu-item" onClick={handleEdit}>
              <DialogIcon name="edit" size={13} className="mi-icon" />
              <span>{t('connectionActions.editConfig')}</span>
            </button>

            <button className="menu-item" onClick={handleClone}>
              <DialogIcon name="clone" size={13} className="mi-icon" />
              <span>{t('connectionActions.cloneConnection')}</span>
            </button>

            <button className="menu-item" onClick={handleCopy}>
              <DialogIcon name="copy" size={13} className="mi-icon" />
              <span>{t('connectionActions.copyConnectionAddress')}</span>
            </button>

            <div className="menu-sep" />

            <button className="menu-item danger" onClick={handleDelete}>
              {/* 删除用垃圾桶而非 ×：「×」在菜单里读作"关闭菜单"，与删除语义相反 */}
              <DialogIcon name="trash" size={13} className="mi-icon" />
              <span>{t('connectionActions.deleteConnection')}</span>
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

export default ConnectionActions

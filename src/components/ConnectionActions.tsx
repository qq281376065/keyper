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
}

const MENU_WIDTH = 196

/** 连接项右侧「更多操作」菜单（建立/断开、刷新指标、版本、测试、置顶、编辑、克隆、复制地址、删除） */
export function ConnectionActions({ connection, onEdit, onVersion }: ConnectionActionsProps) {
  const {
    connect,
    disconnect,
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
      notify('err', error instanceof Error ? error.message : t('操作失败'))
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
      notify('ok', t('服务端指标已刷新'))
    })
  }

  function handleTest(): void {
    void run(async () => {
      const res = await api.connection.test(connection)
      if (res.ok) notify(res.data.ok ? 'ok' : 'err', res.data.message ?? t('测试完成'))
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
      notify('err', t('请先建立连接，再查看版本信息'))
      return
    }
    onVersion(connection)
  }

  function handleClone(): void {
    void run(() => cloneConnection(connection))
  }

  function handleCopy(): void {
    void run(async () => {
      const done = await copyText(connectionUrl)
      if (!done) {
        notify('err', t('复制失败，请检查剪贴板权限'))
        return
      }
      const withSecret = connection.engine === 'redis' && !!connection.password
      notify('ok', withSecret ? t('已复制连接地址（含密码）') : t('已复制连接地址'))
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
        title: t('删除连接'),
        message: t('即将删除连接「{name}」：', { name: connection.name }),
        /*
         * 明细按引擎给字段：Memcached 没有 db，硬写 db0 会让用户
         * 以为删的是某个库，而实际删的是整台实例的配置；SSH 两者共用。
         */
        details:
          connection.engine === 'memcached'
            ? [
                { label: t('地址'), value: `${connection.host}:${connection.port}`, mono: true },
                { label: t('引擎'), value: 'Memcached', mono: false },
                { label: t('连接池'), value: t('{count} 个连接', { count: connection.poolSize ?? 4 }), mono: true },
                ...(connection.sshEnabled && connection.ssh
                  ? [{ label: t('SSH 隧道'), value: `${connection.ssh.host}:${connection.ssh.port}`, mono: true }]
                  : []),
              ]
            : [
                { label: t('地址'), value: `${connection.host}:${connection.port}`, mono: true },
                { label: t('默认库'), value: `db${connection.db}`, mono: true },
                ...(connection.sshEnabled && connection.ssh
                  ? [{ label: t('SSH 隧道'), value: `${connection.ssh.host}:${connection.ssh.port}`, mono: true }]
                  : []),
              ],
        warning:
          connection.engine === 'memcached'
            ? t('删除后无法恢复，连接配置（含 SSH 凭据）需要重新填写。')
            : t('删除后无法恢复，连接配置（含 SSH、密码）需要全部重新填写。'),
        confirmText: t('删除'),
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
      <button className="more-btn" {...tipProps(t('更多操作'))} onClick={toggleOpen}>
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
              <span>{isConnected ? t('断开连接') : t('建立连接')}</span>
            </button>

            {isConnected ? (
              <button className="menu-item" onClick={handleRefreshMetrics}>
                <DialogIcon name="refresh" size={13} className="mi-icon" />
                <span>{t('刷新服务端指标')}</span>
              </button>
            ) : null}

            <button className="menu-item" onClick={handleVersion}>
              <DialogIcon name="info" size={13} className="mi-icon" />
              <span>{t('版本信息…')}</span>
              {!isConnected ? <span className="shortcut">{t('需连接')}</span> : null}
            </button>

            <button className="menu-item" onClick={handleTest}>
              <DialogIcon name="bolt" size={13} className="mi-icon" />
              <span>{t('测试连接')}</span>
            </button>

            <div className="menu-sep" />

            <button className="menu-item" onClick={handlePin}>
              <DialogIcon name="pin" size={13} className="mi-icon" />
              <span>{connection.pinned ? t('取消置顶') : t('置顶')}</span>
            </button>

            <button className="menu-item" onClick={handleEdit}>
              <DialogIcon name="edit" size={13} className="mi-icon" />
              <span>{t('编辑配置…')}</span>
            </button>

            <button className="menu-item" onClick={handleClone}>
              <DialogIcon name="clone" size={13} className="mi-icon" />
              <span>{t('克隆连接')}</span>
            </button>

            <button className="menu-item" onClick={handleCopy}>
              <DialogIcon name="copy" size={13} className="mi-icon" />
              <span>{t('复制连接地址')}</span>
            </button>

            <div className="menu-sep" />

            <button className="menu-item danger" onClick={handleDelete}>
              {/* 删除用垃圾桶而非 ×：「×」在菜单里读作"关闭菜单"，与删除语义相反 */}
              <DialogIcon name="trash" size={13} className="mi-icon" />
              <span>{t('删除连接')}</span>
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

export default ConnectionActions

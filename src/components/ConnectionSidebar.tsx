import { useRef, useState } from 'react'
import { ConnectionActions } from '@/components/ConnectionActions'
import { DialogIcon } from '@/components/DialogIcon'
import { EngineGlyph } from '@/components/EngineGlyph'
import { tipProps } from '@/components/tip'
import { engineMeta } from '@/utils/engine'
import { useSettings } from '@/services/settings'
import { useSettingsHolder } from '@/hooks/useSettingsHolder'
import type { ConnectionItem } from '@/store/useRedis'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { globalHolder } from '@/store/global'
import { useI18n } from '@/i18n'

export interface ConnectionSidebarProps {
  onNewConnection: () => void
  onEditConnection: (connection: ConnectionItem) => void
  onViewVersion: (connection: ConnectionItem) => void
}

/** 批量删除入口的显隐门槛：连接数 ≥3 才有批量价值 */
const BULK_CONN_MIN = 3

/**
 * 左侧连接列表（展开 / 收起两态），含批量删除多选与拖拽排序。
 *
 * 批量删除（用户需求）：
 *   · 显隐门槛：连接数 ≥3 才在操作栏显示入口图标；
 *   · 模式切换：点图标进入多选模式，再点一次退出；
 *     行为互斥 —— 多选态下点行 = 勾选/取消勾选（不触发连接），
 *     拖拽排序同时禁用（拖拽与勾选共用 mousedown 手势会互相干扰）。
 *   · 执行：底部操作条「删除」→ askConfirm（force）→ removeConnections 静默
 *     批量（一次 bootstrap + 汇总 toast，不逐个弹 N 个 toast）。
 */
export function ConnectionSidebar({
  onNewConnection,
  onEditConnection,
  onViewVersion,
}: ConnectionSidebarProps) {
  const { state, connect, selectConnection, moveConnection, removeConnections, askConfirm } = useRedis()
  const { settings, save: saveSettings } = useSettings()
  const { t } = useI18n()
  const holder = useSettingsHolder()
  useObservable(globalHolder)
  useObservable(holder)
  const [busyId, setBusyId] = useState<string | null>(null)

  /**
   * 展示顺序：置顶的排前面，同组保持数组先后。
   *
   * 只在显示层叠加分组、不在此处改 state.connections ——
   * 置顶/取消置顶只改 pinned 字段，数组顺序由「添加序 + 拖拽（moveConnection
   * 把数组重排为显示序后落盘）」共同决定。
   */
  const sortedConnections = [...state.connections].sort(
    (a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false),
  )

  const showBulkBtn = sortedConnections.length >= BULK_CONN_MIN
  const [bulkMode, setBulkMode] = useState(false)
  /** 已勾选待删除的连接 id 集合 */
  const [bulkChecked, setBulkChecked] = useState<Set<string>>(new Set())

  /*
   * 批量删除的目标集 = 非置顶连接：置顶是"常用连接"的显式标记，
   * 不该被批量操作误删。置顶项在多选模式下不渲染勾选框、点行不响应勾选；
   * 全选也只作用于这个集合。
   */
  const bulkCandidates = sortedConnections.filter((item) => !item.pinned)

  function toggleBulkMode(): void {
    setBulkMode((prev) => !prev)
    /* 进入即清空上次残留勾选；退出同样清，避免隐式记住旧选择 */
    setBulkChecked(new Set())
  }

  function toggleBulkCheck(id: string): void {
    setBulkChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const bulkAllChecked =
    bulkMode && bulkCandidates.length > 0 && bulkCandidates.every((item) => bulkChecked.has(item.id))

  function toggleBulkAll(): void {
    setBulkChecked(bulkAllChecked ? new Set() : new Set(bulkCandidates.map((item) => item.id)))
  }

  const bulkSelectedCount = bulkChecked.size

  async function confirmBulkDelete(): Promise<void> {
    /* 双保险过滤置顶：勾选链路已隔离，这里防未来状态窜入 */
    const ids = [...bulkChecked].filter((id) => {
      const target = sortedConnections.find((item) => item.id === id)
      return target && !target.pinned
    })
    if (!ids.length) return

    const names = sortedConnections.filter((item) => ids.includes(item.id)).map((item) => item.name)

    const ok = await askConfirm({
      force: true,
      title: t('批量删除 {count} 个连接', { count: ids.length }),
      message: t('即将删除以下连接配置（已连接的会先断开）：'),
      details: names.map((name) => ({ label: t('连接'), value: name })),
      warning: t('删除后不可恢复，相关标签页将一并关闭。'),
      confirmText: t('删除 {count} 个连接', { count: ids.length }),
    })
    if (!ok) return

    await removeConnections(ids)
    /* 连接删到门槛以下时按钮已隐藏，模式同步退出 */
    if (sortedConnections.length < BULK_CONN_MIN) setBulkMode(false)
    setBulkChecked(new Set())
  }

  /*
   * 拖拽排序（原生 HTML5 DnD，展开态与收起态共用一套 handlers）。
   * Chrome 要求 dragstart 必须写入 dataTransfer 数据，否则拖拽根本不会开始。
   */
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: 'before' | 'after' } | null>(null)

  function onDragStart(item: ConnectionItem, event: React.DragEvent): void {
    /* 多选模式下拖拽已禁用（draggable=false），此处守卫兜底防误触 */
    if (bulkMode) return
    setDragId(item.id)
    event.dataTransfer?.setData('text/plain', item.id)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }

  function onDragOver(item: ConnectionItem, event: React.DragEvent): void {
    if (!dragId || dragId === item.id) return
    /*
     * 跨组（置顶↔非置顶）拖拽就地拒绝：显示顺序由 pinned 分组决定，
     * 落进另一组也不会出现在落点 —— 不给指示线、不 preventDefault（drop 不会触发），
     * 比拖完"弹回原位"诚实。
     */
    const dragged = state.connections.find((c) => c.id === dragId)
    if (!dragged || !!dragged.pinned !== !!item.pinned) {
      setDropTarget(null)
      return
    }
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    /*
     * 两列磁贴：落点按「左右半区」判断，而不是上下。
     *
     * 单列表时上下半区对应"插到前面/后面"，语义清楚；
     * 磁贴是横向排列的，鼠标在卡片左半边却判成 before 会显得莫名其妙 ——
     * 改成按 clientX 与卡片中线比较，左半 = 插到它之前，右半 = 插到它之后。
     * 视觉上正好对应 drop-before/after 画在左缘还是右缘的竖线。
     */
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    setDropTarget({
      id: item.id,
      pos: event.clientX < rect.left + rect.width / 2 ? 'before' : 'after',
    })
  }

  function onDrop(item: ConnectionItem, event: React.DragEvent): void {
    event.preventDefault()
    if (dragId && dropTarget && dropTarget.id === item.id) {
      moveConnection(dragId, dropTarget.id, dropTarget.pos)
    }
  }

  /** drop 无论是否发生都触发；跨组被拒时也要清掉指示线残留 */
  function onDragEnd(): void {
    setDragId(null)
    setDropTarget(null)
  }

  function dropClass(item: ConnectionItem): string {
    if (!dropTarget || dropTarget.id !== item.id) return ''
    return dropTarget.pos === 'before' ? 'drop-before' : 'drop-after'
  }

  async function handleClick(item: ConnectionItem): Promise<void> {
    if (item.status === 'connected') {
      selectConnection(item.id)
      return
    }
    setBusyId(item.id)
    await connect(item)
    setBusyId(null)
  }

  /**
   * 收起 / 展开连接栏。
   *
   * 收起态只留 48px：足够显示"已连接"的绿色状态条与数量，
   * 又不至于把横向空间白占着 —— 键名长的时候，这 236px 正好让给键列表。
   */
  function toggleCollapsed(): void {
    void saveSettings({ sidebarCollapsed: !settings.sidebarCollapsed })
  }

  const collapsed = settings.sidebarCollapsed

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''} s-connection-sidebar`}>
      {collapsed ? (
        <>
          {/* 收起态：竖排窄条，只保留展开按钮、连接状态条与数量 */}
          <button className="rail-toggle" {...tipProps(t('展开'))} onClick={toggleCollapsed}>
            <DialogIcon name="sidebar-expand" size={14} />
          </button>

          <div className="rail-list">
            {sortedConnections.map((item) => (
              <button
                key={item.id}
                className={`rail-dot is-${item.status}${item.id === state.activeId ? ' active' : ''}${
                  dragId === item.id ? ' dragging' : ''
                } ${dropClass(item)}`.trim()}
                draggable
                {...tipProps(`${item.name} · ${item.host}:${item.port}`)}
                onClick={() => void handleClick(item)}
                onDragStart={(event) => onDragStart(item, event)}
                onDragOver={(event) => onDragOver(item, event)}
                onDrop={(event) => onDrop(item, event)}
                onDragEnd={onDragEnd}
              >
                {/* 取名字首字，让窄条上也能区分不同连接 */}
                <span>{item.name.slice(0, 1).toUpperCase()}</span>
              </button>
            ))}
          </div>

          <div className="rail-foot">
            <span className={`env-dot${state.envLabel.includes('Electron') ? ' live' : ''}`} />
          </div>
        </>
      ) : (
        <>
          <div className="sidebar-head">
            <span className="head-title">{t('连接')}</span>
            <div className="head-actions">
              {/* 批量删除入口：≥3 个连接才显示，点击进/出多选模式 */}
              {showBulkBtn ? (
                <button
                  className={`add-btn${bulkMode ? ' bulk-on' : ''}`}
                  {...tipProps(t(bulkMode ? '退出批量删除' : '批量删除连接'))}
                  onClick={toggleBulkMode}
                >
                  <DialogIcon name="trash" size={13} />
                </button>
              ) : null}
              <button className="add-btn" {...tipProps(t('新建连接'))} onClick={onNewConnection}>
                {/* 用 SVG 而非全角 ＋：字符的字形重心与盒中心不一致，换成矢量线条可精确居中 */}
                <DialogIcon name="add" size={13} />
              </button>
              <button className="add-btn" {...tipProps(t('收起'))} onClick={toggleCollapsed}>
                <DialogIcon name="sidebar-collapse" size={14} />
              </button>
            </div>
          </div>

          <div className="conn-list">
            {sortedConnections.map((item) => (
              <div
                key={item.id}
                className={`conn-item is-${item.status}${
                  item.id === state.activeId ? ' active' : ''
                }${dragId === item.id ? ' dragging' : ''}${bulkChecked.has(item.id) ? ' checked' : ''} ${dropClass(
                  item,
                )}`.trim()}
                draggable={!bulkMode}
                onClick={() => {
                  if (bulkMode) {
                    if (!item.pinned) toggleBulkCheck(item.id)
                  } else {
                    void handleClick(item)
                  }
                }}
                onDragStart={(event) => onDragStart(item, event)}
                onDragOver={(event) => onDragOver(item, event)}
                onDrop={(event) => onDrop(item, event)}
                onDragEnd={onDragEnd}
              >
                {/*
                  多选模式：行首勾选框（点行即切换，与整行点击区一致降低瞄准成本）。
                  置顶项不渲染（不参与批量删除）；点置顶行在多选模式下同样不响应勾选。
                */}
                {bulkMode && !item.pinned ? (
                  <span
                    className={`conn-check${bulkChecked.has(item.id) ? ' on' : ''}`}
                    role="checkbox"
                    aria-checked={bulkChecked.has(item.id)}
                  >
                    {bulkChecked.has(item.id) ? <DialogIcon name="check" size={11} /> : null}
                  </span>
                ) : null}
                <span className="rail" />
                <div className="conn-body">
                  <div className="conn-line">
                    {/*
                      引擎图形放名称行：扫列表时视线不用下移到地址行，
                      形状（层叠盘 / 内存芯片）比 14px 的字母角标更容易被余光捕捉。
                    */}
                    <span
                      className={`engine-glyph engine-${item.engine}`}
                      role="img"
                      aria-label={engineMeta(item.engine).label}
                      {...tipProps(engineMeta(item.engine).label)}
                    >
                      <EngineGlyph engine={item.engine} />
                    </span>
                    <span className="conn-name ellipsis">{item.name}</span>
                    {/* 置顶标记：不加的话列表顺序变了却看不出谁被置顶 */}
                    {item.pinned ? <DialogIcon name="pin" size={12} className="pin-mark" /> : null}
                    {busyId === item.id ? (
                      <span className="conn-tag">{t('连接中…')}</span>
                    ) : item.status === 'connected' ? (
                      <span className="conn-tag ok">
                        {item.latency != null ? `${item.latency}ms` : 'ok'}
                      </span>
                    ) : null}
                  </div>
                  <div className="conn-line sub">
                    <span className="mono ellipsis">
                      {item.host}:{item.port}
                    </span>
                    {/* SSH 徽标：一眼分清「直连」与「经跳板机」，连不通时最常搞混的就是这两个地址 */}
                    {item.sshEnabled ? (
                      <span
                        className="ssh-chip"
                        {...tipProps(
                          item.sshHost
                            ? t('经 SSH 隧道：{host}', { host: item.sshHost })
                            : t('经 SSH 隧道'),
                        )}
                      >
                        SSH
                      </span>
                    ) : null}
                    {/* db 只有 Redis 有；Memcached 不分区，显示 db0 是错的 */}
                    {item.engine === 'redis' ? (
                      <span className="db-chip mono">db{item.db}</span>
                    ) : null}
                  </div>
                  {item.status === 'error' && item.message ? (
                    <div className="conn-error ellipsis">{item.message}</div>
                  ) : null}
                </div>
                {/* 多选模式下隐藏行级菜单：勾选手势与 ⋮ 点击太近，误触率高且菜单项与批量语义无关 */}
                {!bulkMode ? (
                  <ConnectionActions
                    connection={item}
                    onEdit={onEditConnection}
                    onVersion={onViewVersion}
                  />
                ) : null}
              </div>
            ))}

            {state.ready && !state.connections.length ? (
              <p className="empty-tip">
                {t('暂无连接配置')}
                <br />
                {t('点击右上角 ＋ 添加一个 Redis 实例')}
              </p>
            ) : null}
          </div>

          {/*
            批量删除操作条：替代底部环境信息，与多选模式同生命周期。
            全选文字恒为「全选」二字不切换 —— 勾选态即全选、取消勾选即清空，
            「全选/全不选」两词宽度不同会在切换时挤压操作条造成上下抖动；
            语义细节由 tooltip 补充。
          */}
          {bulkMode ? (
            <div className="bulk-bar">
              <button
                className="bulk-all"
                {...tipProps(t(bulkAllChecked ? '取消全选' : '全选（不含置顶连接）'))}
                onClick={toggleBulkAll}
              >
                <span className={`conn-check${bulkAllChecked ? ' on' : ''}`} role="checkbox" aria-checked={bulkAllChecked}>
                  {bulkAllChecked ? <DialogIcon name="check" size={11} /> : null}
                </span>
                <span>{t('全选')}</span>
              </button>
              <span className="spacer" />
              <button className="btn tiny bulk-cancel" onClick={toggleBulkMode}>
                <DialogIcon name="cancel" size={11} />
                {t('取消')}
              </button>
              <button
                className="btn btn-primary tiny bulk-delete"
                disabled={bulkSelectedCount === 0}
                onClick={() => void confirmBulkDelete()}
              >
                <DialogIcon name="trash" size={11} />
                {t('删除')}
              </button>
            </div>
          ) : (
            <footer className="sidebar-foot">
              <span className={`env-dot${state.envLabel.includes('Electron') ? ' live' : ''}`} />
              <span className="ellipsis">{state.envLabel}</span>
            </footer>
          )}
        </>
      )}
    </aside>
  )
}

export default ConnectionSidebar

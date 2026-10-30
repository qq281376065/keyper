import { useEffect, useRef, useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { globalHolder } from '@/store/global'
import type { ConnectionItem, useGlobalRedis } from '@/store/useRedis'
import { useRedis } from '@/store/useRedis'
import { useObservable } from '@/store/subscription'
import { useI18n } from '@/i18n'

/**
 * 多标签栏：
 * 第一个是固定不可关闭的「主页」标签（WelcomePanel），其后每个已打开的
 * 连接一个标签。连接标签带关闭按钮 —— 关标签即断开连接（侧栏绿点
 * 熄灭），会话状态以快照留存，再次点该连接重连后即恢复。
 *
 * - 连接标签右键菜单：刷新 / 关闭 / 关闭其他 / 关闭右侧
 *   （主页标签不可关闭也无数据可刷，不响应右键）；
 * - 标签溢出：左右箭头滚动 + 最右侧「更多页签」下拉（全集列表，
 *   可直接切换与关闭，溢出时才出现，平时不占视觉）；
 * - 切换/新开标签时激活标签自动滚入可见区。
 */

const CTX_MENU_WIDTH = 176
const LIST_WIDTH = 216

export function TabBar() {
  const { state, activateTab, closeTab, closeOtherTabs, closeTabsToRight, activateAndRefresh } = useRedis()
  const { t } = useI18n()
  useObservable(globalHolder)

  const tabs = state.tabs.map((id) => ({
    id,
    conn: state.connections.find((item) => item.id === id) as ConnectionItem | undefined,
  }))

  /* ---------------------------------------------------------------- 溢出滚动 */
  const stripEl = useRef<HTMLDivElement | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)

  function updateScrollState(): void {
    const el = stripEl.current
    if (!el) return
    setOverflowing(el.scrollWidth > el.clientWidth + 1)
    setCanLeft(el.scrollLeft > 0)
    setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1)
  }

  /** 箭头步进：一次滚过大约一屏的 80%，比固定像素更贴合不同窗口宽 */
  function scrollStrip(dir: 1 | -1): void {
    const el = stripEl.current
    if (!el) return
    el.scrollBy({ left: dir * Math.floor(el.clientWidth * 0.8), behavior: 'smooth' })
  }

  useEffect(() => {
    updateScrollState()
    const observer = new ResizeObserver(() => updateScrollState())
    if (stripEl.current) observer.observe(stripEl.current)
    return () => observer.disconnect()
  }, [])

  /* 标签数量变化（开/关）影响总宽；overflow 消失时浏览器会把 scrollLeft 归零 */
  useEffect(() => {
    requestAnimationFrame(updateScrollState)
  }, [state.tabs.length])

  /** 激活标签滚入可见区（inline:nearest —— 已可见时不动，不打扰滚动位置） */
  function scrollActiveIntoView(): void {
    stripEl.current?.querySelector('.tab.active')?.scrollIntoView({
      behavior: 'smooth',
      inline: 'nearest',
      block: 'nearest',
    })
  }

  useEffect(() => {
    requestAnimationFrame(scrollActiveIntoView)
  }, [state.activeTabId])

  /* ---------------------------------------------------------------- 右键菜单 */
  const [ctxOpen, setCtxOpen] = useState(false)
  const [ctxTarget, setCtxTarget] = useState<string | null>(null)
  const ctxMenuRef = useRef<HTMLDivElement | null>(null)
  const [ctxPos, setCtxPos] = useState({ top: 0, left: 0 })

  const ctxHasOthers = state.tabs.length > 1
  const ctxHasRight = (() => {
    const id = ctxTarget
    if (!id) return false
    return state.tabs.indexOf(id) < state.tabs.length - 1
  })()

  function openCtxMenu(event: React.MouseEvent, id: string): void {
    event.preventDefault()
    setListOpen(false)
    setCtxTarget(id)
    /*
     * 标签栏在窗口顶部，向下展开空间恒充足；left/right 仍要夹视口 ——
     * 右缘标签的菜单若不夹会溢出右侧。高度按实际尺寸二次落位。
     */
    const pos = {
      top: event.clientY + 4,
      left: Math.max(8, Math.min(event.clientX, window.innerWidth - CTX_MENU_WIDTH - 8)),
    }
    setCtxPos(pos)
    setCtxOpen(true)
    const rect = { top: event.clientY, bottom: event.clientY }
    requestAnimationFrame(() => setCtxPos((p) => placeMenu(ctxMenuRef.current, p, rect)))
  }

  /**
   * 菜单按实际高度落位：
   * 向下放不下则贴锚点顶边向上展开，上下都放不下贴顶交给内部滚动。
   */
  function placeMenu(
    el: HTMLElement | null,
    pos: { top: number; left: number },
    rect: { top: number; bottom: number },
  ): { top: number; left: number } {
    if (!el) return pos
    const height = el.offsetHeight
    let top = rect.bottom + 4
    if (top + height > window.innerHeight - 8) top = rect.top - height - 4
    return { ...pos, top: Math.max(8, Math.min(top, window.innerHeight - height - 8)) }
  }

  function ctxRefresh(): void {
    const id = ctxTarget
    setCtxOpen(false)
    if (id) void activateAndRefresh(id)
  }

  function ctxClose(): void {
    const id = ctxTarget
    setCtxOpen(false)
    if (id) closeTab(id)
  }

  function ctxCloseOthers(): void {
    const id = ctxTarget
    setCtxOpen(false)
    if (id) closeOtherTabs(id)
  }

  function ctxCloseRight(): void {
    const id = ctxTarget
    setCtxOpen(false)
    if (id) closeTabsToRight(id)
  }

  /* ---------------------------------------------------------------- 更多页签下拉 */
  const [listOpen, setListOpen] = useState(false)
  const moreBtnEl = useRef<HTMLButtonElement | null>(null)
  const listMenuRef = useRef<HTMLDivElement | null>(null)
  const [listPos, setListPos] = useState({ top: 0, left: 0 })

  function toggleList(): void {
    if (listOpen) {
      setListOpen(false)
      return
    }
    setCtxOpen(false)
    const rect = moreBtnEl.current?.getBoundingClientRect()
    if (!rect) return
    /* 右缘与锚点对齐，向下展开 */
    const pos = { top: rect.bottom + 4, left: Math.max(8, rect.right - LIST_WIDTH) }
    setListPos(pos)
    setListOpen(true)
    requestAnimationFrame(() =>
      setListPos((p) => placeMenu(listMenuRef.current, p, { top: rect.top, bottom: rect.bottom })),
    )
  }

  function pickTab(id: string | null): void {
    activateTab(id)
    setListOpen(false)
    /*
     * 点"当前已激活"的标签时 activeTabId 不变，effect 不触发 ——
     * 但用户是从下拉里选的，标签本体可能在溢出区外看不见，显式滚入。
     */
    requestAnimationFrame(scrollActiveIntoView)
  }

  return (
    <div className="tabbar s-tab-bar">
      {overflowing ? (
        <button
          className="tabbar-btn"
          disabled={!canLeft}
          {...tipProps(t('common.scrollLeft'))}
          onClick={() => scrollStrip(-1)}
        >
          <DialogIcon name="chevron-left" size={13} />
        </button>
      ) : null}

      <div ref={stripEl} className="tab-strip" onScroll={updateScrollState}>
        <button
          className={`tab tab-home${!state.activeTabId ? ' active' : ''}`}
          {...tipProps(t('tabBar.home'))}
          onClick={() => activateTab(null)}
        >
          <DialogIcon name="home" size={13} />
          <span>{t('tabBar.home')}</span>
        </button>

        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab${state.activeTabId === tab.id ? ' active' : ''}`}
            title={tab.conn ? `${tab.conn.name} · ${tab.conn.host}:${tab.conn.port}` : tab.id}
            onClick={() => activateTab(tab.id)}
            onContextMenu={(event) => openCtxMenu(event, tab.id)}
          >
            {/* 状态点：连接健康度一眼可辨（与侧栏 rail 同语义） */}
            <span className={`tab-dot is-${tab.conn?.status ?? 'disconnected'}`} />
            <span className="tab-name ellipsis">{tab.conn?.name ?? tab.id}</span>
            <span
              className="tab-close"
              {...tipProps(t('tabBar.closeTabDisconnect'))}
              onClick={(event) => {
                event.stopPropagation()
                closeTab(tab.id)
              }}
            >
              <DialogIcon name="cancel" size={12} />
            </span>
          </button>
        ))}
      </div>

      {overflowing ? (
        <button
          className="tabbar-btn"
          disabled={!canRight}
          {...tipProps(t('common.scrollRight'))}
          onClick={() => scrollStrip(1)}
        >
          <DialogIcon name="chevron-right" size={13} />
        </button>
      ) : null}

      {overflowing ? (
        <button ref={moreBtnEl} className="tabbar-btn" {...tipProps(t('tabBar.moreTabs'))} onClick={toggleList}>
          <DialogIcon name="more" size={15} />
        </button>
      ) : null}

      {/* 右键菜单：刷新 / 关闭 / 关闭其他 / 关闭右侧 */}
      {ctxOpen ? (
        <>
          <div
            className="popover-mask"
            onClick={() => setCtxOpen(false)}
            onContextMenu={(event) => {
              event.preventDefault()
              setCtxOpen(false)
            }}
          />
          <div
            ref={ctxMenuRef}
            className="menu tab-ctx-menu"
            style={{ top: `${ctxPos.top}px`, left: `${ctxPos.left}px`, width: `${CTX_MENU_WIDTH}px` }}
          >
            <button className="menu-item" onClick={ctxRefresh}>
              <DialogIcon name="refresh" size={13} className="mi-icon" />
              <span>{t('common.refresh')}</span>
            </button>
            <button className="menu-item" onClick={ctxClose}>
              <DialogIcon name="close" size={13} className="mi-icon" />
              <span>{t('common.close')}</span>
            </button>
            <div className="menu-sep" />
            <button className="menu-item" disabled={!ctxHasOthers} onClick={ctxCloseOthers}>
              <DialogIcon name="close" size={13} className="mi-icon" />
              <span>{t('tabBar.closeOtherTabs')}</span>
            </button>
            <button className="menu-item" disabled={!ctxHasRight} onClick={ctxCloseRight}>
              <DialogIcon name="close" size={13} className="mi-icon" />
              <span>{t('tabBar.closeTabsRight')}</span>
            </button>
          </div>
        </>
      ) : null}

      {/* 更多页签：全集列表，可切换 / 可关闭 */}
      {listOpen ? (
        <>
          <div
            className="popover-mask"
            onClick={() => setListOpen(false)}
            onContextMenu={(event) => {
              event.preventDefault()
              setListOpen(false)
            }}
          />
          <div
            ref={listMenuRef}
            className="menu tab-list"
            style={{ top: `${listPos.top}px`, left: `${listPos.left}px`, width: `${LIST_WIDTH}px` }}
          >
            <button className={`menu-item${!state.activeTabId ? ' active' : ''}`} onClick={() => pickTab(null)}>
              <DialogIcon name="home" size={13} className="mi-icon" />
              <span className="ellipsis">{t('tabBar.home')}</span>
            </button>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={`menu-item${state.activeTabId === tab.id ? ' active' : ''}`}
                onClick={() => pickTab(tab.id)}
              >
                <span className={`tab-dot is-${tab.conn?.status ?? 'disconnected'}`} />
                <span className="tl-name ellipsis">{tab.conn?.name ?? tab.id}</span>
                <span
                  className="tl-close"
                  {...tipProps(t('tabBar.closeTab'))}
                  onClick={(event) => {
                    event.stopPropagation()
                    closeTab(tab.id)
                  }}
                >
                  <DialogIcon name="cancel" size={12} />
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

export default TabBar

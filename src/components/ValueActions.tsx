import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useI18n } from '@/i18n'
import { useRedis } from '@/store/useRedis'
import { copyText } from '@/utils/clipboard'

const MENU_WIDTH = 196

export interface ValueActionsProps {
  onRename: () => void
  onSetTtl: () => void
}

/** 值区右上角「值操作」菜单：重命名键 / 设置 TTL / 复制键名 / 刷新 / 删除键 */
export function ValueActions({ onRename, onSetTtl }: ValueActionsProps) {
  const { t } = useI18n()
  const { state, notify, deleteKeys, refreshSelected } = useRedis()

  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })

  const current = state.selectedValue

  function toggleOpen(event: React.MouseEvent): void {
    event.stopPropagation()
    if (open) {
      setOpen(false)
      return
    }
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect) {
      // 与 ConnectionActions 同一套「先渲染、下一帧按实际高度落位」逻辑
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

  /** 按菜单实际尺寸落位：下方放不下→底边贴锚点顶边向上；窗口矮于菜单→贴顶交给滚动 */
  function place(rect: DOMRect): void {
    const el = menuRef.current
    if (!el) return
    const height = el.offsetHeight
    let top = rect.bottom + 4
    if (top + height > window.innerHeight - 8) top = rect.top - height - 4
    setPosition({
      top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)),
    })
  }

  async function run(action: () => Promise<void> | void): Promise<void> {
    setOpen(false)
    await action()
  }

  async function copyKey(): Promise<void> {
    const key = current?.key
    if (!key) return
    const done = await copyText(key)
    notify(done ? 'ok' : 'err', done ? t('已复制键名') : t('复制失败，请检查剪贴板权限'))
  }

  async function refresh(): Promise<void> {
    await refreshSelected()
    notify('ok', t('已刷新'))
  }

  async function remove(): Promise<void> {
    const key = current?.key
    if (key) await deleteKeys([key])
  }

  return (
    <div ref={anchorRef} className="value-actions s-value-actions">
      <button className="more-btn" {...tipProps(t('值操作'))} onClick={toggleOpen}>
        <DialogIcon name="more" size={15} />
      </button>

      {open
        ? createPortal(
            <>
              <div className="popover-mask" onClick={() => setOpen(false)} />
              <div
                ref={menuRef}
                className="menu"
                style={{ top: `${position.top}px`, left: `${position.left}px`, width: `${MENU_WIDTH}px` }}
              >
                <button className="menu-item" onClick={() => void run(onRename)}>
                  <DialogIcon name="refresh" size={13} className="mi-icon" />
                  <span>{t('重命名键…')}</span>
                </button>

                <button className="menu-item" onClick={() => void run(onSetTtl)}>
                  <DialogIcon name="clock" size={13} className="mi-icon" />
                  <span>{t('设置 TTL…')}</span>
                </button>

                <div className="menu-sep" />

                <button className="menu-item" onClick={() => void run(copyKey)}>
                  <DialogIcon name="copy" size={13} className="mi-icon" />
                  <span>{t('复制键名')}</span>
                </button>

                <button className="menu-item" onClick={() => void run(refresh)}>
                  <DialogIcon name="refresh" size={13} className="mi-icon" />
                  <span>{t('刷新')}</span>
                </button>

                <div className="menu-sep" />

                <button className="menu-item danger" onClick={() => void run(remove)}>
                  <DialogIcon name="cancel" size={13} className="mi-icon" />
                  <span>{t('删除键')}</span>
                </button>
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  )
}

export default ValueActions

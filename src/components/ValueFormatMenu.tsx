import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DialogIcon, type DialogIconName } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useI18n, type MsgKey } from '@/i18n'
import type { ValueFormatId } from '@/utils/valueFormats'

const MENU_WIDTH = 200

const TEXT_ITEMS: Array<{ id: ValueFormatId; key: MsgKey; icon: DialogIconName }> = [
  { id: 'jwt', key: 'valueFormats.jwt', icon: 'key' },
  { id: 'base64', key: 'valueFormats.base64', icon: 'convert' },
  { id: 'php', key: 'valueFormats.php', icon: 'code' },
]

const BINARY_ITEMS: Array<{ id: ValueFormatId; key: MsgKey; icon: DialogIconName }> = [
  { id: 'gzip', key: 'valueFormats.gzip', icon: 'archive' },
  { id: 'zlib', key: 'valueFormats.zlib', icon: 'expand' },
  { id: 'image', key: 'valueFormats.image', icon: 'eye' },
  { id: 'hex', key: 'valueFormats.hex', icon: 'terminal' },
  { id: 'msgpack', key: 'valueFormats.msgpack', icon: 'binary' },
]

export interface ValueFormatMenuProps {
  format: ValueFormatId | null
  disabled?: boolean
  onSelect: (format: ValueFormatId | null) => void
}

/** string 值的格式切换菜单：解码视图由 ValueFormatView 呈现 */
export function ValueFormatMenu({ format, disabled, onSelect }: ValueFormatMenuProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })

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

  function toggle(event: React.MouseEvent): void {
    event.stopPropagation()
    if (open) {
      setOpen(false)
      return
    }
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect) {
      setPosition({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)) })
      setOpen(true)
      requestAnimationFrame(() => place(rect))
    } else {
      setOpen(true)
    }
  }

  function choose(next: ValueFormatId | null): void {
    setOpen(false)
    onSelect(next)
  }

  return (
    <>
      <button
        ref={anchorRef}
        className={`tool${format ? ' on' : ''}`}
        disabled={disabled}
        {...tipProps(t('valueFormats.formatHint'))}
        onClick={toggle}
      >
        <DialogIcon name="sliders" size={12} className="ti" />
        {t('valueFormats.format')}
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
                <button className={`menu-item${format == null ? ' on' : ''}`} onClick={() => choose(null)}>
                  <DialogIcon name="text" size={13} className="mi-icon" />
                  <span>{t('valueFormats.raw')}</span>
                </button>

                <div className="menu-sep" />
                <div className="menu-group">{t('valueFormats.textGroup')}</div>
                {TEXT_ITEMS.map((item) => (
                  <button
                    key={item.id}
                    className={`menu-item${format === item.id ? ' on' : ''}`}
                    onClick={() => choose(item.id)}
                  >
                    <DialogIcon name={item.icon} size={13} className="mi-icon" />
                    <span>{t(item.key)}</span>
                  </button>
                ))}

                <div className="menu-sep" />
                <div className="menu-group">{t('valueFormats.binaryGroup')}</div>
                {BINARY_ITEMS.map((item) => (
                  <button
                    key={item.id}
                    className={`menu-item${format === item.id ? ' on' : ''}`}
                    onClick={() => choose(item.id)}
                  >
                    <DialogIcon name={item.icon} size={13} className="mi-icon" />
                    <span>{t(item.key)}</span>
                  </button>
                ))}
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  )
}

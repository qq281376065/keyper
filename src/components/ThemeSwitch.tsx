import { useEffect, useRef, useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useTheme, SKIN_SCHEME, type SkinId, type ThemeMode } from '@/services/theme'
import { useObservable } from '@/store/subscription'
import { settingsHolder } from '@/services/settings'

const MENU_WIDTH = 168

/**
 * 主题选项。
 * icon 存的是 DialogIcon 的图标名而非字符 ——
 * ◐ ☀ ☾ 这类符号在 Windows 上常被 fallback 到彩色 emoji 字体，
 * 与线条图标混排时风格割裂，且不同字体下大小不一。
 */
type ThemeIcon = 'theme' | 'sun' | 'moon' | SkinId

const BASE_OPTIONS: Array<{ value: ThemeMode; label: string; icon: ThemeIcon }> = [
  { value: 'system', label: '跟随系统', icon: 'theme' },
  { value: 'light', label: '亮色', icon: 'sun' },
  { value: 'dark', label: '暗色', icon: 'moon' },
]

/*
 * 皮肤即主题：配色皮肤与明暗档位并列在同一个菜单里，
 * 中间用分隔线区分「明暗档位」与「配色皮肤」两组。
 * 顺序：暗色系在前（深海/墨林），亮色系在后（暖纸/樱花/薄荷/雾蓝/极光）。
 */
const SKIN_OPTIONS: Array<{ value: SkinId; label: string; icon: ThemeIcon }> = [
  { value: 'ocean', label: '深海', icon: 'ocean' },
  { value: 'forest', label: '墨林', icon: 'forest' },
  { value: 'solarized', label: '暖纸', icon: 'solarized' },
  { value: 'sakura', label: '樱花', icon: 'sakura' },
  { value: 'mint', label: '薄荷', icon: 'mint' },
  { value: 'mist', label: '雾蓝', icon: 'mist' },
  { value: 'aurora', label: '极光', icon: 'aurora' },
]

const ALL_OPTIONS = [...BASE_OPTIONS, ...SKIN_OPTIONS]

export function ThemeSwitch() {
  useObservable(settingsHolder)
  const { mode, resolved, setMode } = useTheme()

  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })

  const currentIcon: ThemeIcon = ALL_OPTIONS.find((item) => item.value === mode)?.icon ?? 'theme'
  const currentLabel = ALL_OPTIONS.find((item) => item.value === mode)?.label ?? '主题'

  /* 菜单底部提示：皮肤报"皮肤名 + 明暗归属"，普通主题只报明暗 */
  const skin = SKIN_OPTIONS.find((item) => item.value === mode)
  const schemeHint = skin
    ? `${skin.label} · ${SKIN_SCHEME[skin.value] === 'dark' ? '暗色系' : '亮色系'}`
    : mode === 'system'
      ? `跟随系统 · ${resolved === 'dark' ? '暗色' : '亮色'}`
      : resolved === 'dark'
        ? '暗色'
        : '亮色'

  function toggle(): void {
    if (open) {
      setOpen(false)
      return
    }
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect) {
      setPosition({
        top: rect.bottom + 6,
        left: Math.max(8, rect.right - MENU_WIDTH),
      })
    }
    setOpen(true)
  }

  function pick(value: ThemeMode): void {
    setMode(value)
    setOpen(false)
  }

  useEffect(() => {
    function onKeydown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeydown)
    return () => window.removeEventListener('keydown', onKeydown)
  }, [])

  return (
    <div ref={anchorRef} className="theme-switch s-theme-switch">
      <button className="trigger" {...tipProps(`主题：${currentLabel}`)} onClick={toggle}>
        <DialogIcon name={currentIcon} size={15} className="icon" />
      </button>

      {open ? (
        <>
          <div className="popover-mask" onClick={() => setOpen(false)} />
          <div
            className="menu"
            style={{ top: `${position.top}px`, left: `${position.left}px`, width: `${MENU_WIDTH}px` }}
          >
            {BASE_OPTIONS.map((option) => (
              <button key={option.value} className="menu-item" onClick={() => pick(option.value)}>
                <DialogIcon name={option.icon} size={13} className="opt-icon" />
                <span>{option.label}</span>
                <span className="shortcut">{mode === option.value ? <DialogIcon name="check" size={12} /> : null}</span>
              </button>
            ))}
            <div className="menu-sep" />
            {SKIN_OPTIONS.map((option) => (
              <button key={option.value} className="menu-item" onClick={() => pick(option.value)}>
                <DialogIcon name={option.icon} size={13} className="opt-icon" />
                <span>{option.label}</span>
                <span className="shortcut">{mode === option.value ? <DialogIcon name="check" size={12} /> : null}</span>
              </button>
            ))}
            <div className="menu-sep" />
            <div className="menu-hint">当前：{schemeHint}</div>
          </div>
        </>
      ) : null}
    </div>
  )
}

export default ThemeSwitch

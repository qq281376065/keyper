import { useEffect, useRef, useState } from 'react'
import { DialogIcon } from '@/components/DialogIcon'
import { tipProps } from '@/components/tip'
import { useI18n, LOCALES, LOCALE_NAMES, type LocaleCode } from '@/i18n'

const MENU_WIDTH = 168

/** 菜单里的语言缩写：字形本身就是语言归属，比三个相同的图标更好扫读 */
const LANG_BADGE: Record<LocaleCode, string> = { 'zh-CN': '简', 'zh-TW': '繁', en: 'EN' }

/**
 * 顶栏语言切换。
 *
 * 复用 ThemeSwitch 的弹出层外观（同一套 .menu / .menu-item / .popover-mask），
 * 因此根节点带上 theme-switch 类；交互（量取锚点、Esc、点遮罩关闭）逐条对齐，
 * 避免同一位置的两个菜单有不同的关闭习惯。
 *
 * 菜单里的语言名一律用本名：英文界面下"繁體中文"仍显示为"繁體中文"，
 * 用户不必先看懂当前语言才能找到自己的语言。
 */
export function LanguageSwitch() {
  const { locale, t, setLocale } = useI18n()
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })

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

  function pick(value: LocaleCode): void {
    void setLocale(value)
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
    <div ref={anchorRef} className="theme-switch s-theme-switch s-lang-switch">
      <button
        className="trigger"
        {...tipProps(t('languageSwitch.language', { name: LOCALE_NAMES[locale] }))}
        onClick={toggle}
      >
        <DialogIcon name="globe" size={15} className="icon" />
      </button>

      {open ? (
        <>
          <div className="popover-mask" onClick={() => setOpen(false)} />
          <div
            className="menu"
            style={{ top: `${position.top}px`, left: `${position.left}px`, width: `${MENU_WIDTH}px` }}
          >
            {LOCALES.map((item) => (
              <button key={item} className="menu-item" onClick={() => pick(item)}>
                <span className="lang-code">{LANG_BADGE[item]}</span>
                <span>{LOCALE_NAMES[item]}</span>
                <span className="shortcut">
                  {locale === item ? <DialogIcon name="check" size={12} /> : null}
                </span>
              </button>
            ))}
            <div className="menu-sep" />
            <div className="menu-hint">{t('languageSwitch.current', { name: LOCALE_NAMES[locale] })}</div>
          </div>
        </>
      ) : null}
    </div>
  )
}

export default LanguageSwitch

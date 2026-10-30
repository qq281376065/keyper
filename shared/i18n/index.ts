/**
 * 多语言核心：语言码、字典查找与插值。
 *
 * 键即中文原文（gettext 风格的 msgid），而不是另起一套语义 key。
 *
 * 为什么这么做：
 *   · 应用从中文界面起步，现有文案已经过长期打磨，换成语义 key 等于
 *     把上千条文案重命名一遍，改错一个就是一处界面文案消失；
 *   · 中文原文本身具备"读代码即懂文案"的可读性，新增文案时不必先想 key 名；
 *   · 漏译会自然回退到中文原文（而不是显示 key 或空白），英文界面下
 *     一眼能看出哪些没翻，便于用脚本扫描收口。
 *
 * 约定：
 *   · 插值用 `{name}`，如 `t('已删除 {count} 个键', { count: 3 })`；
 *   · 中文原文里出现 `{` 字面量的场景不存在，无需转义；
 *   · 三种语言字典必须键集一致（tests/unit/i18n.spec.ts 会校验）。
 *
 * 渲染层与主进程都从这里取翻译：主进程通过 setActiveLocale 跟随设置，
 * 渲染层用 src/i18n 里的 hook（会订阅设置变化并触发重渲染）。
 */
import en from '../../lang/en'
import zhCN from '../../lang/zh-CN'
import zhTW from '../../lang/zh-TW'

export type LocaleCode = 'zh-CN' | 'zh-TW' | 'en'
export type Dict = Record<string, string>
export type TParams = Record<string, string | number>

export const LOCALES: LocaleCode[] = ['zh-CN', 'zh-TW', 'en']
export const DEFAULT_LOCALE: LocaleCode = 'zh-CN'

/** 语言名一律用其本名，菜单里不做互译（英文界面下「日本語」仍是「日本語」） */
export const LOCALE_NAMES: Record<LocaleCode, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
}

/** `<html lang>` 用的 BCP 47 标签 */
export const LOCALE_HTML_LANG: Record<LocaleCode, string> = {
  'zh-CN': 'zh-CN',
  'zh-TW': 'zh-TW',
  en: 'en',
}

export const DICTIONARIES: Record<LocaleCode, Dict> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en,
}

export function isLocale(value: unknown): value is LocaleCode {
  return value === 'zh-CN' || value === 'zh-TW' || value === 'en'
}

/** 容错：设置文件可能是旧版本或被手工改坏 */
export function normalizeLocale(value: unknown): LocaleCode {
  return isLocale(value) ? value : DEFAULT_LOCALE
}

/** 首次启动时按系统语言猜测（仅用于没有历史设置的场景） */
export function detectLocale(language: string | undefined): LocaleCode {
  const tag = (language ?? '').toLowerCase()
  if (tag.startsWith('zh')) {
    return /hant|tw|hk|mo/.test(tag) ? 'zh-TW' : 'zh-CN'
  }
  return tag ? 'en' : DEFAULT_LOCALE
}

let activeLocale: LocaleCode = DEFAULT_LOCALE

export function setActiveLocale(locale: LocaleCode): void {
  activeLocale = locale
}

export function getActiveLocale(): LocaleCode {
  return activeLocale
}

const PLACEHOLDER = /\{(\w+)\}/g

export function translate(locale: LocaleCode, key: string, params?: TParams): string {
  const dict = DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE]
  const text = dict[key] ?? DICTIONARIES[DEFAULT_LOCALE][key] ?? key
  if (!params) return text
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name]
    return value === undefined || value === null ? whole : String(value)
  })
}

/** 主进程 / 非 React 场景：按最近一次同步过来的语言翻译 */
export function t(key: string, params?: TParams): string {
  return translate(activeLocale, key, params)
}

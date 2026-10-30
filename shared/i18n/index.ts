/**
 * 多语言核心：语言码、字典查找与插值。
 *
 * 键是语义化的 `namespace.camelCase`（如 `common.cancel`），英文目录
 * `lang/en.ts` 是唯一事实来源：
 *   · `MsgKey` 由英文目录的键推导，调用 `t()` 时拼错键会直接编译失败；
 *   · 另外两份字典声明为 `Record<MsgKey, string>`，漏译 / 多译同样是编译错误；
 *   · 运行时若出现未经类型检查的动态键，依次回退「当前语言 → 英文 → 键本身」，
 *     不会渲染成空白。
 *
 * 约定：
 *   · 插值用 `{name}`，如 `t('common.selectedCount', { count: 3 })`；
 *   · 文案里出现 `{` 字面量的场景不存在，无需转义；
 *   · 三种语言字典的键集与占位符集合由 `npm run i18n:check` 全量校验。
 *
 * 渲染层与主进程都从这里取翻译：主进程通过 setActiveLocale 跟随设置，
 * 渲染层用 src/i18n 里的 hook（会订阅设置变化并触发重渲染）。
 */
import en, { type MsgKey } from '../../lang/en'
import zhCN from '../../lang/zh-CN'
import zhTW from '../../lang/zh-TW'

export type { MsgKey }

export type LocaleCode = 'zh-CN' | 'zh-TW' | 'en'
export type Dict = Record<MsgKey, string>
export type TParams = Record<string, string | number>
export type TFunction = (key: MsgKey, params?: TParams) => string

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

export function translate(locale: LocaleCode, key: MsgKey, params?: TParams): string {
  const dict = DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE]
  const text = dict[key] ?? en[key] ?? key
  if (!params) return text
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name]
    return value === undefined || value === null ? whole : String(value)
  })
}

/** 主进程 / 非 React 场景：按最近一次同步过来的语言翻译 */
export function t(key: MsgKey, params?: TParams): string {
  return translate(activeLocale, key, params)
}
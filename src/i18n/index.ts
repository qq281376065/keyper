import { useCallback, useSyncExternalStore } from 'react'
import { settings, settingsHolder, saveSettings } from '@/services/settings'
import {
  normalizeLocale,
  translate,
  setActiveLocale,
  type LocaleCode,
  type MsgKey,
  type TParams,
} from '@shared/i18n'

/**
 * 渲染层的翻译入口。
 *
 * 组件里用 `useI18n()`：它订阅设置 store，语言一变，所有调用它的组件
 * 都会重渲染。
 *
 * 事件回调、store action、工具函数里用模块级 `t()`：这些字符串在任何
 * 一次渲染之外生成（toast / 日志 / 错误提示），按当前语言即时翻译即可。
 */
export function t(key: MsgKey, params?: TParams): string {
  return translate(normalizeLocale(settings.locale), key, params)
}

export async function setLocale(locale: LocaleCode): Promise<void> {
  if (normalizeLocale(settings.locale) === locale) return
  setActiveLocale(locale)
  await saveSettings({ locale })
}

function snapshotLocale(): LocaleCode {
  return normalizeLocale(settings.locale)
}

export function useI18n() {
  /*
   * 必须以 locale 字符串本身作为外部快照，不能在组件里直接读
   * `settings.locale`：React Compiler 会把模块级对象的属性读取当成常量
   * 缓存（编译后只求值一次），语言切换后组件即使重渲染也拿到旧值。
   * useSyncExternalStore 的返回值在 React 认知里是可变量，订阅通知后
   * 会重新求值并触发重渲染。
   */
  const locale = useSyncExternalStore(settingsHolder.subscribe, snapshotLocale, snapshotLocale)
  const tr = useCallback(
    (key: MsgKey, params?: TParams) => translate(locale, key, params),
    [locale],
  )
  return { locale, t: tr, setLocale }
}

export { LOCALES, LOCALE_NAMES, type LocaleCode, type MsgKey } from '@shared/i18n'

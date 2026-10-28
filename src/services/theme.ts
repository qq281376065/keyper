import { useSettings } from '@/services/settings'
import { defineStore } from '@/store'

/** 皮肤 id：皮肤即主题，直接作为 data-theme 值的扩展取值 */
export type SkinId = 'ocean' | 'solarized' | 'forest' | 'sakura' | 'mint' | 'mist' | 'aurora'
/** 主题模式：跟随系统 / 明暗 / 七套皮肤（皮肤即主题） */
export type ThemeMode = 'system' | 'light' | 'dark' | SkinId
/** 实际明暗 —— 原生控件（滚动条/输入光标）只认 light|dark，皮肤需归并 */
export type ResolvedTheme = 'light' | 'dark'
/** data-theme 的实际取值：明暗主题或皮肤 id */
export type AppliedTheme = ResolvedTheme | SkinId

/** 皮肤各自归属的明暗档（colorScheme 与「当前：暗色/亮色」提示用） */
export const SKIN_SCHEME: Record<SkinId, ResolvedTheme> = {
  ocean: 'dark',
  solarized: 'light',
  forest: 'dark',
  sakura: 'light',
  mint: 'light',
  mist: 'light',
  aurora: 'light',
}

/**
 * 与 index.html 中的防闪烁内联脚本共用同一个 key。
 *
 * 真正的持久化位置是 settings.json（`theme` 字段）；这里仍往 localStorage
 * 写一份副本，原因只有一个：index.html 的内联脚本在 React 挂载之前就要
 * 决定 `<html data-theme>`，那时还读不到主进程的 settings.json。
 * 两份值由 applyTheme 保持同步。
 */
export const THEME_STORAGE_KEY = 'redisdocter:theme'

const { settings, save } = useSettings()

const media = window.matchMedia('(prefers-color-scheme: dark)')

const systemHolder = defineStore<{ value: ResolvedTheme }>({
  value: media.matches ? 'dark' : 'light',
})

/**
 * 首次升级迁移：把 localStorage 里的旧值搬到 settings。
 *
 * 只在 settings 仍是默认值（system）而 localStorage 有明确偏好时生效，
 * 避免覆盖用户在设置界面里已经选好的值。
 */
export function migrateThemeFromStorage(): void {
  if (settings.theme !== 'system') return
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY)
    if (value === 'light' || value === 'dark') settings.theme = value
  } catch {
    /* 隐私模式等场景下读取失败，按默认处理 */
  }
}

/** 归并后的实际明暗（皮肤按各自色系归档） */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return systemHolder.store.value
  if (mode === 'light' || mode === 'dark') return mode
  return SKIN_SCHEME[mode]
}

/** 落到 data-theme 的值：皮肤原样、system 取系统明暗 */
export function appliedTheme(mode: ThemeMode): AppliedTheme {
  return mode === 'system' ? systemHolder.store.value : mode
}

function apply(theme: AppliedTheme): void {
  const root = document.documentElement
  root.dataset.theme = theme
  // 让原生控件（滚动条、输入框光标、下拉）跟随主题；皮肤归并到自身明暗档
  root.style.colorScheme =
    theme === 'light' || theme === 'dark' ? theme : SKIN_SCHEME[theme]
}

/** 把当前主题落到 DOM，并同步 localStorage 副本（index.html 首屏脚本要读） */
export function applyTheme(): void {
  const mode = settings.theme as ThemeMode
  apply(appliedTheme(mode))
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode)
  } catch {
    /* 写入失败不影响当前会话 */
  }
}

media.addEventListener('change', (event) => {
  systemHolder.store.value = event.matches ? 'dark' : 'light'
  applyTheme()
})

/**
 * 切换主题。
 *
 * 写 settings 而不是 localStorage —— 统一到一个配置文件里，
 * 用户备份或迁移时不用记"主题在浏览器存储、其它在 json"。
 */
export function setThemeMode(next: ThemeMode): void {
  settings.theme = next
  applyTheme()
  void save({ theme: next })
}

export function useTheme() {
  return {
    get mode(): ThemeMode {
      return settings.theme as ThemeMode
    },
    get resolved(): ResolvedTheme {
      return resolveTheme(settings.theme as ThemeMode)
    },
    get applied(): AppliedTheme {
      return appliedTheme(settings.theme as ThemeMode)
    },
    systemHolder,
    setMode: setThemeMode,
  }
}

import { api } from '@/api'
import { defineStore } from '@/store'
import type { AppSettings } from '@shared/types'

/** 界面字体候选 */
export const UI_FONTS: Array<{ value: string; label: string; stack: string }> = [
  {
    value: 'system',
    label: '系统默认',
    stack: '"Segoe UI", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  {
    value: 'yahei',
    label: '微软雅黑',
    stack: '"Microsoft YaHei", "Segoe UI", system-ui, sans-serif',
  },
  {
    value: 'source-han',
    label: '思源黑体',
    stack: '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", sans-serif',
  },
  {
    value: 'pingfang',
    label: '苹方 / 中文黑体',
    stack: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  },
]

/** 代码字体候选 */
export const MONO_FONTS: Array<{ value: string; label: string; stack: string }> = [
  {
    value: 'jetbrains-mono',
    label: 'JetBrains Mono',
    stack: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  },
  {
    value: 'cascadia',
    label: 'Cascadia Code',
    stack: '"Cascadia Code", Consolas, "Courier New", monospace',
  },
  { value: 'consolas', label: 'Consolas', stack: 'Consolas, "Courier New", monospace' },
  { value: 'courier', label: 'Courier New', stack: '"Courier New", Courier, monospace' },
]

export const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 13,
  uiFont: 'system',
  monoFont: 'jetbrains-mono',
  density: 'compact',
  pageSize: 200,
  keySeparator: ':',
  confirmDelete: true,
  logRetentionDays: 30,
  /* 界面状态记忆：与主进程 DEFAULT_SETTINGS 保持一致 */
  theme: 'system',
  viewMode: 'tree',
  cliCollapsed: true,
  sidebarCollapsed: false,
  keyBrowserWidth: 450,
  lastConnectionId: null,
  lastDb: 0,
  expandedPaths: {},
}

/**
 * 设置是模块级单例。
 *
 * 移植说明：Vue 版用 `reactive(settings)` + `watch(deep)` 实时把字号/密度
 * 写到 CSS 变量上；React 版把「写 DOM」收敛到 setter 里显式调用 ——
 * 任何改动设置的路径都经过 save()，不依赖调度时序，反而更可控。
 */
export const settingsHolder = defineStore<AppSettings>({ ...DEFAULT_SETTINGS })

export const settings: AppSettings = settingsHolder.store

/**
 * 把设置落到 DOM。
 * 字号体系：--fs-base 为基准，其余字号由 calc 推导，
 * 因此调整基准字号即可整体缩放文本而不破坏布局。
 */
function applyToDom(): void {
  const root = document.documentElement
  const uiFont = UI_FONTS.find((item) => item.value === settings.uiFont) ?? UI_FONTS[0]!
  const monoFont = MONO_FONTS.find((item) => item.value === settings.monoFont) ?? MONO_FONTS[0]!

  root.style.setProperty('--fs-base', `${settings.fontSize}px`)
  root.style.setProperty('--row-h', settings.density === 'compact' ? '22px' : '28px')
  root.style.setProperty('--font-ui', uiFont.stack)
  root.style.setProperty('--font-mono', monoFont.stack)
}

/** 从主进程加载设置；浏览器预览下由 mock 提供默认值 */
async function load(): Promise<void> {
  const res = await api.settings.get()
  if (res.ok) Object.assign(settings, res.data)
  applyToDom()
}

/** 保存：先本地生效保证交互即时，再用主进程返回值校正 */
async function save(patch: Partial<AppSettings>): Promise<void> {
  Object.assign(settings, patch)
  applyToDom()
  const res = await api.settings.save(patch)
  if (res.ok) {
    Object.assign(settings, res.data)
    applyToDom()
  }
}

/** 修改设置但不落盘（用于输入过程中的即时预览，如字体/字号滑杆） */
function preview(patch: Partial<AppSettings>): void {
  Object.assign(settings, patch)
  applyToDom()
}

export function useSettings() {
  return { settings, load, save, preview, applyToDom }
}

export { applyToDom }

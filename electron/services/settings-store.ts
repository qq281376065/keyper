import fs from 'node:fs'
import path from 'node:path'
import type { AppSettings } from '../../shared/types'
import { configFile } from './config-path'
import {
  detectLocale,
  isLocale,
  normalizeLocale,
  setActiveLocale,
  type LocaleCode,
} from '../../shared/i18n'
import { DEFAULT_PROXY, normalizeProxySettings } from './proxy-rules'

/**
 * 应用设置持久化。
 * 落盘位置：<配置目录>/settings.json
 * 配置目录默认是「程序目录/config」（便携），不可写时回退 userData，见 config-path.ts
 *
 * 默认值与当前界面现状保持一致，避免首次升级后视觉突变。
 */
export const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 13,
  locale: 'zh-CN',
  uiFont: 'system',
  monoFont: 'jetbrains-mono',
  density: 'compact',
  pageSize: 200,
  keySeparator: ':',
  confirmDelete: true,
  logRetentionDays: 30,
  /* 更新通道代理：可选项，默认关闭（直连），保持历史行为 */
  proxy: { ...DEFAULT_PROXY },
  /* 界面状态记忆：首次启动用保守默认，不猜测用户偏好 */
  theme: 'system',
  viewMode: 'tree',
  cliCollapsed: true,
  sidebarCollapsed: false,
  keyBrowserWidth: 420,
  lastConnectionId: null,
  lastDb: 0,
  expandedPaths: {},
}

function settingsFile(): string {
  return configFile('settings.json')
}

/**
 * 当前操作系统的界面语言。
 *
 * 配置文件里没有 locale（1.0.4 及更早版本）时用它初始化 ——
 * 老用户不该因为升级而继续被固定在中文。用户一旦在界面上选过语言，
 * settings.json 里就有明确值，后续启动不再跟随系统。
 */
let systemLocale: LocaleCode | null = null

/*
 * 进程内缓存：settings.json 的唯一写入口是本模块 saveSettings，
 * 读多写少（日志 prune / 语言同步 / IPC settingsGet 都读），
 * 不必每次 existsSync+readFileSync+JSON.parse 全量读盘。
 * 外部手改文件属于罕见场景，重启即生效（与便携模式文档口径一致）。
 */
let cached: AppSettings | null = null

export function setSystemLocale(language: string | undefined): void {
  systemLocale = language ? detectLocale(language) : null
}

export function loadSettings(): AppSettings {
  if (cached) return cached
  const file = settingsFile()
  if (!fs.existsSync(file)) {
    const initial = { ...DEFAULT_SETTINGS }
    if (systemLocale) initial.locale = systemLocale
    cached = initial
    return initial
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<AppSettings>
    const merged = { ...DEFAULT_SETTINGS, ...raw }
    merged.proxy = normalizeProxySettings(raw.proxy)
    merged.locale = isLocale(raw.locale)
      ? raw.locale
      : (systemLocale ?? DEFAULT_SETTINGS.locale)
    cached = merged
    return merged
  } catch (error) {
    console.error('[settings] 读取失败，回退默认值:', error)
    const fallback = { ...DEFAULT_SETTINGS }
    if (systemLocale) fallback.locale = systemLocale
    cached = fallback
    return fallback
  }
}

/** 主进程的翻译取当前语言；启动与每次保存设置时同步一次 */
export function syncMainLocale(): void {
  setActiveLocale(normalizeLocale(loadSettings().locale))
}

/** 合并写入并做范围收敛，避免越界配置落盘 */
export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const merged: AppSettings = { ...loadSettings(), ...patch }

  merged.fontSize = Math.min(Math.max(Math.round(merged.fontSize) || DEFAULT_SETTINGS.fontSize, 10), 20)
  merged.pageSize = Math.min(Math.max(merged.pageSize || DEFAULT_SETTINGS.pageSize, 20), 5000)
  merged.logRetentionDays = Math.min(Math.max(merged.logRetentionDays || 30, 1), 365)
  if (!merged.keySeparator) merged.keySeparator = DEFAULT_SETTINGS.keySeparator
  merged.locale = normalizeLocale(merged.locale)
  /* 代理设置收敛：非法模式/地址回退直连，绝不让更新通道挂在坏配置上 */
  merged.proxy = normalizeProxySettings(merged.proxy)

  const file = settingsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf-8')
  cached = merged
  setActiveLocale(merged.locale)
  return merged
}

/**
 * 连接删除时清理该连接的树展开快照（expandedPaths 按 connId@db 分桶），返回清理桶数。
 * 与 search-history / favorites / cli-history 的按连接清理同一意图：
 * 连接都没了，展开快照只会让 settings.json 无限膨胀。
 */
export function pruneConnectionExpandedPaths(connId: string): number {
  const settings = loadSettings()
  const prefix = `${connId}@`
  const scopes = Object.keys(settings.expandedPaths).filter((key) => key.startsWith(prefix))
  if (!scopes.length) return 0
  const next = { ...settings.expandedPaths }
  for (const scope of scopes) delete next[scope]
  saveSettings({ expandedPaths: next })
  return scopes.length
}
